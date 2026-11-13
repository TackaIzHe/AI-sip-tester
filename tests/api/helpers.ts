// Общие помощники api-тестов (plan_2.md п.9): мок пула через DI (без сети),
// типовой конфиг стенда по образцу .env.example и temp-каталоги. Файл НЕ
// *.test.ts — vitest его не запускает, только импортирует.
//
// Мок реализует DI-контракт SipPool (server/sip_pool.ts) и имитирует станцию
// детерминированно: REGISTER → 200 (без challenge, как на стенде), вызов с
// доставкой на вторую ногу, отказ станции при вызове незарегистрированного.
// Сырые SIP-сообщения гоняются через Journal.on_sip_message — кейсы e2e-раннера
// (POST /api/test_runs) ассертят именно по этапам журнала, поэтому мок обязан
// их производить, а не только менять состояния.
// related: tests/api/*.test.ts, doc/sip_rfc.md §5.10/§5.8/§5.9/§7.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Express } from 'express';
import { create_app } from '../../server/app';
import type { AppConfig, SubscriberConfig } from '../../server/config';
import { Journal } from '../../server/journal';
import {
    PoolError,
    type CallRecord,
    type RegisterOutcome,
    type SipPool,
    type SubscriberStatus,
} from '../../server/sip_pool';
import type { StationOutboundApi } from '../../server/station/outbound';
import type { RegistrationsApi } from '../../server/station/registrations';
import type { StationSasApi } from '../../server/station/sas';
import type { StationStimulusApi } from '../../server/station/stimulus';
import type { Station } from '../../server/station/station';

/** Конфиг стенда — тот же образец, что в .env.example (сети мок не трогает). */
export const API_CONFIG: AppConfig = {
    server_port: 3000,
    pbx_host: '192.168.80.157',
    pbx_port: 5060,
    sip_protocol: 'udp',
    bridge_host: '192.168.80.159',
    bridge_port: 8090,
    // Станция — адреса из конфига достаточно: мок слушатель не поднимает.
    station_host: '192.168.80.159',
    station_port: 5060,
    station_proto: 'both',
    subscribers: [
        { number: '9404', password: '123', can_register: true },
        { number: '52', password: '321', can_register: true },
        { number: '3203', password: '123', can_register: false },
    ],
};

