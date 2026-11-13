// Юнит-тесты движка исходящего вызова (server/station/outbound.ts,
// doc/task_30_plan_2.md) — без внешней сети: реальная SipStation на loopback
// (порт 0) + «пир»-сокеты, играющие нижестоящую станцию. Полный цикл:
// INVITE (R-URI/From/Contact user=номер/NO_MEDIA_SDP/branch) → 180 → 200
// (To-tag, Contact-адресат) → ACK в диалог Contact → BYE (CSeq 2) → 200 →
// idle и снятие хука (ответ-мусор снова в ignored). CANCEL — тот же branch
// и CSeq, финал 487 → ACK той же веткой; 486 без отбоя → idle + last_code.
// Мимикрия станции во время вызова: OPTIONS пира отвечается (хук ест только
// ответы/свой диалог). last_downstream пишется REGISTER'ом и работает
// адресатом по умолчанию. Таймаут retransmit — на урезанном T1 (параметр
// конструктора): timeout + хук снят. Запуск: npm run test:unit.
// Origin (doc/task_31_plan_2.md): INVITE «ретрансляции» — From/Call-ID от
// origin-адреса, второй Via = origin; CANCEL/ACK-на-не-2xx зеркалят стек,
// ACK-на-2xx и BYE — один Via, From origin-домена; SAS и вызов совместимы
// (мультикаст-хук). Перенаправление входящих INVITE по таблице регистраций
// (doc/task_34_plan_2.md, байты INVITE — образец pimer.md, task_35):
// адресат — address строки по номеру из R-URI, R-URI — identifier линии
// на адресате, From/To/Contact — наш IP; src пира на провод не уходит;
// маршрут не найден — 405 мимикрии, retransmit/занятый/петля — без набора.
// Игнорирование Trying/Ringing (doc/task_36_plan_2.md): при флаге станции
// ignore_provisional 100/180 на перенаправленный INVITE не замечаются (ни
// ringing, ни счётчиков), прямой вызов и финалы не затронуты.
// Умножение перенаправляемого INVITE ×10 (doc/task_37_plan_2.md): при флаге
// станции multiply_invite перенаправление уходит десятью копиями разом
// (главный dial + девять теней), каждая со своим Call-ID/branch/From-tag;
// финалы копий потребляются (не-2xx → ACK той же веткой, 2xx → ACK+немедлен-
// ный BYE), «отбой»/abort накрывает копии, хук станции держится, пока жива
// хоть одна копия.
// related: server/station/outbound.ts (StationOutbound),
// server/station/station.ts (last_downstream_peer, add_incoming_hook),
// server/station/registrations.ts (таблица для перенаправления),
// tests/unit/station_sas.test.ts (образец loopback-стенда),
// server/los_mem/raw_sip.ts.

import dgram from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../server/config';
import {
    build_sip_request,
    build_sip_response,
    parse_sip_request_head,
    sip_call_id,
} from '../../server/los_mem/raw_sip';
import { StationOutbound } from '../../server/station/outbound';
import { StationRegistrations } from '../../server/station/registrations';
import { StationSas } from '../../server/station/sas';
import { SipStation } from '../../server/station/station';

function station_config(): AppConfig
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
        station_host: '127.0.0.1',
        station_port: 0,
        station_proto: 'udp',
    };
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () =>
{
    for (const f of cleanup.splice(0)) await f();
});

async function wait_until(pred: () => boolean, timeout_ms: number): Promise<boolean>
{
    const deadline = Date.now() + timeout_ms;
    while (Date.now() < deadline)
    {
        if (pred()) return true;
        await new Promise((r) => setTimeout(r, 20));
    }
    return pred();
}

/** «Нижестоящая станция»: свой UDP-сокет + журнал принятых сообщений. */
interface Peer
{
    sock: dgram.Socket;
    port: number;
    received: string[];
}

async function make_peer(): Promise<Peer>
{
    const sock = dgram.createSocket('udp4');
    await new Promise<void>((resolve) => sock.bind(0, '127.0.0.1', resolve));
    const peer: Peer = { sock, port: sock.address().port, received: [] };
    sock.on('message', (m: Buffer) => peer.received.push(m.toString('utf8')));
    cleanup.push(() =>
    {
        sock.close();
        return Promise.resolve();
    });
    return peer;
}

function find_msg(peer: Peer, re: RegExp): string
{
    return peer.received.find((m) => re.test(m)) ?? '';
}

function branch_of(msg: string): string
{
    return /branch=([^\s;]+)/i.exec(msg)?.[1] ?? '';
}

async function wait_peer(peer: Peer, re: RegExp, ms = 3000): Promise<string>
{
    const ok = await wait_until(() => peer.received.some((m) => re.test(m)), ms);
    expect(ok).toBe(true);
    return find_msg(peer, re);
}

describe('StationOutbound: состояния dial без сети', () =>
{
    it('dial на остановленной / без адресата / повторный — ошибки движка', async () =>
    {
        const st = new SipStation(station_config());
        const ob = new StationOutbound(station_config(), st);
        cleanup.push(async () => await st.stop());
        expect(() => ob.dial({ callee: '52' })).toThrowError(/Станция остановлена/);
        await st.start();
        // пир ещё не обращался — адресата по умолчанию нет.
        expect(() => ob.dial({ callee: '52' })).toThrowError(/адрес.*неизвестен/);
        expect(ob.status().state).toBe('idle');
        // явный target — заводится; повторный dial — занято.
        ob.dial({ callee: '52', target: '127.0.0.1:1' });
        expect(ob.status().state).toBe('calling');
        expect(() => ob.dial({ callee: '123' })).toThrowError(/уже выполняется/);
        ob.abort();
        expect(ob.status().state).toBe('idle');
    });
});

