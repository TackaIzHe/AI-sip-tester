// Юнит-тесты SipStation (server/station/station.ts, plan_4.md п.6, план 5
// п.4a/4d) — без внешней сети: слушатель на loopback с портом 0, запросы
// сырым UDP/TCP. Проверяемое поведение станции-эмулятора: OPTIONS → 200 с
// Allow/Allow-Events и To-tag (копия Via/CSeq — контракт build_sip_response),
// прочие методы → 405 Allow: OPTIONS, мусор → игнор с счётчиком, TCP-фрейминг
// (два сообщения в одном чанке), идемпотентность start/stop; хук входящих
// (стимулы doc/task_26: сообщение съедается без 405, OPTIONS-мимикрия живёт),
// отдача udp_socket() внешнему RawSipClient и пассивный UAS подписок
// (SUBSCRIBE event-list → 200 с Contact/To-tag/Event/Expires, запись диалога,
// стабильный тег на refresh, снятие expires=0, протухание, монотонный CSeq),
// SAS-режим (план 6) и режим «не отвечать на вызовы (INVITE)» (doc/task_29:
// INVITE без ответа, журнал code 0, прочие методы не затронуты); флаги
// перенаправления (task_32), игнора Trying/Ringing (task_36) и умножения
// перенаправляемого INVITE ×10 (doc/task_37) — без движка это только
// настройка статуса, мимикрия отвечает как раньше.
// Запуск: npm run test:unit.
// related: server/station/station.ts, server/los_mem/raw_sip.ts (клиент и
// сборщик запроса), tests/unit/los_mem_raw.test.ts (образец синтетики),
// doc/plan_5.md п.4a.

import dgram from 'node:dgram';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../server/config';
import {
    build_sip_request,
    parse_sip_response,
    RawSipClient,
} from '../../server/los_mem/raw_sip';
import { SipStation, type Station } from '../../server/station/station';

function station_config(proto: 'udp' | 'tcp' | 'both'): AppConfig
{
    return {
        server_port: 3000,
        pbx_host: '127.0.0.1',
        pbx_port: 5060,
        sip_protocol: 'udp',
        bridge_host: '127.0.0.1',
        bridge_port: 8090,
        subscribers: [
            { number: '9404', password: '123', can_register: true },
            { number: '52', password: '321', can_register: true },
            { number: '3203', password: '123', can_register: false },
        ],
        // Порт 0 — эфемерный: тесты не воюют за 5060 и не требуют root.
        station_host: '127.0.0.1',
        station_port: 0,
        station_proto: proto,
    };
}

/** Запрос-образец (keep-alive пира — OPTIONS без тела, как в трассах). */
function request(method: string, cseq = 1): string
{
    return build_sip_request(method, {
        ruri: 'sip:127.0.0.1:5060',
        from_uri: 'sip:peer@127.0.0.1',
        to_uri: 'sip:127.0.0.1:5060',
        call_id: `station-test-${method.toLowerCase()}`,
        cseq,
        from_tag: 'peer-tag',
        via_host: '127.0.0.1',
    });
}

const opened: Station[] = [];

afterEach(async () =>
{
    for (const st of opened.splice(0)) await st.stop();
});

async function started_station(proto: 'udp' | 'tcp' | 'both'): Promise<SipStation>
{
    const st = new SipStation(station_config(proto));
    opened.push(st);
    await st.start();
    return st;
}

/** Один UDP-обмен: отправить, дождаться ответа (undefined — таймаут). */
async function udp_request(
    port: number,
    msg: string,
    wait_ms = 1500,
): Promise<string | undefined>
{
    const sock = dgram.createSocket('udp4');
    const got = new Promise<string | undefined>((resolve) =>
    {
        const timer = setTimeout(() => resolve(undefined), wait_ms);
        sock.once('message', (m: Buffer) =>
        {
            clearTimeout(timer);
            resolve(m.toString('utf8'));
        });
    });
    await new Promise<void>((resolve, reject) =>
        sock.send(Buffer.from(msg, 'utf8'), port, '127.0.0.1', (e) =>
            e ? reject(e) : resolve(),
        ),
    );
    const resp = await got;
    sock.close();
    return resp;
}

