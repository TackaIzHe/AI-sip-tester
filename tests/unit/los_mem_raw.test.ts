// Юнит-тесты строительной части генератора стимулов doc/los_mem/plan_test.md
// (server/los_mem/raw_sip.ts + bodies.ts + сценарные куски scenarios.ts), без
// сети: сборка запросов (Content-Length — байтовая длина тела, CSeq/теги/
// branch в Via, ветки битых форм — override CL и мусор после тела), разбор
// ответов станции (To-tag/Contact для подписочного диалога), размеры тел
// T1/T2 («len 137, allowed 32» и «len 33, allowed 32» из doc/los_mem/res.md),
// внешний UDP-сокет RawSipClient (станционный :5060 — feed()/local_port/close
// не закрывает чужой), честный счётчик answered (только свои Call-ID, план 5
// п.2/H3), строка сырого журнала NOTIFY и построение NOTIFY в диалог принятой
// станцией подписки (план 5 п.2/п.4b).
// related: server/los_mem/raw_sip.ts, server/los_mem/bodies.ts,
// server/los_mem/scenarios.ts, tests/unit/journal.test.ts (образец
// синтетических сообщений), doc/plan_5.md п.2/п.4b.

import { describe, expect, it } from 'vitest';
import dgram from 'node:dgram';
import {
    build_digest_authorization,
    build_sip_request,
    build_sip_response,
    parse_digest_challenge,
    parse_sip_request_head,
    parse_sip_response,
    RawSipClient,
    sip_call_id,
    subscription_state_value,
    uri_host_port,
    type SipRequestOptions,
} from '../../server/los_mem/raw_sip';
import {
    dialog_info_body,
    ipc_subscribe_frames,
    simple_list_body,
    DIALOG_INFO_VARIANTS,
    SIMPLE_LIST_CONTENT_TYPE,
} from '../../server/los_mem/bodies';
import {
    notify_log_line,
    StationSubscriptions,
    type StationSubSource,
    type StationSubView,
} from '../../server/los_mem/scenarios';

const base: SipRequestOptions = {
    ruri: 'sip:52@192.168.80.157:5060',
    from_uri: 'sip:9404@192.168.80.159',
    to_uri: 'sip:52@192.168.80.157',
    call_id: 'losmem-test',
    cseq: 3,
    from_tag: 'los-aaa',
    via_host: '192.168.80.159',
};

