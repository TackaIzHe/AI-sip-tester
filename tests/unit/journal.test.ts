// Юнит-тест server/journal.ts (критерий plan_2.md п.3): по синтетическому
// логу в temp-каталог создаются 3 файла отчёта; в HTML присутствуют все этапы
// цепочки (регистрация 401→200, INVITE, 100/180, 200+ACK, BYE, 486, 487, 480).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    Journal,
    parse_sip_message,
    utc_stamp,
    type ReportMeta,
} from '../../server/journal';
import { PhoneStateMachine } from '../../server/sip/state';
import type {
    CallHandle,
    Transport,
    TransportEventName,
    TransportEvents,
} from '../../server/sip/transport';

// ---------- синтетические SIP-сообщения (образец живой АТС) ----------

function sip(first: string, headers: Record<string, string>): string
{
    const h = Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');
    return `${first}\r\n${h}\r\n\r\n`;
}

const REG = 'reg-1@192.168.80.159';
const CALL = 'call-2@192.168.80.159';

const RAW_REGISTER = sip('REGISTER sip:192.168.80.157:5060 SIP/2.0', {
    Via: 'SIP/2.0/UDP 192.168.80.159:5060;rport',
    From: '<sip:9404@192.168.80.157>;tag=aa',
    To: '<sip:9404@192.168.80.157>',
    'Call-ID': REG,
    CSeq: '1 REGISTER',
    Expires: '600',
    'Content-Length': '0',
});

const RAW_401 = sip('SIP/2.0 401 Unauthorized', {
    Via: 'SIP/2.0/UDP 192.168.80.159:5060;rport=5060',
    From: '<sip:9404@192.168.80.157>;tag=aa',
    To: '<sip:9404@192.168.80.157>;tag=b1',
    'Call-ID': REG,
    CSeq: '1 REGISTER',
    'WWW-Authenticate': 'Digest realm="asterisk", nonce="deadbeef"',
    'Content-Length': '0',
});

const RAW_REGISTER_DIGEST = sip('REGISTER sip:192.168.80.157:5060 SIP/2.0', {
    Via: 'SIP/2.0/UDP 192.168.80.159:5060;rport',
    From: '<sip:9404@192.168.80.157>;tag=aa',
    To: '<sip:9404@192.168.80.157>',
    'Call-ID': REG,
    CSeq: '2 REGISTER',
    Authorization: 'Digest username="9404", nonce="deadbeef", response="…"',
    Expires: '600',
    'Content-Length': '0',
});

function response(code: number, reason: string, cseq: string, call_id: string): string
{
    return sip(`SIP/2.0 ${code} ${reason}`, {
        From: '<sip:9404@192.168.80.157>;tag=aa',
        To: '<sip:52@192.168.80.157>;tag=c1',
        'Call-ID': call_id,
        CSeq: cseq,
        'Content-Length': '0',
    });
}

const RAW_INVITE = sip('INVITE sip:52@192.168.80.157:5060 SIP/2.0', {
    From: '<sip:9404@192.168.80.157>;tag=aa',
    To: '<sip:52@192.168.80.157>',
    'Call-ID': CALL,
    CSeq: '3 INVITE',
    'Content-Length': '0',
});

const RAW_ACK = sip('ACK sip:52@192.168.80.157:5060 SIP/2.0', {
    From: '<sip:9404@192.168.80.157>;tag=aa',
    To: '<sip:52@192.168.80.157>;tag=c1',
    'Call-ID': CALL,
    CSeq: '3 ACK',
    'Content-Length': '0',
});

const RAW_BYE = sip('BYE sip:52@192.168.80.157:5060 SIP/2.0', {
    From: '<sip:9404@192.168.80.157>;tag=aa',
    To: '<sip:52@192.168.80.157>;tag=c1',
    'Call-ID': CALL,
    CSeq: '4 BYE',
    'Content-Length': '0',
});

const RAW_CANCEL = sip('CANCEL sip:52@192.168.80.157:5060 SIP/2.0', {
    From: '<sip:9404@192.168.80.157>;tag=aa',
    To: '<sip:52@192.168.80.157>',
    'Call-ID': 'cancel-3@192.168.80.159',
    CSeq: '3 CANCEL',
    'Content-Length': '0',
});

