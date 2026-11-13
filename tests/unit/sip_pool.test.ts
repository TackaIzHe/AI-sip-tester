// Юнит-тесты пула виртуальных абонентов (plan_2.md п.4) — без сети:
// транспорт подставляется мок-фабрикой (DI-точка PoolTransportFactory),
// события станции имитируются вызовами fire()/trace().
// Покрыто: регистрация (успех/идемпотентность/отказ), запрет 3203,
// исходящий/входящий вызовы, answer/reject(код)/hangup, реестр
// call_id→{from,to,state} с захватом Call-ID из сырого INVITE, журнал.

import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../server/config';
import { Journal } from '../../server/journal';
import { PoolError, SipSubscriberPool, type SipPool } from '../../server/sip_pool';
import type { PhoneConfig } from '../../server/sip/config';
import type {
    CallHandle,
    RegResult,
    Transport,
    TransportEventName,
    TransportEvents,
} from '../../server/sip/transport';

// ---------- конфиг стенда (образец .env.example) ----------

const APP: AppConfig = {
    server_port: 3000,
    pbx_host: '192.168.80.157',
    pbx_port: 5060,
    sip_protocol: 'udp',
    bridge_host: '192.168.80.159',
    bridge_port: 8090,
    station_host: '127.0.0.1',
    station_port: 5060,
    station_proto: 'both',
    subscribers: [
        { number: '9404', password: '123', can_register: true },
        { number: '52', password: '321', can_register: true },
        { number: '3203', password: '123', can_register: false },
    ],
};

// ---------- мок-транспорт ----------

/** Транспорт-двойник: события дёргаются вручную (fire/trace), REGISTER — по reg. */
class FakeTransport implements Transport
{
    readonly handlers = new Map<string, Array<(...a: unknown[]) => void>>();
    connected = false;
    disconnected = false;
    reg_calls = 0;
    invite_to = '';
    readonly actions: string[] = [];

    constructor(
        readonly cfg: PhoneConfig,
        private reg: () => RegResult,
        private on_trace: (direction: 'in' | 'out', message: string) => void,
    )
    {}

    connect(): Promise<void>
    {
        this.connected = true;
        return Promise.resolve();
    }
    disconnect(): Promise<void>
    {
        this.disconnected = true;
        return Promise.resolve();
    }
    register(): Promise<RegResult>
    {
        this.reg_calls += 1;
        return Promise.resolve(this.reg());
    }
    unregister(): Promise<void>
    {
        return Promise.resolve();
    }
    call(target: string): CallHandle
    {
        this.invite_to = target;
        return this.handle('out');
    }
    on<K extends TransportEventName>(event: K, cb: TransportEvents[K]): () => void
    {
        const list = this.handlers.get(event) ?? [];
        list.push(cb as (...a: unknown[]) => void);
        this.handlers.set(event, list);
        return () =>
        {
            const i = list.indexOf(cb as (...a: unknown[]) => void);
            if (i >= 0) list.splice(i, 1);
        };
    }
    /** Дёрнуть событие транспорта (как это делает sip.js). */
    fire<K extends TransportEventName>(
        event: K,
        ...args: Parameters<TransportEvents[K]>
    ): void
    {
        for (const cb of [...(this.handlers.get(event) ?? [])])
            (cb as (...a: unknown[]) => void)(...args);
    }
    /** Прогнать сырое сообщение через on_trace (как сокет в ClassicTransport). */
    trace(direction: 'in' | 'out', raw: string): void
    {
        this.on_trace(direction, raw);
    }
    /** Handle с фиксацией действий — для входящих из теста. */
    handle(dir: string): CallHandle
    {
        const a = this.actions;
        return {
            answer: () => (a.push(`${dir}:answer`), Promise.resolve()),
            reject: (code = 486) => (a.push(`${dir}:reject ${code}`), Promise.resolve()),
            cancel: () => (a.push(`${dir}:cancel`), Promise.resolve()),
            bye: () => (a.push(`${dir}:bye`), Promise.resolve()),
            wait_terminated: () => Promise.resolve(),
        };
    }
}

