// Прогон-зонд кейса B (план 5 п.3; не тест, не в бандле):
//   npx tsx doc/.probe_case_b.ts --self            — loopback-проверка п.4a/4b без стенда
//   npx tsx doc/.probe_case_b.ts [--wait=1800]     — боевой прогон на стенде .157
//
// Что фиксирует: (1) пассивный UAS станции принимает SUBSCRIBE event-list
// (200 + Contact + To-tag, ответ СРАЗУ — без движка прогона, п.4a/4c);
// (2) event-list NOTIFY с триггером res.md B (value len 137 при лимите 32,
// name len 33) уходит строго в диалог принятой подписки: R-URI/адресат =
// Contact из SUBSCRIBE, теги — зеркало диалога, CSeq монотонен (п.4b).
// --self прогоняет цепочку на себе (SUBSCRIBE→200→NOTIFY на наш Contact→200);
// боевой режим поднимает станцию на :5060 и ждёт SAМУ SSW-подписку станции
// (trunk SSW_SRVM, дамп №1 — trunk 02/.133, дамп №2 — trunk 34/.157), а по её
// появлении шлёт ОДИН NOTIFY в её Contact и печатает код ответа:
//   200  → обработчик ss_on_rx_notify зарегистрирован — снимать свежий дамп
//          и ждать `ss_on_rx_notify … bad property` (критерий п.5);
//   500  → «Unknown method: NOTIFY» — подписка к моменту NOTIFY уже мертва
//          (таймеры pjsip) или у станции нет SSW-подписки на этом диалоге;
//   нет  → пакет не дошёл/не распознан.
// Стендовый риск (дамп №2): каждый 500 на NOTIFY = fail2ban BAN suggest на
// .159:5060 — до серии экспериментов бан на .157 обязан быть снят/ослаблен.
// related: server/station/station.ts (пассивный UAS п.4a),
// server/los_mem/scenarios.ts (StationSubscriptions, п.4b),
// server/los_mem/bodies.ts (побайтовый триггер 137/33), doc/plan_5.md п.3,
// doc/task_27_plan_2.md, doc/los_mem/res.md (кейс B).

import { load_config_from_env } from '../server/config';
import {
    SSINFO_CONTENT_TYPE,
    simple_list_body,
} from '../server/los_mem/bodies';
import {
    build_sip_request,
    build_sip_response,
    parse_sip_response,
    RawSipClient,
    uri_host_port,
} from '../server/los_mem/raw_sip';
import { StationSubscriptions } from '../server/los_mem/scenarios';
import type { StationSubSource } from '../server/los_mem/scenarios';
import { SipStation } from '../server/station/station';

/** Триггер кейса B: одно свойство value=137/name=33 (побайтовая копия res.md). */
const TRIGGER_BODY = simple_list_body({
    properties: 1,
    value_len: 137,
    name_len: 33,
});

/** Адаптер SipStation → StationSubSource (имена методов различаются). */
function sub_source(station: SipStation): StationSubSource
{
    return {
        list: () => station.subscriptions(),
        take_cseq: (call_id: string) => station.take_notify_cseq(call_id),
    };
}

function arg(name: string, dflt: string): string
{
    return new RegExp(`--${name}=(\\S+)`).exec(process.argv.join(' '))?.[1] ?? dflt;
}

// ---------- --self: цепочка на себе (без АТС) ----------