describe('StationOutbound: полный цикл INVITE→180→200→ACK→BYE (loopback)', () =>
{
    it('UAC-диалог: теги, Contact-адресат, CSeq и снятие хука', async () =>
    {
        const st = new SipStation(station_config());
        await st.start();
        cleanup.push(async () =>
        {
            ob.abort();
            await st.stop();
        });
        const ob = new StationOutbound(station_config(), st);
        const peer = await make_peer(); // сигнальный адресат (last src не нужен)
        // Contact 200 — на ОТДЕЛЬНЫЙ сокет: ACK/BYE обязаны уйти в него,
        // это проверяет разбор remote из Contact, а не совпадение с target.
        const media = await make_peer();
        ob.dial({ callee: '52', target: `127.0.0.1:${peer.port}` });
        expect(ob.status().state).toBe('calling');
        const invite = await wait_peer(peer, /^INVITE /m);
        // R-URI и адресат — target; From/Contact — caller по умолчанию
        // (первый абонент конфига), Contact user = номер (грабля АТС).
        expect(invite).toContain(`INVITE sip:52@127.0.0.1:${peer.port} SIP/2.0`);
        expect(invite).toContain('From: <sip:9404@127.0.0.1>;tag=');
        expect(invite).toContain('To: <sip:52@127.0.0.1');
        expect(invite).toContain(`Contact: <sip:9404@127.0.0.1:${st.status().port}>`);
        expect(invite).toContain('CSeq: 1 INVITE');
        expect(invite).toContain('User-Agent: station-outcall/1.0');
        // Медиа нет никогда: NO_MEDIA_SDP (port 9 + inactive).
        expect(invite).toContain('m=audio 9');
        expect(invite).toContain('a=inactive');
        const inv_branch = branch_of(invite);
        expect(inv_branch).toMatch(/^z9hG4bK-ob-/);
        // 180 → ringing; 200 с To-tag и Contact на media — answered.
        peer.sock.send(
            build_sip_response(180, 'Ringing', invite),
            st.status().port,
            '127.0.0.1',
        );
        expect(await wait_until(() => ob.status().state === 'ringing', 2000)).toBe(true);
        const ok200 = build_sip_response(
            200,
            'OK',
            invite,
            [`Contact: <sip:52@127.0.0.1:${media.port}>`],
            'peer-tag',
        );
        peer.sock.send(ok200, st.status().port, '127.0.0.1');
        expect(await wait_until(() => ob.status().state === 'answered', 2000)).toBe(true);
        // ACK — в диалог: адресат R-URI из Contact, To с чужим тегом, новый
        // branch (не ветка INVITE).
        const ack = await wait_peer(media, /^ACK /m);
        expect(ack).toContain(`ACK sip:52@127.0.0.1:${media.port} SIP/2.0`);
        expect(ack).toContain(';tag=peer-tag');
        expect(ack).toContain('CSeq: 1 ACK');
        expect(branch_of(ack)).not.toBe(inv_branch);
        // Отбой после соединения — BYE: CSeq 2 в диалоге, адресат — Contact.
        ob.hangup();
        expect(ob.status().state).toBe('terminating');
        const bye = await wait_peer(media, /^BYE /m);
        expect(bye).toContain('CSeq: 2 BYE');
        expect(bye).toContain(';tag=peer-tag');
        media.sock.send(
            build_sip_response(200, 'OK', bye),
            st.status().port,
            '127.0.0.1',
        );
        expect(await wait_until(() => ob.status().state === 'idle', 2000)).toBe(true);
        expect(ob.status().error).toBe('');
        expect(ob.status().last_code).toBe(200);
        // Хук снят finish(): ответ-мусор на закрытый вызов — снова «игнор».
        peer.sock.send(
            build_sip_response(200, 'OK', invite),
            st.status().port,
            '127.0.0.1',
        );
        expect(
            await wait_until(() => (st.status().counters.ignored ?? 0) >= 1, 2000),
        ).toBe(true);
    }, 20000);
});

describe('StationOutbound: отбой CANCEL', () =>
{
    it('CANCEL — тот же branch/CSeq; финал 487 → ACK той же веткой → idle', async () =>
    {
        const st = new SipStation(station_config());
        await st.start();
        cleanup.push(async () =>
        {
            ob.abort();
            await st.stop();
        });
        const ob = new StationOutbound(station_config(), st);
        const peer = await make_peer();
        ob.dial({ callee: '123', caller: '52', target: `127.0.0.1:${peer.port}` });
        const invite = await wait_peer(peer, /^INVITE /m);
        ob.cancel();
        expect(ob.status().state).toBe('cancelling');
        const cancel = await wait_peer(peer, /^CANCEL /m);
        // RFC 3261 §9.1: та же ветка транзакции и тот же номер CSeq.
        expect(branch_of(cancel)).toBe(branch_of(invite));
        expect(cancel).toContain('CSeq: 1 CANCEL');
        expect(cancel).toContain('From: <sip:52@127.0.0.1>');
        // 200 на CANCEL ничего не решает; финал 487 на INVITE — ACK той же
        // веткой и завершение с кодом в статусе.
        peer.sock.send(
            build_sip_response(200, 'OK', cancel),
            st.status().port,
            '127.0.0.1',
        );
        peer.sock.send(
            build_sip_response(487, 'Request Terminated', invite),
            st.status().port,
            '127.0.0.1',
        );
        expect(await wait_until(() => ob.status().state === 'idle', 2000)).toBe(true);
        expect(ob.status().last_code).toBe(487);
        expect(ob.status().error).toContain('487');
        const ack = find_msg(peer, /^ACK /m);
        expect(ack).toContain('CSeq: 1 ACK');
        expect(branch_of(ack)).toBe(branch_of(invite));
    }, 20000);
});

