// Пул виртуальных абонентов (plan_2.md п.4): на каждого абонента из .env —
// один SipPhoneClient + ClassicTransport (параметры станции из AppConfig),
// все события — в Journal (п.3). Пул знает про стейт-машину и транспорт, но
// НЕ знает про express/мост: REST-контроллеры (п.5) и e2e-раннер (п.8)
// работают через DI-интерфейс SipPool (мок в api-тестах, п.9).
//
// Реестр вызовов (п.4.2): call_id → CallRecord{from,to,state}. Call-ID берётся
// из сырого INVITE (hook on_trace, п.3): до выхода INVITE в сокет запись
// живёт под временным id `tmp:<номер>-<n>`, затем переключается на Call-ID.
// Инварианты: абонент 3 (3203) не регистрируется (конфиг can_register);
// один абонент — не более одного активного вызова (стейт-машина).

import type { AppConfig, SubscriberConfig } from './config';
import { Journal } from './journal';
import { parse_sip_message } from './journal';
import { ClassicTransport } from './sip/classic_transport';
import type { PhoneConfig } from './sip/config';
import { PhoneStateMachine, type PhoneSnapshot, type PhoneState } from './sip/state';
import { SipPhoneClient } from './sip/sip_client';
import type { CallHandle, RegResult, Transport } from './sip/transport';

/** Активные (не завершённые) состояния вызова. */
const CALL_STATES: readonly PhoneState[] = ['CALL_OUT', 'CALL_IN', 'IN_CALL'];

/**
 * Ошибка пула: контроллер (п.5) превращает её в 4xx/5xx (поле `status` —
 * HTTP-код, проставлен в месте броска по смыслу ошибки; `code` — SIP-код
 * станции, если она отозвалась), раннер (п.8) — в FAIL.
 */
export class PoolError extends Error
{
    constructor(
        message: string,
        readonly code = 0,
        readonly status = 500,
    )
    {
        super(message);
        this.name = 'PoolError';
    }
}

/** Диапазон состояний абонента для REST/терминала: к конфигу — плюс стейт машины. */
export interface SubscriberStatus
{
    number: string;
    /** Разрешена ли регистрация (3203 — false, только цель вызова). */
    can_register: boolean;
    /** UNREGISTERED без записи пула — абонент ещё не регистрировался. */
    state: PhoneState | 'ABSENT';
    peer: string;
    error: string;
    registering: boolean;
}

/** Запись реестра вызовов (п.4.2): id — Call-ID (или tmp-id до выхода INVITE). */
export interface CallRecord
{
    call_id: string;
    from: string;
    to: string;
    /** Состояние серверной ноги вызова (стейт-машина нашего абонента). */
    state: PhoneState | 'PENDING';
    /** Кто инициировал: out — наш вызов, in — входящий на нашего абонента. */
    direction: 'out' | 'in';
    /** Номер нашего абонента — серверная нога диалога. */
    owner: string;
    /** Метка завершения, мс; 0 — вызов активен. */
    ended_at: number;
}

/** Итог регистрации (по финальному ответу станции, инвариант BUG-1). */
export interface RegisterOutcome
{
    number: string;
    ok: boolean;
    code: number;
    text: string;
}

/**
 * DI-контракт пула (п.4.2): REST-контроллеры и e2e-раннер зависят только от
 * него — в api-тестах (п.9) подставляется мок без сети.
 */
export interface SipPool
{
    /** Регистрация абонента; повторный вызов при REGISTERED идемпотентен. */
    register_subscriber(number: string): Promise<RegisterOutcome>;
    /** REGISTER expires=0 + закрытие транспорта; нет записи — no-op. */
    unregister(number: string): Promise<void>;
    /** INVITE from→to; возвращает запись реестра (call_id — до INVITE tmp-id). */
    call(from: string, to: string): CallRecord;
    /** 200 OK на входящий вызов абонента. */
    answer(number: string): void;
    /** Отклонение входящего (по умолчанию 486 Busy Here, doc/sip_rfc.md §7). */
    reject(number: string, code?: number): void;
    /** Отбой активной ноги: CANCEL/BYE/reject — по состоянию стейт-машины. */
    hangup(number: string): void;
    /** Состояния всех абонентов из .env. */
    list_subscribers(): SubscriberStatus[];
    /** Все записи реестра (активные и завершённые). */
    list_calls(): CallRecord[];
    /** Запись реестра по id (tmp-id или Call-ID); undefined — нет такого. */
    get_call(id: string): CallRecord | undefined;
    /** Graceful-закрытие: unregister всех (терминал `quit`, п.7). */
    close(): Promise<void>;
}

/** Фабрика транспорта: DI-точка пула (мок в тестах / ClassicTransport в бою). */
export type PoolTransportFactory = (
    cfg: PhoneConfig,
    on_trace: (direction: 'in' | 'out', message: string) => void,
) => Transport;