/** TCP: записать байты, собирать ответы wait_ms (разделитель — статус-строка). */
async function tcp_roundtrip(
    port: number,
    bytes: string,
    wait_ms = 1500,
): Promise<string>
{
    const sock = net.connect(port, '127.0.0.1');
    const collected = new Promise<string>((resolve) =>
    {
        let acc = '';
        const timer = setTimeout(() =>
        {
            sock.destroy();
            resolve(acc);
        }, wait_ms);
        sock.on('data', (chunk: Buffer) =>
        {
            acc += chunk.toString('utf8');
        });
        sock.once('error', () =>
        {
            clearTimeout(timer);
            resolve(acc);
        });
    });
    await new Promise<void>((resolve, reject) =>
        sock.write(bytes, 'utf8', (e) => (e ? reject(e) : resolve())),
    );
    return collected;
}

describe('SipStation: UDP (keep-alive)', () =>
{
    it('OPTIONS → 200 с Allow/Allow-Events/User-Agent и To-tag станции', async () =>
    {
        const st = await started_station('udp');
        const resp = await udp_request(st.status().port, request('OPTIONS'));
        expect(resp).toBeTruthy();
        const head = parse_sip_response(resp ?? '');
        expect(head?.status).toBe(200);
        expect(head?.to_tag).toBe('station');
        // Значения — дословно из дампов pa_sip (plan_4.md «Context»).
        expect(resp).toContain(
            'Allow: INVITE, ACK, BYE, CANCEL, PRACK, REGISTER, INFO, REFER, ' +
                'NOTIFY, OPTIONS, SUBSCRIBE, MESSAGE, UPDATE, PUBLISH',
        );
        expect(resp).toContain(
            'Allow-Events: presence, dialog, conference, as-feature-event, keep-alive',
        );
        expect(resp).toContain('User-Agent: Eltex ECSS-10 SIP 3.14.15.27.4');
        // Копия запроса для ответа (RFC 3261 §8.2.6): Via и CSeq как в запросе.
        expect(resp).toContain('branch=z9hG4bK-los-');
        expect(resp).toContain('CSeq: 1 OPTIONS');
        expect(resp).toContain('Content-Length: 0');
    });

    it('REGISTER и прочие методы → 405 Allow: OPTIONS', async () =>
    {
        const st = await started_station('udp');
        const resp = await udp_request(st.status().port, request('REGISTER'));
        expect(parse_sip_response(resp ?? '')?.status).toBe(405);
        expect(resp).toContain('Allow: OPTIONS');
        expect(st.status().counters.requests_in.REGISTER).toBe(1);
        expect(st.status().counters.answered['405']).toBe(1);
    });

    it('мусор не-SIP — игнор без ответа и со счётчиком + строкой журнала', async () =>
    {
        const st = await started_station('udp');
        const resp = await udp_request(st.status().port, 'ЭТО НЕ SIP \x00 ???', 700);
        expect(resp).toBeUndefined();
        expect(st.status().counters.ignored).toBe(1);
        const ev = st.events(1)[0];
        expect(ev.method).toBe('?');
        expect(ev.code).toBe(0);
    });

    it('журнал newest first, last_keepalive_at — по OPTIONS', async () =>
    {
        const st = await started_station('udp');
        await udp_request(st.status().port, request('OPTIONS'));
        await udp_request(st.status().port, request('REGISTER'));
        const evs = st.events();
        expect(evs[0].method).toBe('REGISTER'); // newest first
        expect(evs[1].method).toBe('OPTIONS');
        expect(evs[1].code).toBe(200);
        expect(evs[0].cseq).toBe('1 REGISTER');
        expect(st.status().last_keepalive_at).not.toBe('');
        // 2 пира: каждый udp_request со своего эфемерного src-порта (peer —
        // host:port, не host).
        expect(st.status().counters.peers.length).toBe(2);
    });
});