describe('StationOutbound: отказ без отбоя и мимикрия', () =>
{
    it('486 без CANCEL → idle + last_code, ACK отправлен; OPTIONS пира — 200', async () =>
    {
        const st = new SipStation(station_config());
        await st.start();
        cleanup.push(async () =>
        {
            ob.abort();
            await st.stop();
        });
        const ob = new StationOutbound(station_config(), st);
        const peer = await make_peer();
        ob.dial({ callee: '52', target: `127.0.0.1:${peer.port}` });
        const invite = await wait_peer(peer, /^INVITE /m);
        // keep-alive пира во время вызова: хук ест ответы/свой диалог, а
        // запросы возвращает станции — мимикрия живёт.
        const ka = build_sip_request('OPTIONS', {
            ruri: `sip:127.0.0.1:${st.status().port}`,
            from_uri: 'sip:keepalive@127.0.0.1',
            to_uri: 'sip:keepalive@127.0.0.1',
            call_id: 'ka-ob-1',
            cseq: 16570,
            from_tag: 'ka-tag',
            via_host: '127.0.0.1',
        });
        peer.sock.send(ka, st.status().port, '127.0.0.1');
        const ka_ok = await wait_peer(peer, /^SIP\/2\.0 200/);
        expect(ka_ok).toContain('CSeq: 16570 OPTIONS');
        // Занятость: вызов завершается честным кодом, ACK обязателен.
        peer.sock.send(
            build_sip_response(486, 'Busy Here', invite),
            st.status().port,
            '127.0.0.1',
        );
        expect(await wait_until(() => ob.status().state === 'idle', 2000)).toBe(true);
        expect(ob.status().last_code).toBe(486);
        expect(ob.status().error).toContain('486');
        expect(find_msg(peer, /^ACK /m)).toContain('CSeq: 1 ACK');
    }, 20000);

    it('BYE от пира в активном диалоге → 200 и завершение вызова', async () =>
    {
        const st = new SipStation(station_config());
        await st.start();
        cleanup.push(async () =>
        {
            ob.abort();
            await st.stop();
        });
        const ob = new StationOutbound(station_config(), st);
        const peer = await make_peer();
        ob.dial({ callee: '52', target: `127.0.0.1:${peer.port}` });
        const invite = await wait_peer(peer, /^INVITE /m);
        peer.sock.send(
            build_sip_response(
                200,
                'OK',
                invite,
                [`Contact: <sip:52@127.0.0.1:${peer.port}>`],
                'peer-tag',
            ),
            st.status().port,
            '127.0.0.1',
        );
        expect(await wait_until(() => ob.status().state === 'answered', 2000)).toBe(true);
        // Нижестоящая станция вешает трубку первой (тот же Call-ID).
        const bye = build_sip_request('BYE', {
            ruri: `sip:9404@127.0.0.1:${st.status().port}`,
            from_uri: 'sip:52@127.0.0.1',
            to_uri: `sip:9404@127.0.0.1`,
            call_id: ob.status().call_id,
            cseq: 2,
            from_tag: 'peer-tag',
            to_tag: '9404',
            via_host: '127.0.0.1',
        });
        peer.sock.send(bye, st.status().port, '127.0.0.1');
        expect(await wait_until(() => ob.status().state === 'idle', 2000)).toBe(true);
        expect(find_msg(peer, /^SIP\/2\.0 200/)).toContain('CSeq: 2 BYE');
        expect(ob.status().error).toBe('');
    }, 20000);
});

describe('StationOutbound: адресат по умолчанию и таймаут', () =>
{
    it('last_downstream пишется REGISTER и служит адресатом dial', async () =>
    {
        const st = new SipStation(station_config());
        await st.start();
        cleanup.push(async () =>
        {
            ob.abort();
            await st.stop();
        });
        const ob = new StationOutbound(station_config(), st);
        const peer = await make_peer();
        const reg = build_sip_request('REGISTER', {
            ruri: `sip:127.0.0.1:${st.status().port}`,
            from_uri: 'sip:52@127.0.0.1',
            to_uri: 'sip:127.0.0.1',
            call_id: 'reg-ob-1',
            cseq: 1,
            from_tag: 'reg-tag',
            via_host: '127.0.0.1',
        });
        peer.sock.send(reg, st.status().port, '127.0.0.1');
        const addr = `127.0.0.1:${peer.port}`;
        expect(await wait_until(() => st.status().last_downstream === addr, 2000)).toBe(
            true,
        );
        ob.dial({ callee: '52' }); // без target — адрес пира из статуса
        expect(ob.status().target).toBe(addr);
        expect(await wait_peer(peer, /^INVITE /m)).not.toBe('');
    }, 20000);

    it('нет ответа станции → таймаут INVITE, хук снят (урезанный T1)', async () =>
    {
        const st = new SipStation(station_config());
        await st.start();
        cleanup.push(async () => await st.stop());
        // t1_ms=10 → потолок транзакции 64·10=640 мс (пропорционально T1).
        const ob = new StationOutbound(station_config(), st, 10);
        const peer = await make_peer(); // сокет есть, ответов нет
        ob.dial({ callee: '52', target: `127.0.0.1:${peer.port}` });
        expect(await wait_until(() => ob.status().state === 'idle', 5000)).toBe(true);
        expect(ob.status().error).toContain('нет ответа');
        expect(peer.received.filter((m) => /^INVITE /m.test(m)).length).toBeGreaterThan(
            1,
        );
        // retransmit шли, хук ещё держал вызов; после timeout снят.
        const invite = find_msg(peer, /^INVITE /m);
        peer.sock.send(
            build_sip_response(180, 'Ringing', invite),
            st.status().port,
            '127.0.0.1',
        );
        expect(
            await wait_until(() => (st.status().counters.ignored ?? 0) >= 1, 2000),
        ).toBe(true);
        expect(parse_sip_request_head(invite)?.method).toBe('INVITE');
    }, 20000);
});