async function probe_self(): Promise<void>
{
    const config = load_config_from_env();
    // порт 0 — эфемерный: не спорим с рабочей станцией сервера (:5060).
    const cfg = { ...config, station_port: 0 };
    const station = new SipStation(cfg);
    await station.start();
    const port = station.status().port;
    const sub = config.subscribers.find((s) => s.can_register) ?? config.subscribers[0];
    const client = new RawSipClient({
        host: cfg.station_host,
        port,
        proto: 'udp',
    });
    await client.connect();
    const ep = `${cfg.station_host}:${client.local_port()}`;
    // входящий NOTIFY от станции-к-себе — печатаем и отвечаем 200 (мы notifier
    // по зеркалу: станция в этом диалоге — подписчик).
    client.on_message((raw, from) =>
    {
        if (!/^NOTIFY\s/i.test(raw)) return;
        const hdr = (re: RegExp): string => re.exec(raw)?.[1]?.trim() ?? '—';
        console.log(
            `  RX NOTIFY: ${hdr(/^cseq\s*:\s*(.*)$/im)} ` +
                `from-tag=${/;tag=([^;>\s]+)/i.exec(hdr(/^from\s*:(.*)$/im))?.[1] ?? '—'} ` +
                `to-tag=${/;tag=([^;>\s]+)/i.exec(hdr(/^to\s*:(.*)$/im))?.[1] ?? '—'} ` +
                `event=${hdr(/^event\s*:\s*([^;\r\n]+)/im)} ` +
                `body=${raw.length - (raw.indexOf('\r\n\r\n') + 4)}B ` +
                `(триггер ${Buffer.byteLength(TRIGGER_BODY, 'utf8')}B: ` +
                `${raw.includes(TRIGGER_BODY) ? 'на месте' : 'НЕ тот'})`,
        );
        void client.send(
            build_sip_response(200, 'OK', raw, [], 'probe'),
            from.host,
            from.port,
        );
    });

    const call_id = `caseb-self-${Date.now()}`;
    const wait = client.wait_response(call_id, 5000);
    await client.send(
        build_sip_request('SUBSCRIBE', {
            ruri: `sip:${sub.number}@${cfg.station_host}:${port}`,
            from_uri: `sip:${sub.number}@${ep}`,
            to_uri: `sip:${sub.number}@${cfg.station_host}:${port}`,
            call_id,
            cseq: 1,
            from_tag: 'casebself',
            contact: `sip:${sub.number}@${ep}`,
            via_host: cfg.station_host,
            extra_headers: ['Event: event-list', 'Expires: 120'],
            user_agent: 'caseb-probe/1.0',
        }),
    );
    const raw200 = await wait;
    const resp = raw200 ? parse_sip_response(raw200) : null;
    const c_hdr = /contact\s*:\s*<?([^>\r\n]+)>?/i.exec(raw200 ?? '')?.[1] ?? '—';
    console.log(
        `SUBSCRIBE event-list → ${resp?.status ?? 'нет ответа'}` +
            ` (To-tag ${resp?.to_tag ?? '—'}, Contact станции ${c_hdr})`,
    );
    const subs = station.subscriptions();
    console.log(
        `subscriptions(): ${subs.length}, ` +
            (subs[0]
                ? `remote=${subs[0].remote.host}:${subs[0].remote.port} ` +
                  `tags=${subs[0].our_tag}/${subs[0].peer_tag}`
                : '— диалога нет (п.4a не работает?)'),
    );
    // NOTIFY в принятый диалог — тем же кодом, что t2/t8 (адресат = Contact).
    const stn = new StationSubscriptions(client, cfg.station_host, sub, sub_source(station));
    for (const n of [1, 2])
    {
        const msg = stn.next_notify(TRIGGER_BODY, SSINFO_CONTENT_TYPE);
        if (!msg)
        {
            console.log(`NOTIFY #${n}: диалог пропал — нечего слать`);
            break;
        }
        const ruri = /^NOTIFY\s+(\S+)\s+SIP\/2\.0/i.exec(msg)?.[1] ?? '';
        const dst = uri_host_port(ruri, port) ?? { host: cfg.station_host, port };
        await client.send(msg, dst.host, dst.port);
        console.log(`NOTIFY #${n} → R-URI ${ruri} (dst ${dst.host}:${dst.port})`);
        await new Promise((r) => setTimeout(r, 300));
    }
    // снятие подписки expires=0 (в диалоге) → учёт станции обязан опустеть.
    await client.send(
        build_sip_request('SUBSCRIBE', {
            ruri: `sip:${sub.number}@${cfg.station_host}:${port}`,
            from_uri: `sip:${sub.number}@${ep}`,
            to_uri: `sip:${sub.number}@${cfg.station_host}:${port}`,
            call_id,
            cseq: 2,
            from_tag: 'casebself',
            to_tag: resp?.to_tag,
            contact: `sip:${sub.number}@${ep}`,
            via_host: cfg.station_host,
            extra_headers: ['Event: event-list', 'Expires: 0'],
            user_agent: 'caseb-probe/1.0',
        }),
    );
    await new Promise((r) => setTimeout(r, 300));
    console.log(`после expires=0 subscriptions(): ${station.subscriptions_count()}`);
    client.close();
    await station.stop();
}