describe('SipStation: TCP и жизненный цикл', () =>
{
    it('TCP: два сообщения в одном чанке — два ответа (фрейминг по CL)', async () =>
    {
        const st = await started_station('tcp');
        const acc = await tcp_roundtrip(
            st.status().port,
            request('OPTIONS') + request('BYE', 2),
        );
        const first = parse_sip_response(acc);
        expect(first?.status).toBe(200);
        expect(first?.cseq_method).toBe('OPTIONS');
        // Границы ответов — только статус-строка с начала строки: подстрока
        // 'SIP/2.0' встречается и в Via (SIP/2.0/UDP), indexOf по ней мухлевал бы.
        const starts = [...acc.matchAll(/^SIP\/2\.0 \d{3} /gm)].map((m) => m.index);
        expect(starts).toHaveLength(2);
        const second = acc.slice(starts[1]);
        expect(parse_sip_response(second)?.status).toBe(405);
        expect(second).toContain('CSeq: 2 BYE');
    });

    it('both: UDP и TCP слушают один порт', async () =>
    {
        const st = await started_station('both');
        const port = st.status().port;
        const udp_resp = await udp_request(port, request('OPTIONS'));
        expect(parse_sip_response(udp_resp ?? '')?.status).toBe(200);
        const tcp_resp = await tcp_roundtrip(port, request('OPTIONS'));
        expect(parse_sip_response(tcp_resp)?.status).toBe(200);
    });

    it('start/stop идемпотентны; stop отпускает порт (повторный bind удался)', async () =>
    {
        const st = await started_station('udp');
        const port = st.status().port;
        await st.start(); // повтор — no-op, не бросает и не поднимает второй сокет
        expect(st.status().state).toBe('running');
        expect(st.status().port).toBe(port);
        await st.stop();
        await st.stop(); // повтор — no-op
        expect(st.status().state).toBe('stopped');
        expect(st.status().uptime_s).toBe(0);
        // Порт освобождён: второй экземпляр bind-ится на тот же номер.
        const again = new SipStation({
            ...station_config('udp'),
            station_port: port,
        });
        await again.start();
        expect(again.status().port).toBe(port);
        await again.stop();
    });

    it('OPTIONS после stop не отвечают (слушателей нет)', async () =>
    {
        const st = await started_station('udp');
        const port = st.status().port;
        await st.stop();
        const resp = await udp_request(port, request('OPTIONS'), 700);
        expect(resp).toBeUndefined();
    });
});

describe('хук входящих и отдача сокета (стимулы утечки, doc/task_26)', () =>
{
    it('SUBSCRIBE съедается хуком без 405; OPTIONS отвечает станция (200)', async () =>
    {
        const st = new SipStation(station_config('udp'));
        opened.push(st);
        await st.start();
        const port = st.status().port;
        const off = st.add_incoming_hook((raw) => /^SUBSCRIBE\s/i.test(raw));
        // без 405: хук вернул true — станция молчит, отвечает делегат (его тут нет)
        const sub = await udp_request(port, request('SUBSCRIBE'), 700);
        expect(sub).toBeUndefined();
        // съеденное сообщение видно в журнале (код 0 — ответил делегат)
        const ev = st.events(1)[0];
        expect(ev.method).toBe('SUBSCRIBE');
        expect(ev.code).toBe(0);
        // мимикрия не тронута: OPTIONS по-прежнему 200 с pa_sip-заголовками
        const opt = await udp_request(port, request('OPTIONS'));
        const head = opt ? parse_sip_response(opt) : null;
        expect(head?.status).toBe(200);
        expect(opt ?? '').toContain('Allow-Events:');
        off();
        // после снятия хука SUBSCRIBE снова честно получает 405
        const back = await udp_request(port, request('SUBSCRIBE'), 900);
        expect(back ?? '').toContain('405');
    });

    it('хук не глушит мусор: игнор-счётчик работает как раньше', async () =>
    {
        const st = new SipStation(station_config('udp'));
        opened.push(st);
        await st.start();
        const off = st.add_incoming_hook(() => false);
        const resp = await udp_request(st.status().port, 'не SIP мусор', 700);
        expect(resp).toBeUndefined();
        expect(st.status().counters.ignored).toBe(1);
        off();
    });

    it('мультикаст хуков (task_31): оба движка видят сообщение, «съедено» — хоть одним', async () =>
    {
        const st = new SipStation(station_config('udp'));
        opened.push(st);
        await st.start();
        const port = st.status().port;
        const seen: string[] = [];
        // хуки по образцу связки SAS+вызов: каждый берёт своё, чужое
        // пропускает; второй берёт то, что пропустил первый.
        const off_a = st.add_incoming_hook((raw) =>
        {
            seen.push('a:' + (/^SIP\/2\.0/i.test(raw) ? 'resp' : 'req'));
            return /^NOTIFY\s/i.test(raw);
        });
        const off_b = st.add_incoming_hook((raw) =>
        {
            seen.push('b:' + (/^SIP\/2\.0/i.test(raw) ? 'resp' : 'req'));
            return /^SIP\/2\.0/i.test(raw);
        });
        const opt = await udp_request(port, request('OPTIONS'));
        expect(opt ?? '').toContain('200');
        expect(seen).toEqual(['a:req', 'b:req']); // оба видели, никто не взял
        seen.length = 0;
        // чистый SIP-ответ (не запрос): забирает хук b, в журнале — код 0
        const resp_msg =
            'SIP/2.0 200 OK\r\nVia: SIP/2.0/UDP 127.0.0.1;rport;' +
            'branch=z9hG4bK-x\r\nFrom: <sip:1@h>\r\nTo: <sip:2@h>\r\n' +
            'Call-ID: mc-1\r\nCSeq: 1 OPTIONS\r\nContent-Length: 0\r\n\r\n';
        const got = await udp_request(port, resp_msg, 700);
        expect(got).toBeUndefined(); // съедено, мимикрия молчит
        expect(seen).toEqual(['a:resp', 'b:resp']); // мультикаст, не first-wins
        expect(st.events(1)[0]?.code).toBe(0); // событие ЖУРНАЛА одно на сообщение
        off_b(); // частичная отписка: a остаётся
        seen.length = 0;
        await udp_request(port, request('OPTIONS'));
        expect(seen).toEqual(['a:req']);
        off_a();
    });

    it('udp_socket() — внешний клиент слушает порт станции (стимул от :5060)', async () =>
    {
        const st = new SipStation(station_config('udp'));
        opened.push(st);
        await st.start();
        const sock = st.udp_socket();
        if (!sock) throw new Error('станция не отдала UDP-сокет');
        const client = new RawSipClient({
            host: '127.0.0.1',
            port: 5060,
            udp_socket: sock,
        });
        await client.connect();
        // Contact стимула обязан нести порт станции — иначе keep-alive пира
        // уходит на эфемерный порт (грабль doc/task_25_plan_2.md)
        expect(client.local_port()).toBe(st.status().port);
        client.close();
        // close() клиента не убил станционный сокет: OPTIONS по-прежнему 200
        const opt = await udp_request(st.status().port, request('OPTIONS'));
        expect(opt ?? '').toContain('200');
    });
});