describe('build_sip_request', () =>
{
    it('request-line и порядок заголовков RFC 3261 (Via с rport, branch)', () =>
    {
        const msg = build_sip_request('SUBSCRIBE', { ...base });
        const lines = msg.split('\r\n');
        expect(lines[0]).toBe('SUBSCRIBE sip:52@192.168.80.157:5060 SIP/2.0');
        expect(lines[1]).toMatch(
            /^Via: SIP\/2\.0\/UDP 192\.168\.80\.159;rport;branch=z9hG4bK-los-/,
        );
        // sent-by БЕЗ порта — грабль SanityCheck sip.js (CLAUDE.md «Грабли»).
        expect(lines[1]).not.toContain('192.168.80.159:');
        expect(lines[2]).toBe('Max-Forwards: 70');
        expect(lines[3]).toBe('From: <sip:9404@192.168.80.159>;tag=los-aaa');
        expect(lines[4]).toBe('To: <sip:52@192.168.80.157>');
        expect(lines[5]).toBe('Call-ID: losmem-test');
        expect(lines[6]).toBe('CSeq: 3 SUBSCRIBE');
    });

    it('via_extra — строки Via ретранслируемого хопа сразу под основным Via', () =>
    {
        // Via-стек INVITE-ретрансляции (doc/task_31_plan_2.md).
        const msg = build_sip_request('INVITE', {
            ...base,
            via_extra: [
                'Via: SIP/2.0/UDP 192.168.80.200:5060;rport;branch=z9hG4bK-relay-1',
            ],
        });
        const lines = msg.split('\r\n');
        expect(lines[1]).toMatch(/^Via: SIP\/2\.0\/UDP 192\.168\.80\.159;rport/);
        expect(lines[2]).toBe(
            'Via: SIP/2.0/UDP 192.168.80.200:5060;rport;branch=z9hG4bK-relay-1',
        );
        // до Max-Forwards — порядок строк Via значим для транзакций АТС.
        expect(lines[3]).toBe('Max-Forwards: 70');
        // регрессия: без поля — один Via, байт-в-байт как раньше (branch
        // фиксируем, он в обоих вызовах один и тот же по условию теста).
        const plain = { ...base, branch: 'z9hG4bK-los-fixed' };
        expect(build_sip_request('INVITE', { ...plain })).toBe(
            build_sip_request('INVITE', { ...plain, via_extra: [] }),
        );
    });

    it('to_tag появляется в To только из диалога; contact — отдельным заголовком', () =>
    {
        const msg = build_sip_request('NOTIFY', {
            ...base,
            to_tag: 'pbx-tag',
            contact: 'sip:9404@192.168.80.159',
        });
        expect(msg).toContain('To: <sip:52@192.168.80.157>;tag=pbx-tag');
        expect(msg).toContain('Contact: <sip:9404@192.168.80.159>');
    });

    it('Content-Length — БАЙТОВАЯ длина тела (utf8), не символьная', () =>
    {
        const body = 'сигнал « ocupado »'; // кириллица+ёлочки: байтов больше
        const msg = build_sip_request('MESSAGE', {
            ...base,
            content_type: 'text/plain',
            body,
        });
        expect(msg).toContain(`Content-Length: ${Buffer.byteLength(body, 'utf8')}`);
    });

    it('ветка битого CL: override поверх тела и мусор после Content-Length', () =>
    {
        const msg = build_sip_request('NOTIFY', {
            ...base,
            content_type: 'application/dialog-info+xml',
            body: '<a/>',
            content_length_override: 999, // станция ждёт 999 байт, их нет
            garbage_after_body: 'GARBAGE',
        });
        expect(msg).toContain('Content-Length: 999');
        expect(msg.endsWith('GARBAGE')).toBe(true);
        // Без override мусор учитывался бы в честной длине… нет: он ПОСЛЕ CL.
        const clean = build_sip_request('NOTIFY', {
            ...base,
            content_type: 'application/dialog-info+xml',
            body: '<a/>',
        });
        expect(clean).toContain('Content-Length: 4');
        expect(clean).not.toContain('GARBAGE');
    });

    it('extra_headers идут до Content-Type (Event/Expires/лишний Encoding)', () =>
    {
        const msg = build_sip_request('SUBSCRIBE', {
            ...base,
            extra_headers: ['Event: dialog-info', 'Expires: 600'],
            content_type: 'application/dialog-info+xml',
            body: '<b/>',
        });
        const ev = msg.indexOf('Event: dialog-info');
        const ct = msg.indexOf('Content-Type: application/dialog-info+xml');
        expect(ev).toBeGreaterThan(-1);
        expect(ev).toBeLessThan(ct);
    });
});