describe('StationOutbound: origin — вызов «ретрансляцией» от другого адреса (task_31)', () =>
{
    const ORIG = 'origin';
    const ORIG_ADDR = '127.0.0.2:5070';

    it('INVITE: From/Call-ID от origin, второй Via = origin, статус origin', async () =>
    {
        const st = new SipStation(station_config());
        await st.start();
        const ob = new StationOutbound(station_config(), st);
        cleanup.push(async () =>
        {
            ob.abort();
            await st.stop();
        });
        const peer = await make_peer();
        const tgt = `127.0.0.1:${peer.port}`;
        // битый порт — uri_host_port возвращает undefined (хост без порта
        // движок принимает: валидация формы — забота контроллера, TARGET_RE).
        expect(() =>
            ob.dial({ callee: '52', target: tgt, origin: 'h:abc' }),
        ).toThrowError(/origin/);
        ob.dial({
            callee: '52',
            target: `127.0.0.1:${peer.port}`,
            origin: ORIG_ADDR,
        });
        expect(ob.status().origin).toBe(ORIG_ADDR);
        const invite = await wait_peer(peer, /^INVITE /m);
        const lines = invite.split('\r\n');
        // From и домен Call-ID — origin (вызов «пришёл» оттуда).
        expect(invite).toContain(`From: <sip:9404@${ORIG_ADDR}>;tag=`);
        expect(ob.status().call_id.endsWith('@127.0.0.2')).toBe(true);
        // Via-стек: наш (верхний) + origin (нижестоящий хоп) до Max-Forwards.
        expect(lines[1]).toMatch(/^Via: SIP\/2\.0\/UDP 127\.0\.0\.1;rport/);
        expect(lines[2]).toContain(`UDP ${ORIG_ADDR};rport;branch=z9hG4bK-ob-relay-`);
        expect(lines[3]).toBe('Max-Forwards: 70');
        // Contact остаётся станцией — ответы/диалог возвращаются к нам.
        expect(invite).toContain(`Contact: <sip:9404@127.0.0.1:${st.status().port}>`);
    }, 20000);

    it('ACK на не-2xx — зеркало Via-стека и branch INVITE; From origin', async () =>
    {
        const st = new SipStation(station_config());
        await st.start();
        const ob = new StationOutbound(station_config(), st);
        cleanup.push(async () =>
        {
            ob.abort();
            await st.stop();
        });
        const peer = await make_peer();
        ob.dial({
            callee: '52',
            target: `127.0.0.1:${peer.port}`,
            origin: ORIG_ADDR,
        });
        const invite = await wait_peer(peer, /^INVITE /m);
        peer.sock.send(
            build_sip_response(486, 'Busy Here', invite),
            st.status().port,
            '127.0.0.1',
        );
        expect(await wait_until(() => ob.status().state === 'idle', 2000)).toBe(true);
        const ack = await wait_peer(peer, /^ACK /m);
        // транзакция INVITE: тот же верхний branch и ОБА Via (стек INVITE).
        expect(branch_of(ack)).toBe(branch_of(invite));
        const vias = ack.split('\r\n').filter((l) => /^via:/i.test(l));
        expect(vias.length).toBe(2);
        expect(vias[1]).toContain(ORIG_ADDR);
        expect(ack).toContain(`From: <sip:9404@${ORIG_ADDR}>`);
    }, 20000);

    it('ACK на 2xx и BYE — ОДИН Via, From origin-домена; SAS живёт параллельно', async () =>
    {
        const st = new SipStation(station_config());
        await st.start();
        const sas = new StationSas(station_config(), st);
        const ob = new StationOutbound(station_config(), st);
        cleanup.push(async () =>
        {
            ob.abort();
            if (sas.status().state === 'on') sas.disable();
            await st.stop();
        });
        // SAS включён ДО вызова: вызов в режиме SAS — исходный сценарий
        // задачи (мультикаст-хук, 409-пересечения сняты).
        sas.enable();
        const peer = await make_peer();
        const media = await make_peer();
        ob.dial({
            callee: '52',
            target: `127.0.0.1:${peer.port}`,
            origin: ORIG,
        });
        expect(ob.status().origin).toBe(`${ORIG}:5060`); // порт по умолчанию
        const invite = await wait_peer(peer, /^INVITE /m);
        peer.sock.send(
            build_sip_response(
                200,
                'OK',
                invite,
                [`Contact: <sip:52@127.0.0.1:${media.port}>`],
                'peer-tag',
            ),
            st.status().port,
            '127.0.0.1',
        );
        // SAS-хук (ест все ответы) не смутил движок: 200 обработан.
        expect(await wait_until(() => ob.status().state === 'answered', 2000)).toBe(true);
        expect(sas.status().state).toBe('on');
        const ack = await wait_peer(media, /^ACK /m);
        // in-dialog: один Via (наш), From — origin (matching диалога).
        const vias = ack.split('\r\n').filter((l) => /^via:/i.test(l));
        expect(vias.length).toBe(1);
        expect(ack).toContain(`From: <sip:9404@${ORIG}:5060>`);
        ob.hangup();
        const bye = await wait_peer(media, /^BYE /m);
        expect(bye.split('\r\n').filter((l) => /^via:/i.test(l)).length).toBe(1);
        expect(bye).toContain('CSeq: 2 BYE');
        media.sock.send(
            build_sip_response(200, 'OK', bye),
            st.status().port,
            '127.0.0.1',
        );
        expect(await wait_until(() => ob.status().state === 'idle', 2000)).toBe(true);
        expect(sas.status().state).toBe('on'); // SAS пережил полный цикл
    }, 20000);
});