// ---------- боевой режим: ждём SSW-подписку станции ----------

async function probe_bench(): Promise<void>
{
    const config = load_config_from_env();
    const station = new SipStation(config);
    try
    {
        await station.start();
    }
    catch (e: unknown)
    {
        console.error(
            `станцию не поднять (${e instanceof Error ? e.message : e}) — ` +
                'если :5060 занят сервером (npm start), остановите станцию',
        );
        process.exit(1);
    }
    const host = config.station_host;
    const port = station.status().port;
    console.log(
        `станция поднята на ${host}:${port}; ждём SSW-подписку станции ` +
            `(.157) до ${arg('wait', '1800')} с — при необходимости перезапустите ` +
            'trunk на АТС (SUBSCRIBE приходит при старте/refresh trunk)',
    );
    console.log(
        `риск: каждый 500 на NOTIFY даёт fail2ban BAN suggest на ` +
            `${config.bridge_host}:5060 — бан на .157 обязан быть снят`,
    );
    // клиент поверх сокета станции: ответы пира приходят на :5060 — хук
    // раздаёт их только нам (ответы), SUBSCRIBE отвечает сама станция (п.4a).
    const client = new RawSipClient({
        host: config.pbx_host,
        port: config.pbx_port,
        proto: 'udp',
        udp_socket: station.udp_socket(),
    });
    await client.connect();
    const off_hook = station.add_incoming_hook((raw, proto, peer) =>
    {
        if (proto !== 'udp' || !/^SIP\/2\.0\s/i.test(raw)) return false;
        client.feed(raw, peer);
        return true;
    });
    const sub = config.subscribers.find((s) => s.can_register) ?? config.subscribers[0];
    const stn = new StationSubscriptions(client, host, sub, sub_source(station));
    const deadline = Date.now() + Number(arg('wait', '1800')) * 1000;
    let fired = 0;
    const seen = new Set<string>();
    while (Date.now() < deadline && fired < 3)
    {
        for (const s of station.subscriptions())
        {
            if (seen.has(s.call_id)) continue;
            seen.add(s.call_id);
            console.log(
                `+[${s.event}] sub cid=${s.call_id.slice(0, 24)}… ` +
                    `remote=${s.remote.host}:${s.remote.port} tags=` +
                    `${s.peer_tag}→${s.our_tag}`,
            );
            if (s.event.toLowerCase() !== 'event-list') continue;
            const msg = stn.next_notify(TRIGGER_BODY, SSINFO_CONTENT_TYPE);
            if (!msg) continue;
            const ruri = /^NOTIFY\s+(\S+)\s+SIP\/2\.0/i.exec(msg)?.[1] ?? '';
            const dst = uri_host_port(ruri, config.pbx_port);
            if (!dst)
            {
                console.log(`  R-URI «${ruri}» неразбираем — пропускаем`);
                continue;
            }
            const wait = client.wait_response(s.call_id, 5000);
            await client.send(msg, dst.host, dst.port);
            console.log(`  NOTIFY в её диалог → ${dst.host}:${dst.port} (cid ${s.call_id.slice(0, 24)}…)`);
            const raw = await wait;
            const resp = raw ? parse_sip_response(raw) : null;
            console.log(
                `  ответ станции: ${resp?.status ?? 'нет ответа (5 с)'}` +
                    (resp?.status === 200
                        ? ' → обработчик жив; снимайте свежий дамп и ждите ' +
                          '`ss_on_rx_notify … bad property`'
                        : ''),
            );
            fired += 1;
        }
        await new Promise((r) => setTimeout(r, 1000));
    }
    if (fired === 0)
    {
        console.log(
            'за ожидание принятых event-list подписок станции нет — кейс B ' +
                'требует SSW на номера trunk-а генератора в конфиге АТС ' +
                '(внешний блокер, план 5 «Объём») либо бан/фильтр на .157',
        );
    }
    off_hook();
    client.close();
    await station.stop();
}

const self_mode = process.argv.includes('--self');
(self_mode ? probe_self() : probe_bench()).catch((e: unknown) =>
{
    console.error('ошибка: ' + (e instanceof Error ? e.message : String(e)));
    process.exit(1);
});