describe('build_sip_response / разбор ответов', () =>
{
    const request = build_sip_request('REGISTER', { ...base, cseq: 1 });

    it('ответ копирует Via/From/Call-ID/CSeq и дописывает tag в To', () =>
    {
        const resp = build_sip_response(401, 'Unauthorized', request, [
            'WWW-Authenticate: Digest realm="GUmvd", nonce="x"',
        ]);
        expect(resp.startsWith('SIP/2.0 401 Unauthorized')).toBe(true);
        expect(resp).toContain('From: <sip:9404@192.168.80.159>;tag=los-aaa');
        expect(resp).toContain('Call-ID: losmem-test');
        expect(resp).toContain('CSeq: 1 REGISTER');
        expect(resp).toContain(';tag=losprov');
        expect(resp).toContain('realm="GUmvd"');
    });

    it('parse_sip_response достаёт статус, метод, to_tag и contact', () =>
    {
        const resp =
            'SIP/2.0 200 OK\r\n' +
            'Via: SIP/2.0/UDP 192.168.80.159;rport;branch=z9hG4bK-1\r\n' +
            'From: <sip:9404@h>;tag=los-aaa\r\n' +
            'To: <sip:52@pbx>;tag=pbx-77\r\n' +
            'Call-ID: losmem-test\r\n' +
            'CSeq: 1 SUBSCRIBE\r\n' +
            'Contact: <sip:52@192.168.80.157:5060>\r\n' +
            'Content-Length: 0\r\n\r\n';
        const head = parse_sip_response(resp);
        expect(head?.status).toBe(200);
        expect(head?.cseq_method).toBe('SUBSCRIBE');
        expect(head?.to_tag).toBe('pbx-77');
        expect(head?.contact_uri).toBe('sip:52@192.168.80.157:5060');
    });

    it('запрос — не ответ (null); мусор не парсится', () =>
    {
        expect(parse_sip_response(request)).toBeNull();
        expect(parse_sip_response('????')).toBeNull();
    });

    it('uri_host_port: с портом, без порта — default; sip_call_id по заголовку', () =>
    {
        expect(uri_host_port('sip:52@10.0.0.1:5080', 5060)).toEqual({
            host: '10.0.0.1',
            port: 5080,
        });
        expect(uri_host_port('sip:10.0.0.1', 5060)).toEqual({
            host: '10.0.0.1',
            port: 5060,
        });
        expect(sip_call_id(request)).toBe('losmem-test');
    });

    it('parse_sip_request_head: SUBSCRIBE станции (Event/Expires/Contact/tags)', () =>
    {
        const req =
            'SUBSCRIBE sip:9404@192.168.80.159:41000 SIP/2.0\r\n' +
            'Via: SIP/2.0/UDP 192.168.80.157;rport;branch=z9hG4bK-pbx1\r\n' +
            'From: <sip:52@192.168.80.157>;tag=pbx-from\r\n' +
            'To: <sip:9404@192.168.80.157>\r\n' +
            'Call-ID: pbx-blf-1\r\n' +
            'CSeq: 1 SUBSCRIBE\r\n' +
            'Contact: <sip:52@192.168.80.157:5060>\r\n' +
            'Event: dialog;id=blf\r\n' +
            'Expires: 600\r\n' +
            'Content-Length: 0\r\n\r\n';
        const head = parse_sip_request_head(req);
        expect(head?.method).toBe('SUBSCRIBE');
        expect(head?.call_id).toBe('pbx-blf-1');
        expect(head?.from_uri).toBe('sip:52@192.168.80.157');
        expect(head?.from_tag).toBe('pbx-from');
        expect(head?.contact_uri).toBe('sip:52@192.168.80.157:5060');
        // параметры Event отсечены (id=blf — не часть имени пакета)
        expect(head?.event).toBe('dialog');
        expect(head?.expires).toBe(600);
        // запрос — не ответ; response-строка не парсится как запрос
        expect(parse_sip_request_head(build_sip_response(200, 'OK', req))).toBeNull();
    });
});

describe('тела-стимулы T1/T2 (doc/los_mem/res.md)', () =>
{
    it('T1 a–f: шесть вариантов; дефектные НЕ парсятся как полный dialog-info', () =>
    {
        expect(DIALOG_INFO_VARIANTS).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
        const a = dialog_info_body('a');
        expect(a).toContain('<dialog-info');
        expect(a).not.toContain('<dialog '); // «no dialog el»
        const b = dialog_info_body('b');
        expect(b).toContain('<dialog ');
        expect(b).not.toContain('<remote>'); // «no remote/identity el»
        expect(dialog_info_body('c')).toContain('{'); // JSON, не XML
        expect(dialog_info_body('d')).not.toMatch(/<\/dialog-info>\s*$/); // обрезан
        const f = dialog_info_body('f');
        expect(f).toContain('<remote><identity');
        expect(f).toMatch(/<\/dialog-info>\s*$/);
    });

    it('T2: value ровно 137 символов (лимит 32), name 33, свойство — парой', () =>
    {
        const body = simple_list_body({
            properties: 3,
            value_len: 137,
            name_len: 33,
        });
        const values = [...body.matchAll(/<value>(.*)<\/value>/g)].map((m) => m[1]);
        const names = [...body.matchAll(/<name>(.*)<\/name>/g)].map((m) => m[1]);
        expect(values).toHaveLength(3);
        expect(values.every((v) => v.length === 137)).toBe(true);
        expect(names).toHaveLength(3);
        expect(names[0]).toBe('replace_category_from_redirection'); // 33 из логов
        expect(names.every((n) => n.length === 33)).toBe(true);
        // XML-сущности считаются как в логах станции («len 137») — байты ascii.
        expect(values[0]).toContain('&quot;');
        expect(Buffer.byteLength(values[0], 'utf8')).toBe(137);
    });

    it('ipc_subscribe_frames: N кадров type 54 (hex 36) с мусорным payload', () =>
    {
        const frames = ipc_subscribe_frames(4);
        expect(frames).toHaveLength(4);
        for (const f of frames) expect(f.startsWith('36')).toBe(true);
        expect(frames[0]).not.toBe(frames[1]); // счётчик в payload различает
    });
});