// Перенаправление входящих INVITE ПО ТАБЛИЦЕ РЕГИСТРАЦИЙ
// (doc/task_34_plan_2.md, байты INVITE — образец pimer.md,
// doc/task_35_plan_2.md): при флаге станции хук движка забирает `INVITE
// sip:<номер>@…` у мимикрии и dial'ит по строке таблицы (phone=номер):
// адресат UDP — address строки, R-URI — identifier линии на адресате,
// To/From/Contact — наш IP (From — номер из таблицы по identifier из
// Contact входящего, ;user=phone), src пира на провод не уходит (один
// Via); Max-Forwards 69, Allow образца, полный SDP-образец (sendrecv).
// Маршрут не найден (нет строки / пуст address) — 405 мимикрии; retransmit
// того же Call-ID и INVITE при занятом движке — без второго набора;
// адресат = сама станция — съеден (петля); флаг выключен — прежний 405.
describe('StationOutbound: перенаправление INVITE по таблице регистраций (doc/task_34)', () =>
{
    /** INVITE пира на станцию: R-URI — номер вызываемого, Contact — identifier. */
    function invite_msg(ruri: string, cid: string, contact: string): string
    {
        return build_sip_request('INVITE', {
            ruri,
            from_uri: 'sip:u00s52p52@192.168.80.133:5060',
            to_uri: ruri,
            call_id: cid,
            cseq: 1,
            from_tag: 'caller-tag',
            contact,
            via_host: '192.168.80.133',
        });
    }

    function send_invite(from: dgram.Socket, port: number, msg: string): void
    {
        from.send(Buffer.from(msg, 'utf8'), port, '127.0.0.1');
    }

    /**
     * Строка вызываемого: identifier + номер + адрес UDP-адресата (record
     * заполняет address, как REGISTER станции).
     */
    function callee_row(store: StationRegistrations, addr: string): void
    {
        store.add('u00s01p01', '9404');
        store.record('u00s01p01', addr);
        store.add('u00s52p52', '52'); // инициатор: Contact → номер 52
    }

    it('INVITE ретранслируется по таблице: адресат=address, R-URI=identifier@наш, From=номер из Contact', async () =>
    {
        const st = new SipStation(station_config());
        await st.start();
        // T1 20 с — свой retransmit INVITE не мешает подсчётам в тесте.
        const ob = new StationOutbound(station_config(), st, 20000);
        cleanup.push(async () =>
        {
            ob.abort();
            await st.stop();
        });
        const target = await make_peer();
        const caller = await make_peer();
        const regs = new StationRegistrations();
        callee_row(regs, `127.0.0.1:${target.port}`);
        ob.attach_registrations(regs);
        st.set_forward_invite(true);
        send_invite(
            caller.sock,
            st.status().port,
            invite_msg(
                `sip:9404@127.0.0.1:${st.status().port}`,
                'fwd-1',
                'sip:u00s52p52@192.168.80.133:5060',
            ),
        );
        // UDP-адресат — address строки таблицы; R-URI — identifier линии на
        // адресате (образец pimer.md, doc/task_35_plan_2.md).
        const rel = await wait_peer(
            target,
            new RegExp(`^INVITE sip:u00s01p01@127\\.0\\.0\\.1:${target.port} `),
        );
        // From/To — наш IP (без порта), From — номер из таблицы по
        // identifier из Contact входящего (52), НЕ origin; Contact — номер.
        expect(rel).toContain('To: <sip:9404@127.0.0.1>');
        expect(rel).toContain('From: <sip:52@127.0.0.1;user=phone>;tag=');
        expect(rel).toContain(`Contact: <sip:52@127.0.0.1:${st.status().port}>`);
        expect(ob.status().call_id.endsWith('@127.0.0.1')).toBe(true);
        // Байты образца pimer.md: ОДИН Via с портом в sent-by (src пира на
        // провод не уходит — остаётся в статусе), Max-Forwards 69, Allow.
        const vias = rel.split('\r\n').filter((l) => /^via:/i.test(l));
        expect(vias.length).toBe(1);
        expect(vias[0]).toContain(`UDP 127.0.0.1:${st.status().port};rport`);
        expect(rel).toContain('Max-Forwards: 69');
        expect(rel).toContain(
            'Allow: INVITE, ACK, BYE, CANCEL, UPDATE, PRACK, SUBSCRIBE, NOTIFY, REFER',
        );
        expect(rel).toContain('User-Agent: station-outcall/1.0');
        // Тело — полный SDP-образец (sendrecv, PCMA/PCMU/101), не заглушка;
        // RTP-порт формальный (медиа движок не шлёт).
        expect(rel).toMatch(/m=audio \d+ RTP\/AVP 8 0 101/);
        expect(rel).toContain('a=rtpmap:101 telephone-event/8000');
        expect(rel).toContain('a=sendrecv');
        expect(rel).toContain('c=IN IP4 127.0.0.1');
        expect(ob.status().state).toBe('calling');
        expect(ob.status().origin).toBe(`127.0.0.1:${caller.port}`);
        // Мимикрия исходному пиру не отвечает: ни 405, ни 180/200 за 700 мс.
        await new Promise((r) => setTimeout(r, 700));
        expect(caller.received.some((m) => /^SIP\/2\.0 /.test(m))).toBe(false);
    });

    it('маршрут не найден (нет строки / пуст address) — мимикрия отвечает 405', async () =>
    {
        const st = new SipStation(station_config());
        await st.start();
        const ob = new StationOutbound(station_config(), st, 20000);
        cleanup.push(async () =>
        {
            ob.abort();
            await st.stop();
        });
        const target = await make_peer();
        const caller = await make_peer();
        const regs = new StationRegistrations();
        // строка вызываемого есть, но БЕЗ адреса (REGISTER не приходил);
        // номер 9405 вообще отсутствует в таблице.
        regs.add('u00s01p01', '9404');
        ob.attach_registrations(regs);
        st.set_forward_invite(true);
        send_invite(
            caller.sock,
            st.status().port,
            invite_msg(
                `sip:9404@127.0.0.1:${st.status().port}`,
                'fwd-noaddr',
                'sip:u00s52p52@192.168.80.133:5060',
            ),
        );
        expect(await wait_until(() => caller.received.length > 0, 1500)).toBe(true);
        expect(caller.received[0]).toMatch(/^SIP\/2\.0 405/);
        send_invite(
            caller.sock,
            st.status().port,
            invite_msg(
                `sip:9405@127.0.0.1:${st.status().port}`,
                'fwd-norow',
                'sip:u00s52p52@192.168.80.133:5060',
            ),
        );
        await new Promise((r) => setTimeout(r, 400));
        expect(target.received.length).toBe(0);
        expect(ob.status().state).toBe('idle');
        expect(ob.status().log.some((l) => l.includes('не в таблице'))).toBe(true);
    });

    it('retransmit того же Call-ID и новый INVITE на занятом — без второго набора', async () =>
    {
        const st = new SipStation(station_config());
        await st.start();
        const ob = new StationOutbound(station_config(), st, 20000);
        cleanup.push(async () =>
        {
            ob.abort();
            await st.stop();
        });
        const target = await make_peer();
        const caller = await make_peer();
        const regs = new StationRegistrations();
        callee_row(regs, `127.0.0.1:${target.port}`);
        ob.attach_registrations(regs);
        st.set_forward_invite(true);
        const msg = invite_msg(
            `sip:9404@127.0.0.1:${st.status().port}`,
            'fwd-dup',
            'sip:u00s52p52@192.168.80.133:5060',
        );
        send_invite(caller.sock, st.status().port, msg);
        await wait_peer(target, /^INVITE sip:u00s01p01@/m);
        // retransmit исходного INVITE (тот же Call-ID) и ещё один вызов при
        // занятом движке — оба съедены, набор остаётся один.
        send_invite(caller.sock, st.status().port, msg);
        send_invite(
            caller.sock,
            st.status().port,
            invite_msg(
                `sip:9404@127.0.0.1:${st.status().port}`,
                'fwd-busy',
                'sip:u00s52p52@192.168.80.133:5060',
            ),
        );
        await new Promise((r) => setTimeout(r, 300));
        expect(new Set(target.received.map(sip_call_id)).size).toBe(1);
        expect(ob.status().state).toBe('calling');
    });

    it('адресат — сама станция: без набора (защита от петли), INVITE съеден', async () =>
    {
        const st = new SipStation(station_config());
        await st.start();
        const ob = new StationOutbound(station_config(), st, 20000);
        cleanup.push(async () =>
        {
            ob.abort();
            await st.stop();
        });
        const caller = await make_peer();
        const regs = new StationRegistrations();
        // адрес строки = сама станция: dial ушёл бы в наш же UAS.
        callee_row(regs, `127.0.0.1:${st.status().port}`);
        ob.attach_registrations(regs);
        st.set_forward_invite(true);
        const st_port = st.status().port;
        send_invite(
            caller.sock,
            st_port,
            invite_msg(
                `sip:9404@127.0.0.1:${st_port}`,
                'fwd-loop',
                'sip:u00s52p52@192.168.80.133:5060',
            ),
        );
        await new Promise((r) => setTimeout(r, 400));
        expect(ob.status().state).toBe('idle');
        expect(ob.status().log.some((l) => l.includes('сама станция'))).toBe(true);
        expect(caller.received.some((m) => /^SIP\/2\.0 /.test(m))).toBe(false);
    });

    it('флаг выключен: мимикрия отвечает 405, адресату не отправлено ничего', async () =>
    {
        const st = new SipStation(station_config());
        await st.start();
        const ob = new StationOutbound(station_config(), st, 20000);
        cleanup.push(async () =>
        {
            ob.abort();
            await st.stop();
        });
        const target = await make_peer();
        const caller = await make_peer();
        const regs = new StationRegistrations();
        callee_row(regs, `127.0.0.1:${target.port}`);
        ob.attach_registrations(regs);
        // forward_invite не включён — INVITE живёт в мимикрии (task_24).
        send_invite(
            caller.sock,
            st.status().port,
            invite_msg(
                `sip:9404@127.0.0.1:${st.status().port}`,
                'fwd-off',
                'sip:u00s52p52@192.168.80.133:5060',
            ),
        );
        expect(await wait_until(() => caller.received.length > 0, 1500)).toBe(true);
        expect(caller.received[0]).toMatch(/^SIP\/2\.0 405/);
        await new Promise((r) => setTimeout(r, 200));
        expect(target.received.length).toBe(0);
    });
});