/** Сборка пула на моках: fakes — транспорты по номерам, created — счётчик сборок. */
function harness(reg: () => RegResult = () => ({ ok: true, code: 0, text: '' }))
{
    const journal = new Journal({ reports_dir: '/unused-sip-pool-test' });
    const fakes = new Map<string, FakeTransport>();
    let created = 0;
    const pool: SipPool = new SipSubscriberPool(APP, journal, (cfg, on_trace) =>
    {
        created += 1;
        const t = new FakeTransport(cfg, reg, on_trace);
        fakes.set(cfg.number, t);
        return t;
    });
    return { pool, journal, fakes, created: () => created };
}

const OK: RegResult = { ok: true, code: 0, text: '' };

// ---------- сырые SIP-сообщения ----------

function sip(first: string, headers: Record<string, string>): string
{
    const h = Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');
    return `${first}\r\n${h}\r\n\r\n`;
}

const RAW_REGISTER = sip('REGISTER sip:192.168.80.157:5060 SIP/2.0', {
    From: '<sip:9404@192.168.80.157>;tag=aa',
    To: '<sip:9404@192.168.80.157>',
    'Call-ID': 'reg-1@192.168.80.159',
    CSeq: '1 REGISTER',
    'Content-Length': '0',
});

const RAW_401 = sip('SIP/2.0 401 Unauthorized', {
    From: '<sip:9404@192.168.80.157>;tag=aa',
    To: '<sip:9404@192.168.80.157>;tag=b1',
    'Call-ID': 'reg-1@192.168.80.159',
    CSeq: '1 REGISTER',
    'Content-Length': '0',
});

function out_invite(to: string, cid: string): string
{
    return sip(`INVITE sip:${to}@192.168.80.157:5060 SIP/2.0`, {
        From: '<sip:9404@192.168.80.157>;tag=aa',
        To: `<sip:${to}@192.168.80.157>`,
        'Call-ID': cid,
        CSeq: '2 INVITE',
        'Content-Length': '0',
    });
}

function in_invite(cid: string): string
{
    return sip('INVITE sip:52@192.168.80.159:6001 SIP/2.0', {
        From: '<sip:9404@192.168.80.157>;tag=aa',
        To: '<sip:52@192.168.80.159>',
        'Call-ID': cid,
        CSeq: '2 INVITE',
        'Content-Length': '0',
    });
}

// ---------- регистрация ----------