// SUBSCRIBE вида станции (SSW_SRVM/BLF): Contact подписчика — сигнал-IP
// транка (.157 в дампе №2), R-URI — наш trunk-адрес u00sXXpXX.
describe('SipStation: пассивный UAS подписок (план 5 п.4a/4c)', () =>
{
    function subscribe_msg(
        port: number,
        event: string,
        expires: number,
        cseq = 1,
        call_id = 'caseb-sub-1',
    ): string
    {
        return build_sip_request('SUBSCRIBE', {
            ruri: `sip:u00s34p00@127.0.0.1:${port}`,
            from_uri: 'sip:u00s34p00@192.168.80.157:5060',
            to_uri: 'sip:u00s34p00@127.0.0.1',
            call_id,
            cseq,
            from_tag: 'trunk-tag',
            contact: 'sip:u00s34p00@192.168.80.157:5060',
            via_host: '192.168.80.157',
            extra_headers: [`Event: ${event}`, `Expires: ${expires}`],
        });
    }

    it('SUBSCRIBE event-list → 200 Contact/To-tag/Event/Expires + запись диалога', async () =>
    {
        const st = await started_station('udp');
        const port = st.status().port;
        const resp = await udp_request(port, subscribe_msg(port, 'event-list', 600));
        const head = parse_sip_response(resp ?? '');
        expect(head?.status).toBe(200);
        // To-тег диалога — наш (пассивный UAS), а не общий «station».
        expect(head?.to_tag).toBe('stasub-1');
        expect(resp).toContain('Event: event-list');
        expect(resp).toContain('Expires: 600');
        expect(resp).toContain(`Contact: <sip:u00s34p00@127.0.0.1:${port}>`);
        const subs = st.subscriptions();
        expect(subs).toHaveLength(1);
        const s = subs[0];
        expect(s.event).toBe('event-list');
        expect(s.peer_tag).toBe('trunk-tag');
        expect(s.our_tag).toBe('stasub-1');
        // From/To наших NOTIFY — зеркало подписки; адресат — Contact запроса
        // (п.4b: NOTIY в .157:5060 из SUBSCRIBE, НЕ на src эфемерный).
        expect(s.from_uri).toBe('sip:u00s34p00@127.0.0.1');
        expect(s.to_uri).toBe('sip:u00s34p00@192.168.80.157:5060');
        expect(s.remote).toEqual({ host: '192.168.80.157', port: 5060 });
        expect(st.subscriptions_count()).toBe(1);
        expect(st.status().counters.answered['200']).toBe(1);
    });

    it('refresh сохраняет To-тег; expires=0 снимает диалог (200 Expires: 0)', async () =>
    {
        const st = await started_station('udp');
        const port = st.status().port;
        await udp_request(port, subscribe_msg(port, 'event-list', 600));
        const refresh = await udp_request(
            port,
            subscribe_msg(port, 'event-list', 600, 2),
        );
        expect(parse_sip_response(refresh ?? '')?.to_tag).toBe('stasub-1');
        expect(st.subscriptions_count()).toBe(1);
        const off = await udp_request(port, subscribe_msg(port, 'event-list', 0, 3));
        expect(off).toContain('200');
        expect(off).toContain('Expires: 0');
        expect(st.subscriptions_count()).toBe(0);
    });

    it('неизвестный Event → 405 (мимикрия не обещает неподдерживаемое)', async () =>
    {
        const st = await started_station('udp');
        const port = st.status().port;
        const resp = await udp_request(
            port,
            subscribe_msg(port, 'as-feature-event', 600),
        );
        expect(parse_sip_response(resp ?? '')?.status).toBe(405);
        expect(st.subscriptions_count()).toBe(0);
    });

    it('take_notify_cseq монотонен и undefined для мёртвого; протухание Expires', async () =>
    {
        const st = await started_station('udp');
        const port = st.status().port;
        await udp_request(port, subscribe_msg(port, 'event-list', 600));
        expect(st.take_notify_cseq('caseb-sub-1')).toBe(1);
        expect(st.take_notify_cseq('caseb-sub-1')).toBe(2);
        expect(st.take_notify_cseq('нет-такого')).toBeUndefined();
        await udp_request(port, subscribe_msg(port, 'dialog-info', 1, 2, 'caseb-sub-2'));
        expect(st.subscriptions_count()).toBe(2);
        // Expires=1: через паузу prune при обращении — диалога нет (иначе
        // генератор слал бы NOTIFY в мёртвый диалог, п.4c про таймеры).
        await new Promise((r) => setTimeout(r, 1100));
        expect(st.subscriptions_count()).toBe(1);
        expect(st.take_notify_cseq('caseb-sub-2')).toBeUndefined();
    });

    it('SUBSCRIBE без Event — как раньше 405 (UAS принимает только пакеты)', async () =>
    {
        const st = await started_station('udp');
        const resp = await udp_request(st.status().port, request('SUBSCRIBE'), 900);
        expect(parse_sip_response(resp ?? '')?.status).toBe(405);
    });
});