/** Боевая фабрика: классический SIP UDP/TCP (task2/bridge, перенос 1-в-1). */
export function default_pool_factory(
    cfg: PhoneConfig,
    on_trace: (direction: 'in' | 'out', message: string) => void,
): Transport
{
    return new ClassicTransport(cfg, on_trace);
}

/** Один виртуальный абонент пула: конфиг + стейт-машина + клиент + транспорт. */
interface PoolEntry
{
    sub: SubscriberConfig;
    cfg: PhoneConfig;
    sm: PhoneStateMachine;
    client: SipPhoneClient;
    /** Отписки journal.attach_transport/incoming текущей жизни транспорта. */
    transport_unsubs: Array<() => void>;
    /** Handle последнего входящего — для reject(number, code) с произвольным кодом. */
    incoming_handle?: CallHandle;
    /** Незавершённая запись вызова абонента (активен или ждёт Call-ID). */
    pending?: CallRecord;
    /** Идёт register_subscriber — повторные вызовы ждут её (без гонок). */
    inflight?: Promise<RegisterOutcome>;
}

/**
 * Пул виртуальных абонентов сервера (plan_2.md п.4.1). Единица состояния —
 * PhoneSnapshot стейт-машины абонента (инвариант №1); транспорт создаётся
 * лениво внутри client.register() через фабрику и обвешивается наблюдениями
 * журнала (attach_transport, on_sip_message, capture входящих).
 */
export class SipSubscriberPool implements SipPool
{
    private entries = new Map<string, PoolEntry>();
    /** Реестр: call_id (или tmp-id) → запись; завершённые не удаляются. */
    private calls = new Map<string, CallRecord>();
    private seq = 0;

    constructor(
        private readonly app: AppConfig,
        private readonly journal: Journal,
        private readonly transport_factory: PoolTransportFactory = default_pool_factory,
    )
    {}

    // ---------- регистрация ----------

    /**
     * Зарегистрировать абонента на станции (REGISTER с Digest — внутри sip.js).
     * Идемпотентен: REGISTERED → сразу ok; параллельные вызовы ждут один REGISTER.
     * Бросает PoolError при отказе станции (код — в err.code) и на 3203.
     */
    async register_subscriber(number: string): Promise<RegisterOutcome>
    {
        // Запрет проверяем ДО создания записи: 3203 не заводит ленивый entry.
        const sub = this.find_subscriber(number);
        if (!sub.can_register)
        {
            throw new PoolError(
                `Абонент ${number} — только цель вызова, ` +
                    'регистрация запрещена (plan_2.md)',
                0,
                403,
            );
        }
        const entry = this.ensure_entry(number);
        if (entry.sm.snapshot.state === 'REGISTERED' && !entry.sm.snapshot.registering)
        {
            return { number, ok: true, code: 0, text: '' };
        }
        if (entry.inflight) return entry.inflight;

        const inflight = (async (): Promise<RegisterOutcome> =>
        {
            await entry.client.register(entry.cfg);
            const res: RegResult = entry.client.last_reg ?? {
                ok: false,
                code: 0,
                text: 'Нет итога регистрации',
            };
            if (!res.ok)
            {
                // Станция (upstream) отвергла REGISTER — 502, SIP-код в err.code.
                throw new PoolError(
                    res.text || `Станция отвергла REGISTER ${number}`,
                    res.code,
                    502,
                );
            }
            return { number, ok: true, code: 0, text: '' };
        })();
        entry.inflight = inflight;
        try
        {
            return await inflight;
        }
        finally
        {
            if (entry.inflight === inflight) entry.inflight = undefined;
        }
    }

    /** Снять абонента с регистрации (REGISTER expires=0, graceful BYE при разговоре). */
    async unregister(number: string): Promise<void>
    {
        const entry = this.entries.get(number);
        if (!entry) return;
        this.clear_transport(entry);
        await entry.client.unregister();
        this.entries.delete(number);
    }

    // ---------- вызовы ----------