describe('sip_pool: регистрация', () =>
{
    it(
        'успешный REGISTER → REGISTERED, ' + 'креды из AppConfig, события в журнале',
        async () =>
        {
            const { pool, journal, fakes, created } = harness(() => OK);
            const res = await pool.register_subscriber('9404');
            expect(res).toEqual({ number: '9404', ok: true, code: 0, text: '' });
            expect(created()).toBe(1);
            expect(fakes.get('9404')!.cfg).toMatchObject({
                host: '192.168.80.157',
                sip_port: 5060,
                number: '9404',
                password: '123',
                transport: 'udp',
            });
            // сырая цепочка регистрации уходит в журнал через on_trace транспорта
            const t = fakes.get('9404')!;
            t.trace('out', RAW_REGISTER);
            t.trace('in', RAW_401);
            const ev = journal.events;
            expect(ev.some((e) => e.kind === 'register' && e.direction === 'out')).toBe(
                true,
            );
            expect(
                ev.some(
                    (e) =>
                        e.kind === 'register' &&
                        e.sip_code === 401 &&
                        e.direction === 'in',
                ),
            ).toBe(true);
            expect(
                ev.some((e) => e.kind === 'state' && e.detail.includes('REGISTERED')),
            ).toBe(true);
        },
    );

    it('повторный register идемпотентен: без нового транспорта и REGISTER', async () =>
    {
        const { pool, fakes, created } = harness(() => OK);
        await pool.register_subscriber('9404');
        const t = fakes.get('9404')!;
        const again = await pool.register_subscriber('9404');
        expect(again.ok).toBe(true);
        expect(created()).toBe(1);
        expect(fakes.get('9404')).toBe(t);
        expect(t.reg_calls).toBe(1);
    });

    it(
        'отказ станции (401) → PoolError с кодом, ' + 'абонент остаётся UNREGISTERED',
        async () =>
        {
            const { pool } = harness(() => ({
                ok: false,
                code: 401,
                text: 'Станция отвергла регистрацию',
            }));
            const err = await pool.register_subscriber('9404').catch((e) => e);
            expect(err).toBeInstanceOf(PoolError);
            expect((err as PoolError).code).toBe(401);
            expect(pool.list_subscribers()[0]).toMatchObject({
                number: '9404',
                state: 'UNREGISTERED',
            });
        },
    );

    it('3203 — только цель вызова: регистрация запрещена', async () =>
    {
        const { pool, fakes } = harness(() => OK);
        const err = await pool.register_subscriber('3203').catch((e) => e);
        expect(err).toBeInstanceOf(PoolError);
        expect(fakes.has('3203')).toBe(false);
        expect(pool.list_subscribers()[2]).toMatchObject({
            number: '3203',
            can_register: false,
            state: 'ABSENT',
        });
    });

    it('unregister → транспорт закрыт, абонент исчезает из пула', async () =>
    {
        const { pool, fakes } = harness(() => OK);
        await pool.register_subscriber('9404');
        const t = fakes.get('9404')!;
        await pool.unregister('9404');
        expect(t.disconnected).toBe(true);
        expect(pool.list_subscribers()[0].state).toBe('ABSENT');
        await pool.unregister('9404'); // no-op без падения
    });

    it('close() graceful-снимает всех зарегистрированных', async () =>
    {
        const { pool, fakes } = harness(() => OK);
        await pool.register_subscriber('9404');
        await pool.register_subscriber('52');
        await pool.close();
        expect(fakes.get('9404')!.disconnected).toBe(true);
        expect(fakes.get('52')!.disconnected).toBe(true);
        expect(pool.list_subscribers().every((s) => s.state === 'ABSENT')).toBe(true);
    });
});

// ---------- вызовы и реестр ----------