/** Полная синтетическая цепочка всех этапов (критерий п.3). */
function fill_full_chain(j: Journal): void
{
    j.on_sip_message('9404', 'out', RAW_REGISTER);
    j.on_sip_message('9404', 'in', RAW_401);
    j.on_sip_message('9404', 'out', RAW_REGISTER_DIGEST);
    j.on_sip_message('9404', 'in', response(200, 'OK', '2 REGISTER', REG));
    j.on_sip_message('9404', 'out', RAW_INVITE);
    j.on_sip_message('9404', 'in', response(100, 'Trying', '3 INVITE', CALL));
    j.on_sip_message('9404', 'in', response(180, 'Ringing', '3 INVITE', CALL));
    j.on_sip_message('9404', 'in', response(200, 'OK', '3 INVITE', CALL));
    j.on_sip_message('9404', 'out', RAW_ACK);
    j.on_sip_message('9404', 'out', RAW_BYE);
    // отклонение занятым (486), сброс CANCEL (487), не-ответ (480).
    j.on_sip_message('9404', 'in', response(486, 'Busy Here', '4 INVITE', 'busy-4@x'));
    j.on_sip_message('9404', 'out', RAW_CANCEL);
    j.on_sip_message(
        '9404',
        'in',
        response(487, 'Request Terminated', '3 CANCEL', 'cancel-3@192.168.80.159'),
    );
    j.on_sip_message(
        '9404',
        'in',
        response(480, 'Temporarily Unavailable', '5 INVITE', 'na-5@x'),
    );
}

const META: ReportMeta = {
    case: 'case_2',
    verdict: 'PASS',
    verdict_text: 'цепочка полная',
    pbx_host: '192.168.80.157',
    pbx_port: 5060,
    sip_protocol: 'udp',
    subscribers: ['9404', '52', '3203'],
};

// ---------- разбор сырых сообщений ----------

describe('parse_sip_message', () =>
{
    it('разбирает запрос: метод, user RURI, Call-ID, Digest', () =>
    {
        const plain = parse_sip_message(RAW_REGISTER);
        expect(plain).not.toBeNull();
        expect(plain?.is_request).toBe(true);
        expect(plain?.method).toBe('REGISTER');
        expect(plain?.ruri_user).toBe(''); // REGISTER на адрес станции, user в From
        expect(plain?.call_id).toBe(REG);
        expect(plain?.has_digest).toBe(false);

        const digest = parse_sip_message(RAW_REGISTER_DIGEST);
        expect(digest?.has_digest).toBe(true);

        const inv = parse_sip_message(RAW_INVITE);
        expect(inv?.ruri_user).toBe('52');
        // Calling party number: user из From/To (проверка у вызываемого абонента).
        expect(inv?.from_user).toBe('9404');
        expect(inv?.to_user).toBe('52');
    });

    it('разбирает ответ: код, причина, метод транзакции из CSeq', () =>
    {
        const r = parse_sip_message(RAW_401);
        expect(r?.is_request).toBe(false);
        expect(r?.status).toBe(401);
        expect(r?.reason).toBe('Unauthorized');
        expect(r?.method).toBe('REGISTER'); // вид этапа — по CSeq
        expect(r?.call_id).toBe(REG);
    });

    it('не-SIP даёт null', () =>
    {
        expect(parse_sip_message('HELLO world')).toBeNull();
        expect(parse_sip_message('')).toBeNull();
    });

    it('on_sip_message фиксирует направление, этап, код и Call-ID', () =>
    {
        const j = new Journal({ reports_dir: '/unused' });
        j.on_sip_message('9404', 'in', RAW_401);
        const ev = j.events[0];
        expect(ev.direction).toBe('in');
        expect(ev.kind).toBe('register');
        expect(ev.sip_code).toBe(401);
        expect(ev.call_id).toBe(REG);
        expect(ev.detail).toContain('401 Unauthorized для REGISTER');
    });

    it('запрос-INVITE: detail содержит Calling party number (от <From>)', () =>
    {
        const j = new Journal({ reports_dir: '/unused' });
        j.on_sip_message('52', 'in', RAW_INVITE);
        expect(j.events[0].detail).toBe('INVITE → 52 от 9404');
    });

    it('мусор в сокете — событие sip-other, не исключение', () =>
    {
        const j = new Journal({ reports_dir: '/unused' });
        j.on_sip_message('9404', 'in', 'garbage-bytes');
        expect(j.events[0].kind).toBe('sip-other');
    });
});