// SAS-режим (план 6 п.1): роль SAS/SSW-сервера. Запросы — образца 11.log:
// port-register REGISTER (Contact телефона с параметром) и SUBSCRIBE SSW-
// пакета с неизвестным именем Event.
describe('SipStation: SAS-режим (план 6 п.1)', () =>
{
    /** REGISTER вида port-register станции (11.log): Contact с extensions. */
    function port_register_msg(port: number): string
    {
        return build_sip_request('REGISTER', {
            ruri: `sip:u00s00p00@127.0.0.1:${port}`,
            from_uri: 'sip:u00s00p00@192.168.80.157:5060',
            to_uri: 'sip:u00s00p00@192.168.80.157:5060',
            call_id: 'sas-reg-1',
            cseq: 22541,
            from_tag: 'reg-tag',
            contact: 'sip:u00s00p00@192.168.80.133:5060;extensions="answermode"',
            via_host: '192.168.80.157',
            extra_headers: ['Expires: 3600'],
        });
    }

    it('вне режима REGISTER и неизвестный Event → 405 (мимикрия не меняется)', async () =>
    {
        const st = await started_station('udp');
        const port = st.status().port;
        expect(st.sas_mode()).toBe(false);
        const reg = await udp_request(port, port_register_msg(port));
        expect(parse_sip_response(reg ?? '')?.status).toBe(405);
        const sub = await udp_request(
            port,
            build_sip_request('SUBSCRIBE', {
                ruri: `sip:u00s00p00@127.0.0.1:${port}`,
                from_uri: 'sip:u00s00p00@192.168.80.157:5060',
                to_uri: 'sip:u00s00p00@127.0.0.1',
                call_id: 'sas-sub-1',
                cseq: 22542,
                from_tag: 'trunk-tag',
                via_host: '192.168.80.157',
                extra_headers: ['Event: ssw-srvm', 'Expires: 7200'],
            }),
            900,
        );
        expect(parse_sip_response(sub ?? '')?.status).toBe(405);
    });

    it('в режиме: REGISTER → 200 с эхом Contact (параметры целы) и Expires', async () =>
    {
        const st = await started_station('udp');
        const port = st.status().port;
        st.set_sas_mode(true);
        expect(st.sas_mode()).toBe(true);
        const resp = await udp_request(port, port_register_msg(port));
        const head = parse_sip_response(resp ?? '');
        expect(head?.status).toBe(200);
        // Эхо СЫРОЙ Contact — parse режет `;extensions`; без него пир теряет
        // attribute (комментарий ветки REGISTER в station.ts).
        expect(resp).toContain(
            'Contact: <sip:u00s00p00@192.168.80.133:5060;extensions="answermode">',
        );
        expect(resp).toContain('Expires: 3600');
        expect(st.status().counters.answered['200']).toBe(1);
    });

    it('в режиме: SUBSCRIBE неизвестного Event → 200, имя пакета — в журнале', async () =>
    {
        const st = await started_station('udp');
        const port = st.status().port;
        st.set_sas_mode(true);
        const resp = await udp_request(
            port,
            build_sip_request('SUBSCRIBE', {
                ruri: `sip:u00s00p00@127.0.0.1:${port}`,
                from_uri: 'sip:u00s00p00@192.168.80.157:5060',
                to_uri: 'sip:u00s00p00@127.0.0.1',
                call_id: 'sas-sub-1',
                cseq: 22542,
                from_tag: 'trunk-tag',
                contact: 'sip:u00s00p00@192.168.80.133:5060',
                via_host: '192.168.80.157',
                extra_headers: ['Event: ssw-srvm', 'Expires: 7200'],
            }),
        );
        const head = parse_sip_response(resp ?? '');
        expect(head?.status).toBe(200);
        expect(resp).toContain('Event: ssw-srvm');
        expect(st.subscriptions_count()).toBe(1);
        // Имя SAS-пакета на проводе видно только из журнала (план 6 п.1).
        const ev = st.events(1)[0];
        expect(ev.method).toBe('SUBSCRIBE');
        expect(ev.event).toBe('ssw-srvm');
        // мимикрия OPTIONS не тронута и в режиме.
        const opt = await udp_request(port, request('OPTIONS'));
        expect(parse_sip_response(opt ?? '')?.status).toBe(200);
    });

    it('выключение возвращает мимикрию: REGISTER/неизвестный Event → 405', async () =>
    {
        const st = await started_station('udp');
        const port = st.status().port;
        st.set_sas_mode(true);
        st.set_sas_mode(false);
        const reg = await udp_request(port, port_register_msg(port), 900);
        expect(parse_sip_response(reg ?? '')?.status).toBe(405);
    });
});