// Игнорирование Trying/Ringing после перенаправленного INVITE
// (doc/task_36_plan_2.md): при флаге станции ignore_provisional движок не
// замечает 100/180 на INVITE, поднятый перенаправлением, — без перехода в
// ringing, без answered/last_code; ответ лишь потребляется хуком (в ignored
// станции не попадает) и помечается в журнале. Область флага — только
// перенаправление: прямой dial и финальные ответы (486/200) не затронуты.
describe('StationOutbound: игнорирование Trying/Ringing (doc/task_36)', () =>
{
    /** INVITE пира на станцию (тот же контракт, что в describe task_34). */
    function invite_msg(ruri: string, cid: string, contact: string): string
    {
        return build_sip_request('INVITE', {
            ruri,
            from_uri: 'sip:u00s52p52@192.168.80.133:5060',
            to_uri: ruri,
            call_id: cid,
            cseq: 1,
            from_tag: 'caller-tag',
            contact,
            via_host: '192.168.80.133',
        });
    }

    function send_invite(from: dgram.Socket, port: number, msg: string): void
    {
        from.send(Buffer.from(msg, 'utf8'), port, '127.0.0.1');
    }

    function callee_row(store: StationRegistrations, addr: string): void
    {
        store.add('u00s01p01', '9404');
        store.record('u00s01p01', addr);
        store.add('u00s52p52', '52');
    }

    /** Стенд перенаправления: станция+движок+таблица, вызов уже набран. */
    async function forwarded_call(ignore: boolean)
    {
        const st = new SipStation(station_config());
        await st.start();
        // T1 20 с — свой retransmit INVITE не мешает подсчётам в тесте.
        const ob = new StationOutbound(station_config(), st, 20000);
        cleanup.push(async () =>
        {
            ob.abort();
            await st.stop();
        });
        const target = await make_peer();
        const caller = await make_peer();
        const regs = new StationRegistrations();
        callee_row(regs, `127.0.0.1:${target.port}`);
        ob.attach_registrations(regs);
        st.set_forward_invite(true);
        st.set_ignore_provisional(ignore);
        send_invite(
            caller.sock,
            st.status().port,
            invite_msg(
                `sip:9404@127.0.0.1:${st.status().port}`,
                'fwd-ign',
                'sip:u00s52p52@192.168.80.133:5060',
            ),
        );
        const rel = await wait_peer(target, /^INVITE sip:u00s01p01@/m);
        return { st, ob, target, rel };
    }

    it('флаг ON: 100/180 игнорируются, финал 486 обрабатывается как обычно', async () =>
    {
        const { st, ob, target, rel } = await forwarded_call(true);
        expect(ob.status().state).toBe('calling');
        target.sock.send(
            build_sip_response(100, 'Trying', rel),
            st.status().port,
            '127.0.0.1',
        );
        target.sock.send(
            build_sip_response(180, 'Ringing', rel),
            st.status().port,
            '127.0.0.1',
        );
        await new Promise((r) => setTimeout(r, 400));
        // Будто не приходили: ни «звонка», ни счётчиков.
        expect(ob.status().state).toBe('calling');
        expect(Object.keys(ob.status().answered).length).toBe(0);
        expect(ob.status().last_code).toBe(0);
        // Честная пометка в журнале движка…
        expect(
            ob.status().log.some((l) => l.includes('игнорирован: Trying/Ringing')),
        ).toBe(true);
        // …и потребление хуком: в ignored станции ничего не упало.
        expect(st.status().counters.ignored).toBe(0);
        // Флаг не трогает финалы: 486 — обычная ветка отказа.
        target.sock.send(
            build_sip_response(486, 'Busy Here', rel),
            st.status().port,
            '127.0.0.1',
        );
        expect(await wait_until(() => ob.status().state === 'idle', 2000)).toBe(true);
        expect(ob.status().last_code).toBe(486);
    }, 20000);

    it('флаг OFF: то же 180 на перенаправленный вызов — прежнее «ringing»', async () =>
    {
        const { st, ob, target, rel } = await forwarded_call(false);
        target.sock.send(
            build_sip_response(180, 'Ringing', rel),
            st.status().port,
            '127.0.0.1',
        );
        expect(await wait_until(() => ob.status().state === 'ringing', 2000)).toBe(true);
        expect(ob.status().answered['180']).toBe(1);
        expect(ob.status().last_code).toBe(180);
    }, 20000);

    it('флаг ON, прямой dial: 180 — прежнее «ringing» (не перенаправление)', async () =>
    {
        const st = new SipStation(station_config());
        await st.start();
        const ob = new StationOutbound(station_config(), st, 20000);
        cleanup.push(async () =>
        {
            ob.abort();
            await st.stop();
        });
        const peer = await make_peer();
        st.set_ignore_provisional(true);
        ob.dial({ callee: '52', target: `127.0.0.1:${peer.port}` });
        const invite = await wait_peer(peer, /^INVITE /m);
        peer.sock.send(
            build_sip_response(180, 'Ringing', invite),
            st.status().port,
            '127.0.0.1',
        );
        expect(await wait_until(() => ob.status().state === 'ringing', 2000)).toBe(true);
        expect(ob.status().answered['180']).toBe(1);
    }, 20000);
});