// 401-авторизация SUBSCRIBE: станция пропускает Event: dialog только с
// Digest (зонд doc/.probe_losmem_events.ts); вектор — RFC 2617 §3.5.
describe('Digest для 401 станции', () =>
{
    const challenge_resp =
        'SIP/2.0 401 Unauthorized\r\n' +
        'Via: SIP/2.0/UDP 192.168.80.159;rport;branch=z9hG4bK-1\r\n' +
        'From: <sip:9404@h>;tag=los-aaa\r\n' +
        'To: <sip:52@pbx>;tag=pbx-77\r\n' +
        'Call-ID: losmem-test\r\n' +
        'CSeq: 1 SUBSCRIBE\r\n' +
        'WWW-Authenticate: Digest realm="testrealm@host.com", ' +
        'qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", ' +
        'opaque="5ccc069c403ebaf9f0171e9517f40e41", algorithm=MD5\r\n' +
        'Content-Length: 0\r\n\r\n';

    it('parse_digest_challenge: realm/nonce/opaque и qop=auth из списка', () =>
    {
        const ch = parse_digest_challenge(challenge_resp);
        expect(ch?.realm).toBe('testrealm@host.com');
        expect(ch?.nonce).toBe('dcd98b7102dd2f0e8b11d0f600bfb0c093');
        expect(ch?.opaque).toBe('5ccc069c403ebaf9f0171e9517f40e41');
        expect(ch?.qop).toBe('auth');
    });

    it('не-Digest и отсутствие nonce — null', () =>
    {
        expect(parse_digest_challenge('SIP/2.0 489 Bad Event\r\n\r\n')).toBeNull();
        expect(
            parse_digest_challenge(
                'SIP/2.0 401 Unauthorized\r\n' +
                    'WWW-Authenticate: Digest realm="r"\r\n\r\n',
            ),
        ).toBeNull();
    });

    it('вектор RFC 2617 §3.5 (qop=auth): response 6629fae4…', () =>
    {
        const ch = parse_digest_challenge(challenge_resp);
        const auth = ch
            ? build_digest_authorization('GET', ch, {
                  user: 'Mufasa',
                  password: 'Circle Of Life',
                  uri: '/dir/index.html',
                  cnonce: '0a4f113b',
                  nc: '00000001',
              })
            : '';
        expect(auth).toContain('Digest username="Mufasa"');
        expect(auth).toContain('response="6629fae49393a05397450978507c4ef1"');
        expect(auth).toContain('qop=auth');
        expect(auth).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
    });
});

// ---------- внешний UDP-сокет (станционный) ----------

/** Забинженный loopback-сокет (внешний «станционный» для клиента). */
async function bind_udp(): Promise<dgram.Socket>
{
    const sock = dgram.createSocket('udp4');
    await new Promise<void>((r) => sock.bind(0, '127.0.0.1', r));
    return sock;
}