    /**
     * Позвонить from→to (INVITE на станцию; для цепочки 9404→3203→52 to=3203).
     * Возвращает запись реестра; call_id заполнится из сырого INVITE.
     */
    call(from: string, to: string): CallRecord
    {
        if (!this.find_subscriber(from).can_register)
        {
            throw new PoolError(
                `Абонент ${from} не может звонить (не регистрируется)`,
                0,
                403,
            );
        }
        const entry = this.ensure_entry(from);
        if (from === to) throw new PoolError('Нельзя звонить самому себе', 0, 400);
        if (entry.sm.snapshot.state !== 'REGISTERED')
        {
            throw new PoolError(
                `Абонент ${from} не зарегистрирован ` +
                    `(состояние ${entry.sm.snapshot.state})`,
                0,
                409,
            );
        }
        if (entry.pending && CALL_STATES.includes(entry.sm.snapshot.state))
        {
            throw new PoolError(
                `Абонент ${from} уже в вызове ` +
                    `(${entry.pending.from}→${entry.pending.to})`,
                0,
                409,
            );
        }
        entry.client.call(to); // синхронно: CALL_OUT или error в снапшоте
        // Состояние перечитываем через функцию: TS сузил его до 'REGISTERED' в
        // проверке выше, а стейт-машина к этому моменту уже изменила снапшот.
        function state_now(): PhoneState
        {
            return entry.sm.snapshot.state;
        }
        if (state_now() !== 'CALL_OUT')
        {
            throw new PoolError(
                `Не удалось отправить INVITE ${from}→${to}: ` +
                    `${entry.sm.snapshot.error || 'нет транспорта'}`,
                0,
                502,
            );
        }
        const rec = this.register_call({ direction: 'out', owner: from, from, to });
        entry.pending = rec;
        return rec;
    }

    /** Принять входящий вызов абонента (200 OK + ACK). */
    answer(number: string): void
    {
        const entry = this.ensure_entry(number);
        if (entry.sm.snapshot.state !== 'CALL_IN')
        {
            throw new PoolError(
                `У абонента ${number} нет входящего вызова ` +
                    `(состояние ${entry.sm.snapshot.state})`,
                0,
                409,
            );
        }
        entry.client.answer();
    }

    /**
     * Отклонить входящий вызов абонента с кодом (по умолчанию 486 Busy Here).
     * Код идёт напрямую в handle транспорта — стейт-машина завершит вызов
     * событием terminated (BUG-6: отбой неотвеченного = reject, не bye).
     */
    reject(number: string, code = 486): void
    {
        const entry = this.ensure_entry(number);
        if (entry.sm.snapshot.state !== 'CALL_IN' || !entry.incoming_handle)
        {
            throw new PoolError(
                `У абонента ${number} нет входящего вызова ` +
                    `(состояние ${entry.sm.snapshot.state})`,
                0,
                409,
            );
        }
        const handle = entry.incoming_handle;
        entry.incoming_handle = undefined;
        handle.reject(code).catch(() =>
        {
            /* завершение придёт событием terminated либо уже завершено */
        });
    }

    /**
     * Отбой активного вызова абонента (CANCEL в CALL_OUT, BYE в IN_CALL,
     * reject в CALL_IN).
     */
    hangup(number: string): void
    {
        const entry = this.ensure_entry(number);
        if (!CALL_STATES.includes(entry.sm.snapshot.state))
        {
            throw new PoolError(
                `У абонента ${number} нет активного вызова ` +
                    `(состояние ${entry.sm.snapshot.state})`,
                0,
                409,
            );
        }
        entry.client.hangup();
    }

    // ---------- реестр и статусы ----------

    /** Состояния всех абонентов из .env (терминал `status`, GET /api/subscribers). */
    list_subscribers(): SubscriberStatus[]
    {
        return this.app.subscribers.map((sub) =>
        {
            const s = this.entries.get(sub.number)?.sm.snapshot;
            return {
                number: sub.number,
                can_register: sub.can_register,
                state: s?.state ?? 'ABSENT',
                peer: s?.peer ?? '',
                error: s?.error ?? '',
                registering: s?.registering ?? false,
            };
        });
    }

    /** Все записи реестра вызовов (активные и завершённые — для отчётов). */
    list_calls(): CallRecord[]
    {
        return [...this.calls.values()];
    }

    /** Запись по id: сначала Call-ID, затем tmp-id незавершённых. */
    get_call(id: string): CallRecord | undefined
    {
        const by_id = this.calls.get(id);
        if (by_id) return by_id;
        return this.list_calls().find((r) => r.call_id === id);
    }

    /** Graceful-закрытие пула: unregister всех зарегистрированных (терминал quit). */
    async close(): Promise<void>
    {
        for (const number of [...this.entries.keys()])
        {
            try
            {
                await this.unregister(number);
            }
            catch
            {
                /* шнур мог уже оборваться — идемпотентно */
            }
        }
    }

    // ---------- внутреннее ----------

    /** Конфиг абонента из .env; PoolError на неизвестный номер. */
    private find_subscriber(number: string): SubscriberConfig
    {
        const sub = this.app.subscribers.find((s) => s.number === number);
        if (!sub)
        {
            throw new PoolError(
                `Неизвестный абонент ${number} (ожидается один из: ` +
                    `${this.app.subscribers.map((s) => s.number).join(', ')})`,
                0,
                404,
            );
        }
        return sub;
    }