// ---------- подписки ----------

describe('attach_phone', () =>
{
    it('логирует только смены состояния (патчи без смены — нет)', () =>
    {
        const j = new Journal({ reports_dir: '/unused' });
        const sm = new PhoneStateMachine();
        const off = j.attach_phone('9404', sm);
        expect(j.events).toHaveLength(1); // стартовый снапшот UNREGISTERED
        sm.patch({ registering: true });
        expect(j.events).toHaveLength(1);
        sm.set('REGISTERED');
        sm.set('CALL_OUT', { peer: '52' });
        sm.set('IN_CALL');
        sm.set('REGISTERED');
        off();
        const details = j.events.map((e) => e.detail);
        expect(details[0]).toContain('UNREGISTERED');
        expect(details[1]).toContain('REGISTERED');
        expect(details[2]).toContain('CALL_OUT');
        expect(details[2]).toContain('собеседник 52');
        expect(details[4]).toContain('REGISTERED');
        sm.set('CALL_OUT', { peer: '52' });
        expect(j.events).toHaveLength(5); // после off() — тишина
    });
});

describe('attach_transport', () =>
{
    /** Транспорт-заглушка: on() сохраняет колбэки, fire() дёргает их. */
    function fake_transport(): {
        t: Transport;
        fire: <K extends TransportEventName>(
            ev: K,
            ...args: Parameters<TransportEvents[K]>
        ) => void;
    }
    {
        const handlers = new Map<string, Array<(...a: never[]) => void>>();
        const t: Transport = {
            connect: () => Promise.resolve(),
            disconnect: () => Promise.resolve(),
            register: () => Promise.resolve({ ok: true, code: 0, text: '' }),
            unregister: () => Promise.resolve(),
            call: (): CallHandle =>
            {
                throw new Error('не нужен в тесте');
            },
            on: <K extends TransportEventName>(event: K, cb: TransportEvents[K]) =>
            {
                const list = handlers.get(event) ?? [];
                list.push(cb as (...a: never[]) => void);
                handlers.set(event, list);
                return () =>
                    handlers.set(
                        event,
                        list.filter((f) => f !== cb),
                    );
            },
        };
        return {
            t,
            fire: (ev, ...args) =>
            {
                for (const cb of handlers.get(ev) ?? [])
                    (cb as (...a: unknown[]) => void)(...args);
            },
        };
    }

    it('фиксирует вехи телефона: входящий, 180, 200+ACK, завершение, обрывы', () =>
    {
        const j = new Journal({ reports_dir: '/unused' });
        const { t, fire } = fake_transport();
        j.attach_transport('52', t);
        fire('incoming', '9404', {} as CallHandle);
        fire('ringing');
        fire('established');
        fire('terminated', 0);
        fire('transport-lost', 'Соединение потеряно');
        fire('registration-lost', 'Регистрация истекла');
        const kinds = j.events.map((e) => e.kind);
        expect(kinds).toEqual([
            'call-in',
            'ringing',
            'call-established',
            'call-ended',
            'transport-lost',
            'registration-lost',
        ]);
        expect(j.events[0].detail).toContain('INVITE от 9404');
        expect(j.events[1].sip_code).toBe(180);
        expect(j.events[2].sip_code).toBe(200);
        expect(j.events[3].detail).toContain('BYE');
        fire('terminated', 486);
        expect(j.events[6].kind).toBe('call-ended');
        expect(j.events[6].sip_code).toBe(486);
    });
});

// ---------- отчёты (критерий п.3) ----------