describe('RawSipClient: внешний UDP-сокет (doc/task_25_plan_2.md, стимул от станции)', () =>
{
    it('внешний сокет не биндится заново и не закрывается close() клиента', async () =>
    {
        const ext = await bind_udp();
        const port = (ext.address() as { port: number }).port;
        const client = new RawSipClient({
            host: '127.0.0.1',
            port: 5060,
            udp_socket: ext,
        });
        await client.connect();
        expect(client.local_port()).toBe(port);
        client.close();
        // владелец (станция) жив: сокет отвечает address() и способен слать —
        // иначе close() сценария уронил бы станцию посреди прогона.
        expect(ext.address()).not.toBeNull();
        const peer = await bind_udp();
        const got = new Promise<string>((r) =>
            peer.once('message', (m) => r(m.toString('utf8'))),
        );
        const peer_port = (peer.address() as { port: number }).port;
        await new Promise<void>((r, j) =>
            ext.send(Buffer.from('ping'), peer_port, '127.0.0.1', (e) =>
                e ? j(e) : r(),
            ),
        );
        expect(await got).toBe('ping');
        peer.close();
        ext.close();
    });

    it('feed() раздаёт входящие: wait_response по Call-ID, on_message, answered', async () =>
    {
        const ext = await bind_udp();
        const client = new RawSipClient({
            host: '127.0.0.1',
            port: 5060,
            udp_socket: ext,
        });
        await client.connect();
        const seen: string[] = [];
        client.on_message((raw) => seen.push(raw.split('\r\n')[0] ?? '?'));
        const wait = client.wait_response('cid-1', 2000);
        const resp =
            'SIP/2.0 200 OK\r\nVia: SIP/2.0/UDP 127.0.0.1;rport;branch=z9hG4bK-x\r\n' +
            'From: <sip:9404@127.0.0.1>;tag=los-aaa\r\nTo: <sip:52@127.0.0.1>\r\n' +
            'Call-ID: cid-1\r\nCSeq: 1 REGISTER\r\nContent-Length: 0\r\n\r\n';
        // Ответ засчитывается только «своему» Call-ID (план 5 п.2/H3): на
        // общем станционном сокете feed получают все клиенты прогона.
        client.out_call_ids.add('cid-1'); // как после send() запроса cid-1
        client.feed(resp, { host: '127.0.0.1', port: 5060 });
        expect(await wait).toBe(resp);
        expect(seen).toEqual(['SIP/2.0 200 OK']);
        expect(client.answered.get('REGISTER 200')).toBe(1);
        // чужой ответ (другой Call-ID) — в сводку НЕ попадает
        client.feed(resp.replace('Call-ID: cid-1', 'Call-ID: cid-чужой'), {
            host: '127.0.0.1',
            port: 5060,
        });
        expect(client.answered.get('REGISTER 200')).toBe(1);
        expect(client.received_total).toBe(2);
        client.close();
        ext.close();
    });

    it('send() внешнего клиента уходит с станционного сокета (loopback)', async () =>
    {
        const ext = await bind_udp();
        const peer = await bind_udp();
        const peer_port = (peer.address() as { port: number }).port;
        const client = new RawSipClient({
            host: '127.0.0.1',
            port: peer_port,
            udp_socket: ext,
        });
        await client.connect();
        const got = new Promise<{ msg: string; src_port: number }>((r) =>
            peer.once('message', (m, rinfo) =>
                r({ msg: m.toString('utf8'), src_port: rinfo.port }),
            ),
        );
        const msg = build_sip_request('OPTIONS', { ...base });
        await client.send(msg);
        const rx = await got;
        expect(rx.msg.startsWith('OPTIONS')).toBe(true);
        // src-порт ответа станции придёт именно на порт внешнего сокета —
        // тот же, что в Contact: keep-alive пира возвращается на станцию.
        expect(rx.src_port).toBe(client.local_port());
        client.close();
        peer.close();
        ext.close();
    });
});

// ---------- NOTIFY в диалог принятой подписки (план 5 п.2/п.4b) ----------

/** Диалог вида принятой SSW-подписки станции (form-view сип-станции). */
function station_view(over: Partial<StationSubView> = {}): StationSubView
{
    return {
        call_id: 'caseb-unit-1',
        event: 'event-list',
        from_uri: 'sip:u00s34p00@192.168.80.159:5060',
        to_uri: 'sip:u00s34p00@192.168.80.157:5060',
        contact_uri: 'sip:u00s34p00@192.168.80.157:5060',
        remote: { host: '192.168.80.157', port: 5060 },
        our_tag: 'stasub-1',
        peer_tag: 'trunk-tag',
        cseq: 0,
        // Динамический остаток ~10 мин: subscription_state_value обязан
        // отдавать остаток, а не дефолт 600.
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        ...over,
    };
}

const local_9404 = { number: '9404', password: '123', can_register: true };