describe('sip_pool: вызовы и реестр', () =>
{
    /** Зарегистрировать 9404 и 52 на моке. */
    async function registered(h: ReturnType<typeof harness>)
    {
        await h.pool.register_subscriber('9404');
        await h.pool.register_subscriber('52');
        return h;
    }

    it('исходящий: tmp-id → Call-ID из сырого INVITE, состояния в реестре', async () =>
    {
        const h = await registered(harness(() => OK));
        const rec = h.pool.call('9404', '52');
        expect(rec).toMatchObject({
            from: '9404',
            to: '52',
            direction: 'out',
            owner: '9404',
            state: 'PENDING',
            ended_at: 0,
        });
        expect(rec.call_id).toMatch(/^tmp:9404-\d+$/);
        expect(h.fakes.get('9404')!.invite_to).toBe('52');
        expect(h.pool.get_call(rec.call_id)).toBe(rec);

        h.fakes.get('9404')!.trace('out', out_invite('52', 'call-9@pbx'));
        expect(rec.call_id).toBe('call-9@pbx');
        expect(rec.state).toBe('CALL_OUT');
        expect(h.pool.get_call('call-9@pbx')).toBe(rec);

        h.fakes.get('9404')!.fire('established');
        expect(rec.state).toBe('IN_CALL');
        h.fakes.get('9404')!.fire('terminated', 0);
        expect(rec.state).toBe('REGISTERED');
        expect(rec.ended_at).toBeGreaterThan(0);
        // вехи вызова — в журнале (attach_transport + on_sip_message)
        const kinds = h.journal.events.map((e) => e.kind);
        expect(kinds).toContain('invite');
        expect(kinds).toContain('call-established');
        expect(kinds).toContain('call-ended');
    });

    it(
        'входящий: запись from→наш номер, ' + 'answer → IN_CALL, реестр обновляется',
        async () =>
        {
            const h = await registered(harness(() => OK));
            const t52 = h.fakes.get('52')!;
            t52.fire('incoming', '9404', t52.handle('in'));
            t52.trace('in', in_invite('call-10@pbx'));
            const rec = h.pool.list_calls().find((r) => r.direction === 'in')!;
            expect(rec).toMatchObject({
                from: '9404',
                to: '52',
                owner: '52',
                state: 'CALL_IN',
            });
            expect(rec.call_id).toBe('call-10@pbx');

            h.pool.answer('52');
            expect(t52.actions).toContain('in:answer');
            t52.fire('established');
            expect(rec.state).toBe('IN_CALL');
        },
    );

    it(
        'reject: код уходит в handle (486 по умолчанию, 603 явно), ' +
            'вызов завершается',
        async () =>
        {
            const h = await registered(harness(() => OK));
            const t52 = h.fakes.get('52')!;
            const t94 = h.fakes.get('9404')!;
            t52.fire('incoming', '9404', t52.handle('in'));
            t94.fire('incoming', '52', t94.handle('in'));

            h.pool.reject('52'); // 486 по умолчанию
            h.pool.reject('9404', 603); // явно
            expect(t52.actions).toContain('in:reject 486');
            expect(t94.actions).toContain('in:reject 603');

            t52.fire('terminated', 486);
            const rec = h.pool
                .list_calls()
                .find((r) => r.to === '52' && r.direction === 'in')!;
            expect(rec.state).toBe('REGISTERED');
            expect(rec.ended_at).toBeGreaterThan(0);
        },
    );

    it('hangup: BYE в разговоре; без вызова — PoolError', async () =>
    {
        const h = await registered(harness(() => OK));
        h.pool.call('9404', '52');
        h.fakes.get('9404')!.fire('established');
        h.pool.hangup('9404');
        expect(h.fakes.get('9404')!.actions).toContain('out:bye');
        expect(() => h.pool.hangup('52')).toThrow(PoolError);
    });

    it(
        'ошибки: незарегистрированный звонящий, ' + 'звонок себе, неизвестный номер',
        async () =>
        {
            const h = await registered(harness(() => OK));
            await h.pool.unregister('9404');
            expect(() => h.pool.call('9404', '52')).toThrow(/не зарегистрирован/);
            expect(() => h.pool.call('52', '52')).toThrow(/самому себе/);
            expect(() => h.pool.call('9999', '52')).toThrow(/Неизвестный абонент/);
            expect(() => h.pool.answer('9999')).toThrow(PoolError);
        },
    );

    it('ответ на NOT incoming и отбой без вызова — PoolError', async () =>
    {
        const h = await registered(harness(() => OK));
        expect(() => h.pool.answer('52')).toThrow(/нет входящего вызова/);
        expect(() => h.pool.reject('52')).toThrow(/нет входящего вызова/);
        expect(() => h.pool.hangup('52')).toThrow(/нет активного вызова/);
    });

    // HTTP-статусы (п.5): контроллеры не разбирают текст ошибок — error_handler
    // берёт err.status; здесь проверяем, что пул проставил его верно.
    it('PoolError.status (HTTP для error_handler, plan_2.md п.5)', async () =>
    {
        const h = await registered(harness(() => OK));
        async function status_of(f: () => unknown): Promise<number>
        {
            try
            {
                await f();
            }
            catch (e)
            {
                expect(e).toBeInstanceOf(PoolError);
                return (e as PoolError).status; // тип уже подтверждён assert'ом выше
            }
            return -1;
        }
        expect(await status_of(() => h.pool.call('9999', '52'))).toBe(404); // неизвестный
        expect(await status_of(() => h.pool.call('52', '52'))).toBe(400); // себе
        expect(await status_of(() => h.pool.answer('52'))).toBe(409); // нет входящего
        // только цель
        expect(await status_of(() => h.pool.register_subscriber('3203'))).toBe(403);
        await h.pool.unregister('9404');
        // не зарегистрирован
        expect(await status_of(() => h.pool.call('9404', '52'))).toBe(409);
        const bad = harness(() => ({ ok: false, code: 403, text: 'Forbidden' }));
        // отказ станции
        expect(await status_of(() => bad.pool.register_subscriber('9404'))).toBe(502);
    });
});