// Умножение перенаправляемого INVITE ×10 (doc/task_37_plan_2.md): при флаге
// станции multiply_invite перенаправление уходит десятью копиями разом —
// главный dial + девять теневых диалогов в одном synchronous-проходе хука.
// Копии отличаются Call-ID/branch/From-tag, байты — образец pimer.md.
// Судьба копий: не-2xx финал → ACK той же веткой и снятие, 2xx → ACK в
// диалог + немедленный BYE (линию копия не держит), «отбой»/abort накрывает
// копии; хук станции держится, пока жива хоть одна копия.
describe('StationOutbound: умножение перенаправляемого INVITE ×10 (doc/task_37)', () =>
{
    /** INVITE пира на станцию (тот же контракт, что в describe task_34). */
    function invite_msg(ruri: string, cid: string, contact: string): string
    {
        return build_sip_request('INVITE', {
            ruri,
            from_uri: 'sip:u00s52p52@192.168.80.133:5060',
            to_uri: ruri,
            call_id: cid,
            cseq: 1,
            from_tag: 'caller-tag',
            contact,
            via_host: '192.168.80.133',
        });
    }

    function send_invite(from: dgram.Socket, port: number, msg: string): void
    {
        from.send(Buffer.from(msg, 'utf8'), port, '127.0.0.1');
    }

    function callee_row(store: StationRegistrations, addr: string): void
    {
        store.add('u00s01p01', '9404');
        store.record('u00s01p01', addr);
        store.add('u00s52p52', '52');
    }

    /** Все INVITE перенаправления, дошедшие до адресата. */
    function invites_to_target(peer: Peer): string[]
    {
        return peer.received.filter((m) => /^INVITE sip:u00s01p01@/.test(m));
    }

    function msgs_to_target(peer: Peer, re: RegExp): string[]
    {
        return peer.received.filter((m) => re.test(m));
    }

    function msg_for(peer: Peer, re: RegExp, cid: string): string
    {
        return peer.received.find((m) => re.test(m) && sip_call_id(m) === cid) ?? '';
    }

    /** Первый INVITE копии (Call-ID отличается от главного вызова). */
    function shadow_invite(peer: Peer, main_cid: string): string
    {
        return invites_to_target(peer).find((m) => sip_call_id(m) !== main_cid) ?? '';
    }

    /** Стенд перенаправления с флагом умножения; INVITE пира уже послан.
     * @param t1_ms — урезанный T1 (тест таймаута копий); по умолчанию 20 с,
     * чтобы свои retransmit (главный и копии) не мешали подсчётам. */
    async function multiplied_call(multiply: boolean, t1_ms = 20000)
    {
        const st = new SipStation(station_config());
        await st.start();
        const ob = new StationOutbound(station_config(), st, t1_ms);
        cleanup.push(async () =>
        {
            ob.abort();
            await st.stop();
        });
        const target = await make_peer();
        const caller = await make_peer();
        const regs = new StationRegistrations();
        callee_row(regs, `127.0.0.1:${target.port}`);
        ob.attach_registrations(regs);
        st.set_forward_invite(true);
        st.set_multiply_invite(multiply);
        send_invite(
            caller.sock,
            st.status().port,
            invite_msg(
                `sip:9404@127.0.0.1:${st.status().port}`,
                'fwd-mul',
                'sip:u00s52p52@192.168.80.133:5060',
            ),
        );
        await wait_peer(target, /^INVITE sip:u00s01p01@/m);
        return { st, ob, target };
    }

    /** Дождаться n INVITE перенаправления у адресата. */
    async function wait_invites(target: Peer, n: number): Promise<string[]>
    {
        const ok = await wait_until(() => invites_to_target(target).length >= n, 3000);
        expect(ok).toBe(true);
        return invites_to_target(target);
    }

    it('входящий INVITE уходит ×10 разом: десять разных Call-ID, журнал ×10', async () =>
    {
        const { ob, target } = await multiplied_call(true);
        const invites = await wait_invites(target, 10);
        expect(invites.length).toBe(10);
        // Копии — отдельные диалоги: разные Call-ID, branch и From-tag
        // (одинаковые UA станция бы не приняла), байты — образец pimer.md.
        expect(new Set(invites.map((m) => sip_call_id(m))).size).toBe(10);
        expect(new Set(invites.map((m) => branch_of(m))).size).toBe(10);
        expect(new Set(invites.map((m) => /;tag=([^\s;>]+)/i.exec(m)?.[1])).size).toBe(
            10,
        );
        // «Разом» — один synchronous-проход хука: пока тест посмотрел статус,
        // все десять уже на проводе; главный диалог владеет состоянием.
        expect(ob.status().state).toBe('calling');
        expect(ob.status().multiplied_active).toBe(9);
        expect(ob.status().log.some((l) => l.includes('×10 (умножение)'))).toBe(true);
    }, 20000);

    it('180 на копию: главный вызов неизменен (ни ringing, ни счётчиков)', async () =>
    {
        const { st, ob, target } = await multiplied_call(true);
        await wait_invites(target, 10);
        const shadow_msg = shadow_invite(target, ob.status().call_id);
        expect(shadow_msg).not.toBe('');
        target.sock.send(
            build_sip_response(180, 'Ringing', shadow_msg),
            st.status().port,
            '127.0.0.1',
        );
        await new Promise((r) => setTimeout(r, 400));
        expect(ob.status().state).toBe('calling');
        expect(Object.keys(ob.status().answered).length).toBe(0);
        expect(ob.status().last_code).toBe(0);
        // Копия живёт дальше: промежуточный ответ её не снимает.
        expect(ob.status().multiplied_active).toBe(9);
    }, 20000);

    it('не-2xx финал копии: ACK той же веткой, копия снята, главный жив', async () =>
    {
        const { st, ob, target } = await multiplied_call(true);
        await wait_invites(target, 10);
        const shadow_msg = shadow_invite(target, ob.status().call_id);
        const cid = sip_call_id(shadow_msg);
        target.sock.send(
            build_sip_response(486, 'Busy Here', shadow_msg),
            st.status().port,
            '127.0.0.1',
        );
        expect(await wait_until(() => msg_for(target, /^ACK /, cid) !== '', 2000)).toBe(
            true,
        );
        // ACK на не-2xx — транзакция INVITE: branch копии, не новый (RFC 3261
        // §17.1.1).
        expect(branch_of(msg_for(target, /^ACK /, cid))).toBe(branch_of(shadow_msg));
        expect(await wait_until(() => ob.status().multiplied_active === 8, 2000)).toBe(
            true,
        );
        // 486 копии не трогает главный вызов и его счётчики.
        expect(ob.status().state).toBe('calling');
        expect(ob.status().last_code).toBe(0);
    }, 20000);

    it('200 на копию: ACK в диалог и немедленный BYE — копия линию не держит', async () =>
    {
        const { st, ob, target } = await multiplied_call(true);
        await wait_invites(target, 10);
        const shadow_msg = shadow_invite(target, ob.status().call_id);
        const cid = sip_call_id(shadow_msg);
        target.sock.send(
            build_sip_response(200, 'OK', shadow_msg, [
                `Contact: <sip:9404@127.0.0.1:${target.port}>`,
            ]),
            st.status().port,
            '127.0.0.1',
        );
        // ACK в диалог (новый branch) и BYE по тому же Call-ID — копия
        // освобождает линию сама, без кнопок.
        expect(
            await wait_until(() => msg_for(target, /^ACK sip:/, cid) !== '', 2000),
        ).toBe(true);
        expect(
            await wait_until(() => msg_for(target, /^BYE sip:/, cid) !== '', 2000),
        ).toBe(true);
        // Снятие копии — по 200 на её BYE.
        const bye_msg = msg_for(target, /^BYE sip:/, cid);
        target.sock.send(
            build_sip_response(200, 'OK', bye_msg),
            st.status().port,
            '127.0.0.1',
        );
        expect(await wait_until(() => ob.status().multiplied_active === 8, 2000)).toBe(
            true,
        );
    }, 20000);

    it('«отбой» накрывает копии: CANCEL уходит главному и каждой копии', async () =>
    {
        const { ob, target } = await multiplied_call(true);
        await wait_invites(target, 10);
        ob.cancel();
        expect(
            await wait_until(
                () => msgs_to_target(target, /^CANCEL /).length === 10,
                2000,
            ),
        ).toBe(true);
        // Копии отменены каждая своим диалогом: десять разных Call-ID.
        const cids = new Set(
            msgs_to_target(target, /^CANCEL /).map((m) => sip_call_id(m)),
        );
        expect(cids.size).toBe(10);
    }, 20000);

    it('abort гасит копии: движок idle, multiplied_active 0', async () =>
    {
        const { ob, target } = await multiplied_call(true);
        await wait_invites(target, 10);
        ob.abort();
        expect(ob.status().state).toBe('idle');
        expect(ob.status().multiplied_active).toBe(0);
        // Хук отпущен (главный idle и копий нет): мусор адресату не шлём,
        // станция сама ответит мимикрией — здесь просто отсутствие набора.
        expect(msgs_to_target(target, /^INVITE sip:u00s01p01@/).length).toBe(10);
    }, 20000);

    it('главный завершён раньше копий: хук держится, финал копии ACK-ится', async () =>
    {
        const { st, ob, target } = await multiplied_call(true);
        await wait_invites(target, 10);
        const main_cid = ob.status().call_id;
        const main_msg = msg_for(target, /^INVITE sip:/, main_cid);
        target.sock.send(
            build_sip_response(486, 'Busy Here', main_msg),
            st.status().port,
            '127.0.0.1',
        );
        expect(await wait_until(() => ob.status().state === 'idle', 2000)).toBe(true);
        expect(ob.status().multiplied_active).toBe(9);
        // Ответ копии после idle главного доходит до движка (хук жив): не-2xx
        // финал копии — ACK и снятие именно этой копии.
        const shadow_msg = shadow_invite(target, main_cid);
        const cid = sip_call_id(shadow_msg);
        target.sock.send(
            build_sip_response(486, 'Busy Here', shadow_msg),
            st.status().port,
            '127.0.0.1',
        );
        expect(await wait_until(() => msg_for(target, /^ACK /, cid) !== '', 2000)).toBe(
            true,
        );
        expect(await wait_until(() => ob.status().multiplied_active === 8, 2000)).toBe(
            true,
        );
    }, 20000);

    it('копии без ответа: урезанный T1 — все сняты по таймауту, движок idle', async () =>
    {
        const { ob, target } = await multiplied_call(true, 20);
        await wait_invites(target, 10);
        // Никто не отвечает: retransmit с удвоением до >64·T1, затем снятие
        // копии; главный — той же веткой (task_30), к финалу теней нет.
        expect(
            await wait_until(
                () => ob.status().multiplied_active === 0 && ob.status().state === 'idle',
                9000,
            ),
        ).toBe(true);
        const timeouts = ob
            .status()
            .log.filter(
                (l) => l.includes('копия') && l.includes('INVITE: нет ответа (timeout)'),
            );
        expect(timeouts).toHaveLength(9);
    }, 20000);

    it('флаг выключен: перенаправление одиночное, теней нет', async () =>
    {
        const { ob, target } = await multiplied_call(false);
        await new Promise((r) => setTimeout(r, 300));
        expect(invites_to_target(target).length).toBe(1);
        expect(ob.status().multiplied_active).toBe(0);
        expect(ob.status().log.some((l) => l.includes('умножение'))).toBe(false);
    }, 20000);
});