// Режим «не отвечать на вызовы» (doc/task_29): INVITE от нижестоящей станции
// остаётся СОВСЕМ без ответа (тишина вместо 405), флаг — настройка станции,
// прочие методы (keep-alive и прочее) не затронуты.
describe('SipStation: режим «не отвечать на вызовы (INVITE)» (doc/task_29)', () =>
{
    it('включённый режим: INVITE молчит, журнал code 0, OPTIONS/BYE живы', async () =>
    {
        const st = await started_station('udp');
        const port = st.status().port;
        st.set_silent_invite(true);
        expect(st.silent_invite_mode()).toBe(true);
        expect(st.status().silent_invite).toBe(true);
        // Ни 405, ни 180/486: ответа нет вовсе (и ретрансляции пройдут сюда же).
        const inv = await udp_request(port, request('INVITE'), 700);
        expect(inv).toBeUndefined();
        // Учёт без ответа: запрос посчитан, answered не тронут, журнал — code 0.
        expect(st.status().counters.requests_in.INVITE).toBe(1);
        expect(st.status().counters.answered['405'] ?? 0).toBe(0);
        const ev = st.events(1)[0];
        expect(ev.method).toBe('INVITE');
        expect(ev.code).toBe(0);
        // Мимикрия не затронута режимом: OPTIONS → 200, BYE → 405.
        const opt = await udp_request(port, request('OPTIONS'));
        expect(parse_sip_response(opt ?? '')?.status).toBe(200);
        const bye = await udp_request(port, request('BYE', 2));
        expect(parse_sip_response(bye ?? '')?.status).toBe(405);
    });

    it('выключение возвращает мимикрию: INVITE снова получает 405', async () =>
    {
        const st = await started_station('udp');
        const port = st.status().port;
        st.set_silent_invite(true);
        st.set_silent_invite(false);
        expect(st.status().silent_invite).toBe(false);
        const inv = await udp_request(port, request('INVITE'), 900);
        expect(parse_sip_response(inv ?? '')?.status).toBe(405);
        expect(inv).toContain('Allow: OPTIONS');
    });
});