describe('render_report', () =>
{
    let tmp = '';
    beforeEach(() =>
    {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-report-'));
    });
    afterEach(() =>
    {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('по синтетическому логу создаёт json+md+html в temp-каталог', () =>
    {
        const j = new Journal({ reports_dir: tmp });
        fill_full_chain(j);
        const files = j.render_report(META);
        for (const p of [files.json_path, files.md_path, files.html_path])
        {
            expect(fs.existsSync(p), p).toBe(true);
            expect(fs.statSync(p).size).toBeGreaterThan(0);
        }
        expect(fs.readdirSync(tmp)).toHaveLength(3);
        expect(files.id).toMatch(/^\d{8}T\d{6}Z_case_2$/);
        expect(path.basename(files.html_path)).toBe(`${files.id}.html`);
    });

    it('json — полный журнал с шапкой стенда', () =>
    {
        const j = new Journal({ reports_dir: tmp });
        fill_full_chain(j);
        const files = j.render_report(META);
        const data = JSON.parse(fs.readFileSync(files.json_path, 'utf8'));
        expect(data.meta.pbx_host).toBe('192.168.80.157');
        expect(data.meta.verdict).toBe('PASS');
        expect(data.events).toHaveLength(14);
        expect(data.events[1]).toMatchObject({
            kind: 'register',
            sip_code: 401,
            direction: 'in',
        });
    });

    it('HTML содержит все этапы цепочки и вердикт', () =>
    {
        const j = new Journal({ reports_dir: tmp });
        fill_full_chain(j);
        const files = j.render_report(META);
        const html = fs.readFileSync(files.html_path, 'utf8');
        for (const stage of [
            'register', // REGISTER
            'register 401', // challenge
            'register 200', // итог регистрации
            'invite', // INVITE
            'invite 100',
            'invite 180',
            'invite 200',
            'ack', // 200+ACK
            'bye', // сброс
            'invite 486', // отклонение
            'cancel',
            'cancel 487', // CANCEL → 487
            'invite 480', // не-ответ
        ])
        {
            expect(html, `этап «${stage}» в HTML`).toContain(
                `<td class="stage">${stage}</td>`,
            );
        }
        expect(html).toContain('192.168.80.157:5060 (udp)');
        expect(html).toContain('9404, 52, 3203');
        expect(html).toContain('Вердикт: PASS');
        expect(html).toContain(REG); // Call-ID в таблице
    });

    it('md — таблица этапов и вердикт', () =>
    {
        const j = new Journal({ reports_dir: tmp });
        fill_full_chain(j);
        const files = j.render_report(META);
        const md = fs.readFileSync(files.md_path, 'utf8');
        expect(md).toContain('| # | Время |');
        expect(md).toContain('| register | 401 |'); // этап и код — соседние колонки
        expect(md).toContain('**Вердикт: PASS**');
    });

    it('шапка содержит участники вызовов: от кого и кому', () =>
    {
        const j = new Journal({ reports_dir: tmp });
        fill_full_chain(j);
        const files = j.render_report({
            ...META,
            calls: [
                { from: '9404', to: '52', direction: 'out' },
                { from: '52', to: '9404', direction: 'in' },
            ],
        });
        const html = fs.readFileSync(files.html_path, 'utf8');
        const md = fs.readFileSync(files.md_path, 'utf8');
        for (const text of [html, md])
        {
            expect(text).toContain('Вызов (исходящий): от 9404 → кому 52');
            expect(text).toContain('Вызов (входящий): от 52 → кому 9404');
        }
        const data = JSON.parse(fs.readFileSync(files.json_path, 'utf8'));
        expect(data.meta.calls).toEqual([
            { from: '9404', to: '52', direction: 'out' },
            { from: '52', to: '9404', direction: 'in' },
        ]);
    });

    it('без meta.calls шапка не меняется (обратная совместимость п.3)', () =>
    {
        const j = new Journal({ reports_dir: tmp });
        fill_full_chain(j);
        const html = fs.readFileSync(j.render_report(META).html_path, 'utf8');
        expect(html).not.toContain('Вызов (');
    });

    it('коллизия имён (одна секунда) даёт уникальный id _2', () =>
    {
        let t = 1_761_560_000_000;
        const j = new Journal({ reports_dir: tmp, now: () => t });
        j.log('9404', 'out', 'register');
        const first = j.render_report(META);
        const second = j.render_report(META);
        expect(second.id).toBe(`${first.id}_2`);
        expect(fs.readdirSync(tmp)).toHaveLength(6);
        t += 1000;
        const third = j.render_report(META);
        expect(third.id).toContain(utc_stamp(t));
    });

    it('пустой журнал рендерится без падения', () =>
    {
        const j = new Journal({ reports_dir: tmp });
        const files = j.render_report({
            ...META,
            verdict: 'FAIL',
            verdict_text: 'событий нет',
        });
        const html = fs.readFileSync(files.html_path, 'utf8');
        expect(html).toContain('журнал пуст');
        expect(html).toContain('Вердикт: FAIL');
    });
});