    /** Запись (без регистрации) для абонента из .env; PoolError на неизвестный номер. */
    private ensure_entry(number: string): PoolEntry
    {
        const existing = this.entries.get(number);
        if (existing) return existing;
        const sub = this.find_subscriber(number);
        const cfg: PhoneConfig = {
            host: this.app.pbx_host,
            sip_port: this.app.pbx_port,
            number: sub.number,
            password: sub.password,
            transport: this.app.sip_protocol,
        };
        const sm = new PhoneStateMachine();
        // client заполняется сразу ниже (фабрика ссылается на entry — нужен
        // уже созданный объект); утверждение через unknown только для инициализации.
        const entry: PoolEntry = {
            sub,
            cfg,
            sm,
            client: undefined as unknown as SipPhoneClient,
            transport_unsubs: [],
        };
        // Фабрика вызывается внутри client.register() — обвешиваем наблюдения
        // до connect(): ClassicTransport буферизует on()/on_trace до поднятия сокета.
        entry.client = new SipPhoneClient(sm, (phone_cfg) =>
            this.build_transport(entry, phone_cfg),
        );
        this.journal.attach_phone(number, sm);
        this.subscribe_sm(entry);
        this.entries.set(number, entry);
        return entry;
    }

    /** Сборка транспорта абонента + подключения журнала/реестра к его событиям. */
    private build_transport(entry: PoolEntry, cfg: PhoneConfig): Transport
    {
        this.clear_transport(entry); // наблюдения старой жизни транспорта больше не нужны
        const t = this.transport_factory(cfg, (dir, raw) =>
            this.on_trace(entry, dir, raw),
        );
        entry.transport_unsubs.push(this.journal.attach_transport(entry.sub.number, t));
        entry.transport_unsubs.push(
            t.on('incoming', (peer: string, handle: CallHandle) =>
            {
                entry.incoming_handle = handle;
                // Запись на входящий: id допишется из сырого INVITE в on_trace.
                const rec = this.register_call({
                    direction: 'in',
                    owner: entry.sub.number,
                    from: peer,
                    to: entry.sub.number,
                });
                entry.pending = rec;
            }),
        );
        return t;
    }

    /** Наблюдатель сырых сообщений: журнал (этапы) + захват Call-ID в реестр. */
    private on_trace(entry: PoolEntry, direction: 'in' | 'out', raw: string): void
    {
        const number = entry.sub.number;
        this.journal.on_sip_message(number, direction, raw);
        const head = parse_sip_message(raw);
        if (head?.is_request && head.method === 'INVITE')
            this.capture_call_id(entry, head.call_id);
    }

    /** Первый INVITE жизни вызова: tmp-id → реальный Call-ID + актуальный стейт. */
    private capture_call_id(entry: PoolEntry, call_id: string): void
    {
        const rec = entry.pending;
        if (!rec || !rec.call_id.startsWith('tmp:') || !call_id) return;
        // Стейт-машина могла сменить состояние ДО создания записи (исходящий) или
        // в этом же прогоне событий (входящий) — сверяем по snapshot.
        if (CALL_STATES.includes(entry.sm.snapshot.state))
            rec.state = entry.sm.snapshot.state;
        for (const [key, val] of this.calls)
        {
            if (val === rec)
            {
                this.calls.delete(key);
                break;
            }
        }
        rec.call_id = call_id;
        this.calls.set(call_id, rec);
    }

    /** Новая запись реестра под временным id (п.4.2). */
    private register_call(init: {
        direction: 'out' | 'in';
        owner: string;
        from: string;
        to: string;
    }): CallRecord
    {
        this.seq += 1;
        const rec: CallRecord = {
            call_id: `tmp:${init.owner}-${this.seq}`,
            from: init.from,
            to: init.to,
            state: 'PENDING',
            direction: init.direction,
            owner: init.owner,
            ended_at: 0,
        };
        this.calls.set(rec.call_id, rec);
        return rec;
    }

    /** Синхронизация записи реестра со стейт-машиной абонента (журнал — attach_phone). */
    private subscribe_sm(entry: PoolEntry): void
    {
        entry.sm.subscribe((s: PhoneSnapshot) =>
        {
            const rec = entry.pending;
            if (!rec) return;
            if (CALL_STATES.includes(s.state))
            {
                rec.state = s.state;
                return;
            }
            // Вне вызовных состояний — запись завершена (REGISTERED/UNREGISTERED).
            if (rec.ended_at === 0)
            {
                rec.state = s.state;
                rec.ended_at = Date.now();
                if (entry.pending === rec) entry.pending = undefined;
            }
        });
    }

    /** Отвязать наблюдения текущей жизни транспорта (перерегистрация/снятие). */
    private clear_transport(entry: PoolEntry): void
    {
        for (const off of entry.transport_unsubs) off();
        entry.transport_unsubs = [];
        entry.incoming_handle = undefined;
    }
}