// Флаг перенаправления INVITE на уровне самой станции (doc/task_32_plan_2.md):
// INVITE забирает хук движка вызова — без него (здесь) флаг только настройка
// статуса, мимикрия обязана отвечать как раньше.
describe('SipStation: флаг «перенаправлять INVITE» без движка (doc/task_32)', () =>
{
    it('флаг по умолчанию false, переключение видно в статусе', async () =>
    {
        const st = await started_station('udp');
        expect(st.forward_invite_mode()).toBe(false);
        expect(st.status().forward_invite).toBe(false);
        st.set_forward_invite(true);
        expect(st.forward_invite_mode()).toBe(true);
        expect(st.status().forward_invite).toBe(true);
        st.set_forward_invite(false);
        expect(st.status().forward_invite).toBe(false);
    });

    it('без движка вызова INVITE отвечается мимикрией (405), как раньше', async () =>
    {
        const st = await started_station('udp');
        st.set_forward_invite(true);
        const inv = await udp_request(st.status().port, request('INVITE'), 900);
        expect(parse_sip_response(inv ?? '')?.status).toBe(405);
    });
});

// Флаг «игнорировать Trying/Ringing после перенаправленного INVITE»
// (doc/task_36_plan_2.md): 100/180 фильтрует движок вызова — без него
// (здесь) флаг только настройка статуса (по образцу task_32).
describe('SipStation: флаг «игнорировать Trying/Ringing» (doc/task_36)', () =>
{
    it('флаг по умолчанию false, переключение видно в статусе', async () =>
    {
        const st = await started_station('udp');
        expect(st.ignore_provisional_mode()).toBe(false);
        expect(st.status().ignore_provisional).toBe(false);
        st.set_ignore_provisional(true);
        expect(st.ignore_provisional_mode()).toBe(true);
        expect(st.status().ignore_provisional).toBe(true);
        st.set_ignore_provisional(false);
        expect(st.status().ignore_provisional).toBe(false);
    });
});

// Флаг «умножать перенаправляемый INVITE ×10» (doc/task_37_plan_2.md):
// фан-аут делает движок вызова — без него (здесь) флаг только настройка
// статуса (по образцу task_32/task_36), мимикрия отвечает как раньше.
describe('SipStation: флаг «умножать INVITE ×10» (doc/task_37)', () =>
{
    it('флаг по умолчанию false, переключение видно в статусе', async () =>
    {
        const st = await started_station('udp');
        expect(st.multiply_invite_mode()).toBe(false);
        expect(st.status().multiply_invite).toBe(false);
        st.set_multiply_invite(true);
        expect(st.multiply_invite_mode()).toBe(true);
        expect(st.status().multiply_invite).toBe(true);
        st.set_multiply_invite(false);
        expect(st.status().multiply_invite).toBe(false);
    });

    it('флаг без перенаправления: INVITE отвечается мимикрией (405), как раньше', async () =>
    {
        const st = await started_station('udp');
        st.set_multiply_invite(true);
        const inv = await udp_request(st.status().port, request('INVITE'), 900);
        expect(parse_sip_response(inv ?? '')?.status).toBe(405);
    });
});
