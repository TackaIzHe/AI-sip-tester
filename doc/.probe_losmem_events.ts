// Прогон-зонд для фиксации Event-пакетов и авторизации SUBSCRIBE на станции
// (не тест, не в бандле):
//   npx tsx doc/.probe_losmem_events.ts
//
// Этап 1 — SUBSCRIBE без авторизации на пять имён пакетов: 489 = пакет не
// поддерживается UAS, 401 = поддерживается, просит Digest (диалог-кандидат —
// `dialog`, RFC 4235; `dialog-info`/`event-list` → 489). Этап 2 — гипотеза
// «403 после Digest = абонент не зарегистрирован»: REGISTER с Digest (Contact
// с эфемерным портом), затем SUBSCRIBE `dialog` тем же сокетом — смотрим,
// даёт ли станция 200 с To-tag. Результат решает, добавлять ли регистрацию в
// server/los_mem/scenarios.ts (T1/T3/T8).
// related: server/los_mem/raw_sip.ts, server/los_mem/scenarios.ts,
// doc/los_mem/plan_test.md §3 T1, doc/los_mem/res.md (A, B).

import { load_config_from_env } from '../server/config';
import {
    build_digest_authorization,
    build_sip_request,
    parse_digest_challenge,
    parse_sip_response,
    RawSipClient,
} from '../server/los_mem/raw_sip';