/** Новый temp-каталог (дерево файлов / отчёты) — удалять в afterAll. */
export function temp_dir(): { dir: string; cleanup: () => void }
{
    const dir = mkdtempSync(join(tmpdir(), 'sip-api-'));
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Строка SIP-сообщения (первая строка + заголовки + пустая строка). */
function sip(first: string, headers: Record<string, string>): string
{
    return [first, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', ''].join(
        '\r\n',
    );
}

/**
 * Мок пула (DI-контракт SipPool, п.4.2). Имитация станции:
 *  - register_subscriber: REGISTER → 200 (идемпотентен при REGISTERED);
 *    reject_register=true → PoolError(401, 502) — станция отвергла;
 *  - call: пара записей (нога вызывающего CALL_OUT + входящий CALL_IN у
 *    вызываемого) с общими терминами; 3203 проксируется на 52 (как стенд);
 *    вызов незарегистрированного завершается отказом станции 502;
 *  - answer/reject/hangup меняют обе ноги и пишут этапы в journal.
 */
export class MockPool implements SipPool
{
    private states = new Map<string, SubscriberStatus['state']>();
    private calls = new Map<string, CallRecord>();
    /** in-call_id → out-call_id: парная нога для терминации обеих. */
    private pairs = new Map<string, string>();
    private seq = 0;

    constructor(
        private readonly config: AppConfig = API_CONFIG,
        private readonly journal?: Journal,
        /** true → register_subscriber бросает PoolError(502, sip 401). */
        private readonly reject_register = false,
    )
    {}

    async register_subscriber(number: string): Promise<RegisterOutcome>
    {
        const sub = this.find_sub(number);
        if (!sub.can_register)
        {
            throw new PoolError(
                `Абонент ${number} — только цель вызова, ` +
                    `регистрация запрещена (plan_2.md)`,
                0,
                403,
            );
        }
        if (this.states.get(number) === 'REGISTERED')
            return { number, ok: true, code: 0, text: '' };
        if (this.reject_register)
            throw new PoolError(`Станция отвергла REGISTER ${number}`, 401, 502);
        this.seq += 1;
        const cid = `reg-${this.seq}@pbx`;
        this.journal?.on_sip_message(
            number,
            'out',
            sip(`REGISTER sip:${number}@pbx SIP/2.0`, {
                'Call-ID': cid,
                CSeq: '1 REGISTER',
            }),
        );
        this.journal?.on_sip_message(
            number,
            'in',
            sip('SIP/2.0 200 OK', { 'Call-ID': cid, CSeq: '1 REGISTER' }),
        );
        this.states.set(number, 'REGISTERED');
        return { number, ok: true, code: 0, text: '' };
    }

    async unregister(number: string): Promise<void>
    {
        this.find_sub(number); // неизвестный номер — та же ошибка, что у пула
        if (this.states.has(number)) this.states.set(number, 'UNREGISTERED');
    }

    call(from: string, to: string): CallRecord
    {
        const sub = this.find_sub(from);
        if (!sub.can_register)
            throw new PoolError(
                `Абонент ${from} не может звонить (не регистрируется)`,
                0,
                403,
            );
        if (from === to) throw new PoolError('Нельзя звонить самому себе', 0, 400);
        if (this.states.get(from) !== 'REGISTERED')
        {
            throw new PoolError(
                `Абонент ${from} не зарегистрирован ` +
                    `(состояние ${this.states.get(from) ?? 'ABSENT'})`,
                0,
                409,
            );
        }
        const active = this.active_of(from);
        if (active)
        {
            throw new PoolError(
                `Абонент ${from} уже в вызове (${active.from}→${active.to})`,
                0,
                409,
            );
        }
        this.seq += 1;
        const out: CallRecord = {
            call_id: `mock-${this.seq}@pbx`,
            from,
            to,
            state: 'CALL_OUT',
            direction: 'out',
            owner: from,
            ended_at: 0,
        };
        this.calls.set(out.call_id, out);
        this.journal?.on_sip_message(
            from,
            'out',
            sip(`INVITE sip:${to}@pbx SIP/2.0`, {
                'Call-ID': out.call_id,
                CSeq: '1 INVITE',
            }),
        );

        // Маршрутизация станции: 3203 — прокси на абонента 2 (цепочка 9404→3203→52).
        const proxy = this.config.subscribers[2].number;
        const target = to === proxy ? this.config.subscribers[1].number : to;
        const deliver =
            this.find_sub_opt(target) && this.states.get(target) === 'REGISTERED';
        if (!deliver)
        {
            // Стенд на незарегистрированного: финальный отказ (502), вызов завершён.
            this.journal?.on_sip_message(
                from,
                'in',
                sip('SIP/2.0 502 Bad Gateway', {
                    'Call-ID': out.call_id,
                    CSeq: '1 INVITE',
                }),
            );
            this.finish(out, 'REGISTERED');
            return out;
        }
        this.journal?.on_sip_message(
            from,
            'in',
            sip('SIP/2.0 180 Ringing', { 'Call-ID': out.call_id, CSeq: '1 INVITE' }),
        );
        const inbound: CallRecord = {
            call_id: `mock-${this.seq}-in@pbx`,
            from,
            to: target,
            state: 'CALL_IN',
            direction: 'in',
            owner: target,
            ended_at: 0,
        };
        this.calls.set(inbound.call_id, inbound);
        this.pairs.set(inbound.call_id, out.call_id);
        this.pairs.set(out.call_id, inbound.call_id);
        this.journal?.on_sip_message(
            target,
            'in',
            sip(`INVITE sip:${target}@pbx SIP/2.0`, {
                'Call-ID': inbound.call_id,
                CSeq: '1 INVITE',
            }),
        );
        return out;
    }

    answer(number: string): void
    {
        const rec = this.incoming_of(number);
        const out = this.pair_of(rec);
        for (const leg of [rec, out]) if (leg) leg.state = 'IN_CALL';
        const cid = rec.call_id;
        this.journal?.on_sip_message(
            number,
            'out',
            sip('SIP/2.0 200 OK', { 'Call-ID': cid, CSeq: '1 INVITE' }),
        );
        if (out)
        {
            this.journal?.on_sip_message(
                out.from,
                'in',
                sip('SIP/2.0 200 OK', { 'Call-ID': out.call_id, CSeq: '1 INVITE' }),
            );
            this.journal?.on_sip_message(
                out.from,
                'out',
                sip(`ACK sip:${out.to}@pbx SIP/2.0`, {
                    'Call-ID': out.call_id,
                    CSeq: '1 ACK',
                }),
            );
        }
        this.journal?.on_sip_message(
            number,
            'in',
            sip(`ACK sip:${number}@pbx SIP/2.0`, { 'Call-ID': cid, CSeq: '1 ACK' }),
        );
    }

    reject(number: string, code = 486): void
    {
        const rec = this.incoming_of(number);
        const out = this.pair_of(rec);
        this.journal?.on_sip_message(
            number,
            'out',
            sip(`SIP/2.0 ${code} Rejected`, { 'Call-ID': rec.call_id, CSeq: '1 INVITE' }),
        );
        if (out)
            this.journal?.on_sip_message(
                out.from,
                'in',
                sip(`SIP/2.0 ${code} Rejected`, {
                    'Call-ID': out.call_id,
                    CSeq: '1 INVITE',
                }),
            );
        this.finish(rec, 'REGISTERED');
        if (out) this.finish(out, 'REGISTERED');
    }

    hangup(number: string): void
    {
        const rec = this.active_of(number);
        if (!rec)
            throw new PoolError(`У абонента ${number} нет активного вызова`, 0, 409);
        const out = this.pair_of(rec) ?? rec;
        this.journal?.on_sip_message(
            number,
            'out',
            sip(`BYE sip:${rec.to}@pbx SIP/2.0`, {
                'Call-ID': rec.call_id,
                CSeq: '1 BYE',
            }),
        );
        const mate = rec === out ? this.pair_of(rec) : rec;
        if (mate && mate !== rec)
        {
            this.journal?.on_sip_message(
                mate.owner,
                'in',
                sip(`BYE sip:${mate.to}@pbx SIP/2.0`, {
                    'Call-ID': mate.call_id,
                    CSeq: '1 BYE',
                }),
            );
            this.finish(mate, 'REGISTERED');
        }
        this.finish(rec, 'REGISTERED');
    }

    list_subscribers(): SubscriberStatus[]
    {
        return this.config.subscribers.map((s) => ({
            number: s.number,
            can_register: s.can_register,
            state: this.states.get(s.number) ?? 'ABSENT',
            peer: '',
            error: '',
            registering: false,
        }));
    }

    list_calls(): CallRecord[]
    {
        return [...this.calls.values()];
    }
    get_call(id: string): CallRecord | undefined
    {
        return this.calls.get(id);
    }

    async close(): Promise<void>
    {
        for (const n of this.states.keys()) this.states.set(n, 'UNREGISTERED');
    }

    // ---------- внутреннее ----------

    private find_sub_opt(number: string): SubscriberConfig | undefined
    {
        return this.config.subscribers.find((s) => s.number === number);
    }

    private find_sub(number: string): SubscriberConfig
    {
        const sub = this.find_sub_opt(number);
        if (!sub) throw new PoolError(`Неизвестный абонент ${number}`, 0, 404);
        return sub;
    }

    private active_of(owner: string): CallRecord | undefined
    {
        return this.list_calls().find((c) => c.owner === owner && c.ended_at === 0);
    }

    private incoming_of(number: string): CallRecord
    {
        const rec = this.list_calls().find(
            (c) => c.owner === number && c.state === 'CALL_IN' && c.ended_at === 0,
        );
        if (!rec)
            throw new PoolError(`У абонента ${number} нет входящего вызова`, 0, 409);
        return rec;
    }

    private pair_of(rec: CallRecord): CallRecord | undefined
    {
        const id = this.pairs.get(rec.call_id);
        return id ? this.calls.get(id) : undefined;
    }

    /** Терминация ноги: состояние вызывающего после отказа/отбоя — REGISTERED. */
    private finish(rec: CallRecord, state: CallRecord['state']): void
    {
        rec.state = state;
        rec.ended_at = Date.now();
    }
}

/** Собрать приложение с моком пула и temp-каталогами (без listen, без сети). */
export function make_api_app(over: {
    root: string;
    pool?: MockPool;
    journal?: Journal;
    config?: AppConfig;
    /** Мок станции (plan_4.md); нет — /api/station не монтируется (404). */
    station?: Station;
    /** Мок стимульного движка (doc/task_26); нет — /stimulus* → 404. */
    stimulus?: StationStimulusApi;
    /** Мок SAS-движка (план 6); нет — /sas* → 404. */
    sas?: StationSasApi;
    /** Мок движка исходящего вызова (doc/task_30_plan_2.md); нет — /call* → 404. */
    outbound?: StationOutboundApi;
    /** Хранилище регистраций (doc/task_33_plan_2.md, обычно реальное);
     * нет — /registrations* → 404. */
    registrations?: RegistrationsApi;
}): { app: Express; pool: MockPool; journal: Journal }
{
    const journal =
        over.journal ?? new Journal({ reports_dir: join(over.root, 'reports') });
    const pool = over.pool ?? new MockPool(over.config ?? API_CONFIG, journal);
    const app = create_app({
        config: over.config ?? API_CONFIG,
        pool,
        journal,
        files_root: over.root,
        reports_dir: join(over.root, 'reports'),
        public_dir: join(over.root, 'public'),
        station: over.station,
        stimulus: over.stimulus,
        sas: over.sas,
        outbound: over.outbound,
        registrations: over.registrations,
    });
    return { app, pool, journal };
}

/** Дождаться условия (прогон в очереди test_runs завершается асинхронно). */
export async function wait_until(
    pred: () => boolean,
    timeout_ms = 3000,
): Promise<boolean>
{
    const deadline = Date.now() + timeout_ms;
    while (Date.now() < deadline)
    {
        if (pred()) return true;
        await new Promise((r) => setTimeout(r, 10));
    }
    return pred();
}