describe('NOTIFY в диалог принятой подписки (plan 5 п.2/п.4b)', () =>
{
    it('notify_log_line: адресат, cid/cseq, теги, event/ct, байты тела', () =>
    {
        const msg = build_sip_request('NOTIFY', {
            ruri: 'sip:u00s34p00@192.168.80.157:5060',
            from_uri: 'sip:u@192.168.80.159',
            to_uri: 'sip:u@192.168.80.157',
            call_id: 'cid-n',
            cseq: 7,
            from_tag: 'stasub-1',
            to_tag: 'trunk-tag',
            via_host: '192.168.80.159',
            content_type: SIMPLE_LIST_CONTENT_TYPE,
            body: '<l/>',
            extra_headers: ['Event: event-list'],
        });
        const line = notify_log_line(msg, { host: '192.168.80.157', port: 5060 });
        expect(line).toContain('NOTIFY → 192.168.80.157:5060');
        expect(line).toContain('cid=cid-n cseq=7 NOTIFY');
        expect(line).toContain('tags=stasub-1/trunk-tag');
        expect(line).toContain('event=event-list');
        expect(line).toContain(`ct=${SIMPLE_LIST_CONTENT_TYPE}`);
        expect(line).toContain(`body=${Buffer.byteLength('<l/>', 'utf8')}B`);
    });

    it('next_notify по внешней подписке: R-URI=Contact, зеркала тегов, CSeq источника', async () =>
    {
        const ext = await bind_udp();
        const client = new RawSipClient({
            host: '127.0.0.1',
            port: 5060,
            udp_socket: ext,
        });
        await client.connect();
        let taken = 0;
        const src: StationSubSource = {
            list: () => [station_view()],
            take_cseq: () => (taken += 1), // как take_notify_cseq станции
        };
        const stn = new StationSubscriptions(client, '192.168.80.159', local_9404, src);
        const msg = stn.next_notify('<l/>', SIMPLE_LIST_CONTENT_TYPE);
        expect(msg?.startsWith('NOTIFY sip:u00s34p00@192.168.80.157:5060 SIP/2.0')).toBe(
            true,
        );
        // From/To и теги — зеркало диалога (мы notifier в её UAC-подписке).
        expect(msg).toContain('From: <sip:u00s34p00@192.168.80.159:5060>;tag=stasub-1');
        expect(msg).toContain('To: <sip:u00s34p00@192.168.80.157:5060>;tag=trunk-tag');
        expect(msg).toContain('CSeq: 1 NOTIFY');
        expect(msg).toContain('Event: event-list');
        // Subscription-State обязателен: без него pjsip-evsub станции
        // отвечает 400 и отписывается (12.log); остаток — от expires_at.
        expect(msg).toMatch(/Subscription-State: active;expires=\d+/);
        // CSeq ведёт источник (станция): второй вызов — 2, монотонно.
        expect(stn.next_notify('<l/>', SIMPLE_LIST_CONTENT_TYPE)).toContain(
            'CSeq: 2 NOTIFY',
        );
        expect(stn.active_count()).toBe(1);
        expect(stn.active_events()).toEqual(['event-list']);
        client.close();
        ext.close();
    });

    it('фильтр events; нет Contact в записи — адресат remote станции', async () =>
    {
        const ext = await bind_udp();
        const client = new RawSipClient({
            host: '127.0.0.1',
            port: 5060,
            udp_socket: ext,
        });
        await client.connect();
        const src: StationSubSource = {
            list: () => [station_view({ contact_uri: '' })],
            take_cseq: () => 1,
        };
        const stn = new StationSubscriptions(client, '192.168.80.159', local_9404, src);
        // Пустой Contact подписки → R-URI/адресат — remote из записи станции.
        const msg = stn.next_notify('<l/>', SIMPLE_LIST_CONTENT_TYPE);
        expect(msg?.startsWith('NOTIFY sip:9404@192.168.80.157:5060 SIP/2.0')).toBe(true);
        // Диалог с другим пакетом фильтр events не берёт (NOTIFY только в свой).
        const other: StationSubSource = {
            list: () => [station_view({ event: 'dialog-info' })],
            take_cseq: () => 1,
        };
        const stn2 = new StationSubscriptions(
            client,
            '192.168.80.159',
            local_9404,
            other,
        );
        expect(
            stn2.next_notify('<l/>', SIMPLE_LIST_CONTENT_TYPE, ['event-list']),
        ).toBeUndefined();
        client.close();
        ext.close();
    });
});

describe('subscription_state_value (Subscription-State NOTIFY, 12.log)', () =>
{
    it('остаток секунд до expires_at; мусор/истечение — дефолт 600', () =>
    {
        const soon = new Date(Date.now() + 120_000).toISOString();
        // округление вверх допускает потерю <1 с между меткой и вызовом.
        expect(subscription_state_value(soon)).toMatch(/^active;expires=(119|120)$/);
        expect(subscription_state_value('')).toBe('active;expires=600');
        const past = new Date(Date.now() - 5_000).toISOString();
        expect(subscription_state_value(past)).toBe('active;expires=600');
    });
});