async function main(): Promise<void>
{
    const config = load_config_from_env();
    const sub = config.subscribers.find((s) => s.can_register) ?? config.subscribers[0];
    const client = new RawSipClient({
        host: config.pbx_host,
        port: config.pbx_port,
        proto: config.sip_protocol === 'tcp' ? 'tcp' : 'udp',
    });
    await client.connect();
    const via = {
        via_host: config.bridge_host,
        proto: (config.sip_protocol === 'tcp' ? 'tcp' : 'udp') as 'udp' | 'tcp',
    };

    // этап 1: пакеты без авторизации
    let cseq = 1;
    for (const ev of ['dialog-info', 'dialog', 'event-list', 'presence'])
    {
        const call_id = `losmem-probe1-${ev}`;
        const msg = build_sip_request('SUBSCRIBE', {
            ruri: `sip:${sub.number}@${config.pbx_host}:${config.pbx_port}`,
            from_uri: `sip:${sub.number}@${config.bridge_host}`,
            to_uri: `sip:${sub.number}@${config.pbx_host}`,
            call_id,
            cseq: cseq++,
            from_tag: 'losprobe',
            contact: `sip:${sub.number}@${config.bridge_host}:${client.local_port()}`,
            ...via,
            extra_headers: [`Event: ${ev}`, 'Expires: 120', 'Allow: NOTIFY'],
        });
        const wait = client.wait_response(call_id, 5000);
        await client.send(msg);
        const raw = await wait;
        const head = raw ? parse_sip_response(raw) : null;
        console.log(
            `SUBSCRIBE Event: ${ev.padEnd(12)} → ${head?.status ?? 'нет ответа'}`,
        );
    }

    // этап 2: REGISTER с Digest → SUBSCRIBE `dialog` тем же Call-ID-стеком
    const reg_call = `losmem-probe2-reg-${Date.now()}`;
    const reg_base = {
        ruri: `sip:${config.pbx_host}:${config.pbx_port}`,
        from_uri: `sip:${sub.number}@${config.bridge_host}`,
        to_uri: `sip:${sub.number}@${config.pbx_host}`,
        call_id: reg_call,
        cseq: 1,
        from_tag: 'losprobe2',
        contact: `sip:${sub.number}@${config.bridge_host}:${client.local_port()}`,
        ...via,
        extra_headers: ['Expires: 120'],
    };
    let wait = client.wait_response(reg_call, 5000);
    await client.send(build_sip_request('REGISTER', reg_base));
    let raw = await wait;
    let head = raw ? parse_sip_response(raw) : null;
    let ch = raw ? parse_digest_challenge(raw) : null;
    console.log(`REGISTER (без auth) → ${head?.status ?? 'нет ответа'}`);
    if (head?.status === 401 && ch)
    {
        const auth = build_digest_authorization('REGISTER', ch, {
            user: sub.number,
            password: sub.password,
            uri: reg_base.ruri,
        });
        wait = client.wait_response(reg_call, 5000);
        await client.send(
            build_sip_request('REGISTER', {
                ...reg_base,
                cseq: 2,
                extra_headers: ['Expires: 120', `Authorization: ${auth}`],
            }),
        );
        raw = await wait;
        head = raw ? parse_sip_response(raw) : null;
        console.log(`REGISTER + Digest → ${head?.status ?? 'нет ответа'}`);
    }

    // 423 = Expires слишком мал — станция диктует свой порог в
    // Accept-Expires; пробуем и его, и 3600.
    for (const ttl of ['120', '3600'])
    {
        const sub_call = `losmem-probe2-sub-${ttl}-${Date.now()}`;
        const sub_base = {
            ruri: `sip:${sub.number}@${config.pbx_host}:${config.pbx_port}`,
            from_uri: `sip:${sub.number}@${config.bridge_host}`,
            to_uri: `sip:${sub.number}@${config.pbx_host}`,
            call_id: sub_call,
            cseq: 1,
            from_tag: 'losprobe2',
            contact: `sip:${sub.number}@${config.bridge_host}:${client.local_port()}`,
            ...via,
            extra_headers: [`Event: dialog`, `Expires: ${ttl}`, 'Allow: NOTIFY'],
        };
        wait = client.wait_response(sub_call, 5000);
        await client.send(build_sip_request('SUBSCRIBE', sub_base));
        raw = await wait;
        head = raw ? parse_sip_response(raw) : null;
        ch = raw ? parse_digest_challenge(raw) : null;
        const min_exp = raw ? (/accept-expires\s*:\s*(\d+)/i.exec(raw)?.[1] ?? '') : '';
        console.log(
            `SUBSCRIBE dialog Expires=${ttl} → ${head?.status ?? 'нет ответа'}` +
                (min_exp ? ` (Accept-Expires: ${min_exp})` : ''),
        );
        if (head?.status === 401 && ch)
        {
            const auth = build_digest_authorization('SUBSCRIBE', ch, {
                user: sub.number,
                password: sub.password,
                uri: sub_base.ruri,
            });
            wait = client.wait_response(sub_call, 5000);
            await client.send(
                build_sip_request('SUBSCRIBE', {
                    ...sub_base,
                    cseq: 2,
                    extra_headers: [
                        'Event: dialog',
                        `Expires: ${ttl}`,
                        'Allow: NOTIFY',
                        `Authorization: ${auth}`,
                    ],
                }),
            );
            raw = await wait;
            head = raw ? parse_sip_response(raw) : null;
            console.log(
                `  + Digest → ${head?.status ?? 'нет ответа'}` +
                    (head?.to_tag ? ` (to-tag ${head.to_tag})` : ''),
            );
            if (head?.to_tag)
            {
                // подписка открылась — снимаем сразу (стенд не захламляем)
                await client.send(
                    build_sip_request('SUBSCRIBE', {
                        ...sub_base,
                        cseq: 3,
                        to_tag: head.to_tag,
                        extra_headers: ['Event: dialog', 'Expires: 0'],
                    }),
                );
            }
        }
    }

    // этап 3: гипотеза blf_on_rx_notify — станция сама шлёт SUBSCRIBE на
    // Contact зарегистрированного абонента (BLF/SSW у неё настроены).
    // Регистрируемся с длинным Expires и слушаем 40 с входящие SUBSCRIBE.
    const in_sub: string[] = [];
    client.on_message((m) =>
    {
        if (/^SUBSCRIBE\s/i.test(m)) in_sub.push(m.split('\r\n')[0] ?? '?');
    });
    const reg3 = `losmem-probe3-${Date.now()}`;
    const reg3_base = { ...reg_base, call_id: reg3 };
    await client.send(build_sip_request('REGISTER', reg3_base));
    await new Promise((r) => setTimeout(r, 40_000));
    console.log(`за 40 с после REGISTER пришло SUBSCRIBE от станции: ${in_sub.length}`);
    for (const l of in_sub.slice(0, 5)) console.log(`  ${l}`);

    // снятие регистрации expires=0
    await client.send(
        build_sip_request('REGISTER', {
            ...reg_base,
            cseq: 3,
            extra_headers: ['Expires: 0'],
        }),
    );
    client.close();
}

main().catch((e: unknown) =>
{
    console.error('ошибка: ' + (e instanceof Error ? e.message : String(e)));
    process.exit(1);
});
