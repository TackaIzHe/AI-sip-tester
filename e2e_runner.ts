// Единый раннер SIP e2e-кейсов (plan_2.md п.7.1, п.8.6): кейс — функция
// (ctx: pool+journal+config+шаги) → текст вердикта; бросок = FAIL. Один и тот
// же раннер дёргают терминал сервера (`test N`, п.7), POST /api/test_runs
// (п.8) и tests/e2e (vitest, п.8) — паттерн task2/tools/smoke.ts (until/sleep,
// PASS/FAIL), но креды/номера только из AppConfig (.env), не из argv.
//
// Раннер оборачивает прогон в Journal.render_report (вердикт + полная цепочка
// этапов журнала) и возвращает пути отчёта. Кейсы п.8: case_1..case_5 +
// case_6 «не-ответ» + case_7 «Calling party number у 52» + case_8a/8b
// «пакетная регистрация / снятие 24..47» (сверх плана, doc/task_18_plan_2.md,
// разделение — doc/task_21_plan_2.md); ассерты фиксированы
// поведению живой АТС, снятому прогоном-зондом doc/.probe_e2e8.ts (см.
// doc/task_8_plan_2.md). Плюс кейсы-стимулы t1..t8 — короткие версии
// сценариев генератора los_mem (doc/task_22_plan_2.md, интеграция —
// doc/task_23_plan_2.md); они не входят в `all` (см. CaseDef.in_all).
// related: server/terminal.ts, server/sip_pool.ts, server/journal.ts,
// server/los_mem/scenarios.ts, doc/sip_rfc.md §5.10/§5.4/§5.8/§5.9,
// doc/.probe_e2e8.ts.

import path from 'node:path';
import type { AppConfig, SubscriberConfig } from './server/config';
import {
    utc_stamp,
    type Journal,
    type JournalEvent,
    type ReportFiles,
} from './server/journal';
import { CsvLog } from './server/los_mem/csv_log';
import {
    BASE_SCENARIO_OPTS,
    LOS_QUICK_OPTS,
    LOS_SCENARIOS,
    type ScenarioOpts,
} from './server/los_mem/scenarios';
import {
    PoolError,
    SipSubscriberPool,
    type SipPool,
    type SubscriberStatus,
} from './server/sip_pool';
import type { PhoneState } from './server/sip/state';

/** Один шаг кейса: текст в терминал сервера (п.7.1 «шаги — в терминал»). */
export type Step = (text: string) => void;

/** Контекст прогона (DI): пул, журнал, конфиг, вывод шагов. */
export interface RunContext
{
    pool: SipPool;
    journal: Journal;
    config: AppConfig;
    step: Step;
}

/** Итог кейса до рендера: текст того, что подтверждено (бросок = FAIL). */
export type CaseFn = (ctx: RunContext) => Promise<string>;

/** Итог прогона: вердикт + текстовая расшифровка + файлы отчёта. */
export interface CaseVerdict
{
    case: string;
    verdict: 'PASS' | 'FAIL';
    verdict_text: string;
    report: ReportFiles;
}

// ---------- помощники кейсов (паттерн task2/tools/smoke.ts: until/sleep) ----------

function sleep(ms: number): Promise<void>
{
    return new Promise((r) => setTimeout(r, ms));
}

/** Опрос предиката до истины или таймаута; true — дождались. */
async function until(
    pred: () => boolean,
    timeout_ms: number,
    step_ms = 100,
): Promise<boolean>
{
    const deadline = Date.now() + timeout_ms;
    while (Date.now() < deadline)
    {
        if (pred()) return true;
        await sleep(step_ms);
    }
    return pred();
}

/** Состояние абонента в пуле (ABSENT — записи ещё нет). */
function state_of(ctx: RunContext, number: string): SubscriberStatus['state']
{
    return (
        ctx.pool.list_subscribers().find((s) => s.number === number)?.state ?? 'ABSENT'
    );
}

function sub_error(ctx: RunContext, number: string): string
{
    return ctx.pool.list_subscribers().find((s) => s.number === number)?.error ?? '';
}

/** Дождаться состояния абонента; таймаут — FAIL с текущим состоянием и ошибкой. */
async function wait_state(
    ctx: RunContext,
    number: string,
    state: PhoneState,
    timeout_ms: number,
    label: string,
): Promise<void>
{
    if (!(await until(() => state_of(ctx, number) === state, timeout_ms)))
    {
        throw new Error(
            `таймаут ${timeout_ms} мс: ${label} — сейчас ${state_of(ctx, number)}` +
                (sub_error(ctx, number) ? ` (ошибка: ${sub_error(ctx, number)})` : ''),
        );
    }
}

/** Регистрация с чистого листа: «вислую» снимаем (идемпотентный register не
 *  дал бы цепочки). */
async function clean_register(ctx: RunContext, number: string): Promise<void>
{
    const st = state_of(ctx, number);
    if (st !== 'ABSENT' && st !== 'UNREGISTERED')
    {
        ctx.step(`снимаю прежнюю регистрацию ${number} (чистый старт кейса)`);
        await ctx.pool.unregister(number);
    }
    await ctx.pool.register_subscriber(number);
}

/** Снять с регистрации без права на ошибку (cleanup в finally). */
async function unregister_quietly(ctx: RunContext, ...numbers: string[]): Promise<void>
{
    for (const n of numbers)
    {
        await ctx.pool.unregister(n).catch(() =>
        {
            /* шнур мог уже оборваться — статус видно в отчёте по журналу */
        });
    }
}

/** Условие поиска события журнала (все поля — И). */
interface EvQuery
{
    session?: string;
    direction?: JournalEvent['direction'];
    kind?: string;
    code?: number;
    detail_has?: string;
}

function has_ev(evs: readonly JournalEvent[], q: EvQuery): boolean
{
    return evs.some(
        (e) =>
            (q.session === undefined || e.session === q.session) &&
            (q.direction === undefined || e.direction === q.direction) &&
            (q.kind === undefined || e.kind === q.kind) &&
            (q.code === undefined || e.sip_code === q.code) &&
            (q.detail_has === undefined || e.detail.includes(q.detail_has)),
    );
}

/** Ассерта этапа: нет события — FAIL с текстом. */
function need(evs: readonly JournalEvent[], q: EvQuery, what: string): void
{
    if (!has_ev(evs, q)) throw new Error(`в журнале прогона нет этапа: ${what}`);
}

/** Активные (незавершённые) записи реестра — «зависшие диалоги» быть не должно. */
function active_calls(ctx: RunContext): string[]
{
    return ctx.pool
        .list_calls()
        .filter((c) => c.ended_at === 0)
        .map((c) => `${c.from}→${c.to}[${c.state}]`);
}

// ---------- кейсы ----------

/**
 * case_1 (plan_2.md п.8.1): регистрация абонента 1 из .env (образец — 9404)
 * и снятие с регистрации. Ассерт цепочки по сырым сообщениям журнала:
 * REGISTER → 401 → REGISTER+Digest → 200 (doc/sip_rfc.md §5.10, §5.4), финал —
 * UNREGISTERED. Живая АТС стенда REGISTER не чалленджит вовсе (наблюдалось в
 * п.4 и перепроверено doc/.probe-call.py: REGISTER → 200 с заведомо нового
 * номера/порта), поэтому 401/Digest-ветка обязательна только если станция
 * challenge выставила; без неё ассерт — REGISTER → 200, а Digest-логика
 * закрыта юнит-тестами пула (отказ 401). Перед стартом снимает «вислую»
 * регистрацию — иначе идемпотентный register_subscriber не отправит REGISTER
 * и цепочка будет пустой.
 */
async function case_1(ctx: RunContext): Promise<string>
{
    const number = ctx.config.subscribers[0].number;
    const start = ctx.journal.events.length; // события только этого прогона

    const before = ctx.pool.list_subscribers().find((s) => s.number === number);
    if (before && before.state === 'REGISTERED')
    {
        ctx.step(`снимаю прежнюю регистрацию ${number} (чистый старт кейса)`);
        await ctx.pool.unregister(number);
    }

    ctx.step(
        `регистрирую ${number} на АТС ${ctx.config.pbx_host}:${ctx.config.pbx_port}…`,
    );
    try
    {
        await ctx.pool.register_subscriber(number); // бросок PoolError = FAIL
        const states = ctx.pool.list_subscribers().find((s) => s.number === number);
        if (!states || states.state !== 'REGISTERED')
        {
            throw new Error(
                `после register состояние ${states?.state ?? 'ABSENT'}, ` +
                    `ожидали REGISTERED`,
            );
        }

        // Цепочка регистрации — по сырым REGISTER/ответам станции из журнала
        // (kind='register': направление + SIP-код + наличие Digest в детали).
        const regs = ctx.journal.events
            .slice(start)
            .filter((e) => e.session === number && e.kind === 'register');
        function has(pred: (e: (typeof regs)[number]) => boolean): boolean
        {
            return regs.some(pred);
        }
        const out_plain = has(
            (e) => e.direction === 'out' && !e.detail.includes('Digest'),
        );
        const in_401 = has((e) => e.direction === 'in' && e.sip_code === 401);
        const out_digest = has(
            (e) => e.direction === 'out' && e.detail.includes('Digest'),
        );
        const in_200 = has((e) => e.direction === 'in' && e.sip_code === 200);
        if (!out_plain) throw new Error('в журнале нет этапа: REGISTER');
        if (!in_200) throw new Error('в журнале нет этапа: 200 OK для REGISTER');
        // Challenge опционален: стенд отвечает REGISTER→200 без Digest (см. шапку).
        // Если 401 был — обязаны пройти Digest и получить 200 уже с ним.
        if (in_401 && !out_digest)
            throw new Error('станция выставила 401, но REGISTER+Digest не отправлен');
        const stages = ['REGISTER'];
        if (in_401)
        {
            stages.push('401', 'REGISTER+Digest');
        }
        else
        {
            stages.push('(без challenge)');
        }
        stages.push('200');
        const chain = stages.join(' → ');
        ctx.step(`цепочка подтверждена: ${chain}`);
        return `регистрация ${number} подтверждена: ${chain}`;
    }
    finally
    {
        // Снимаем всегда (успех/провал) — кейс не должен оставлять «вислую»
        // регистрацию: идемпотентный register потом не дал бы цепочки REGISTER.
        ctx.step(`снимаю ${number} с регистрации (REGISTER expires=0)`);
        await ctx.pool.unregister(number).catch(() =>
        {
            /* шнур мог уже оборваться — статус видно в отчёте по журналу */
        });
    }
}

/**
 * case_2 (plan_2.md п.8.2): вызов и приём. 9404 и 52 зарегистрированы;
 * 9404→52, 52 отвечает, IN_CALL у обоих, hangup → REGISTERED. Ассерт полной
 * цепочки по обеим ногам (стенд, doc/.probe_e2e8.ts): у вызывающего
 * INVITE → 100/180 → 200 → ACK → BYE, у отвечающего INVITE → 180 → 200 →
 * ACK(от станц.) → BYE(от станц.) → 200 (doc/sip_rfc.md §5.6–§5.8).
 * Реестр: Call-ID захвачен из сырого INVITE, запись завершена (ended_at).
 */
async function case_2(ctx: RunContext): Promise<string>
{
    const from = ctx.config.subscribers[0].number;
    const to = ctx.config.subscribers[1].number;
    await clean_register(ctx, from);
    await clean_register(ctx, to);
    const start = ctx.journal.events.length;
    try
    {
        ctx.step(`вызываю ${from} → ${to}…`);
        const rec = ctx.pool.call(from, to);
        await wait_state(ctx, to, 'CALL_IN', 15_000, `входящий у ${to}`);
        ctx.step(`${to} отвечает (200 OK + ACK)…`);
        ctx.pool.answer(to);
        await wait_state(ctx, from, 'IN_CALL', 15_000, `${from} в IN_CALL`);
        await wait_state(ctx, to, 'IN_CALL', 15_000, `${to} в IN_CALL`);
        ctx.step('положил трубку вызывающий (BYE)…');
        ctx.pool.hangup(from);
        await wait_state(
            ctx,
            from,
            'REGISTERED',
            15_000,
            `${from} вернулся в REGISTERED`,
        );
        await wait_state(ctx, to, 'REGISTERED', 15_000, `${to} вернулся в REGISTERED`);
        await sleep(400); // 200 на BYE / ACK — последние события в журнале

        const evs = ctx.journal.events.slice(start);
        need(
            evs,
            { session: from, direction: 'out', kind: 'invite' },
            `INVITE от ${from}`,
        );
        need(
            evs,
            { session: from, direction: 'in', kind: 'invite', code: 180 },
            `180 Ringing для ${from}`,
        );
        need(
            evs,
            { session: from, direction: 'in', kind: 'invite', code: 200 },
            `200 OK для ${from}`,
        );
        need(evs, { session: from, direction: 'out', kind: 'ack' }, `ACK от ${from}`);
        need(evs, { session: from, direction: 'out', kind: 'bye' }, `BYE от ${from}`);
        need(evs, { session: to, direction: 'in', kind: 'invite' }, `INVITE у ${to}`);
        need(
            evs,
            { session: to, direction: 'out', kind: 'invite', code: 180 },
            `180 от ${to}`,
        );
        need(
            evs,
            { session: to, direction: 'out', kind: 'invite', code: 200 },
            `200 OK от ${to}`,
        );
        need(evs, { session: to, direction: 'in', kind: 'ack' }, `ACK у ${to}`);
        need(evs, { session: to, direction: 'in', kind: 'bye' }, `BYE у ${to}`);
        if (rec.call_id.startsWith('tmp:'))
            throw new Error('в реестре не захвачен Call-ID из сырого INVITE');
        const stored = ctx.pool.get_call(rec.call_id);
        if (!stored || stored.ended_at === 0)
            throw new Error('запись вызова в реестре не помечена завершённой');
        ctx.step('цепочка подтверждена: INVITE → 180 → 200 → ACK → BYE (обе ноги)');
        return (
            `вызов ${from}→${to}: принят (IN_CALL у обоих), завершён BYE; ` +
            `цепочка INVITE/180/200/ACK/BYE в отчёте`
        );
    }
    finally
    {
        await unregister_quietly(ctx, from, to);
    }
}

/**
 * case_3 (plan_2.md п.8.3): приём и отклонение. Первый вызов 9404→52 принят
 * (200) и завершён BYE; второй — отклонён reject(486 Busy Here,
 * doc/sip_rfc.md §7). Ассерт: 486 на обеих ногах, вызывающий вернулся в
 * REGISTERED, в реестре нет незавершённых записей («без зависших диалогов»).
 */
async function case_3(ctx: RunContext): Promise<string>
{
    const from = ctx.config.subscribers[0].number;
    const to = ctx.config.subscribers[1].number;
    await clean_register(ctx, from);
    await clean_register(ctx, to);
    const start = ctx.journal.events.length;
    try
    {
        // — вызов 1: принят и завершён BYE —
        ctx.step(`вызов 1: ${from} → ${to}, отвечающий принимается…`);
        ctx.pool.call(from, to);
        await wait_state(ctx, to, 'CALL_IN', 15_000, `входящий у ${to}`);
        ctx.pool.answer(to);
        await wait_state(ctx, from, 'IN_CALL', 15_000, `${from} в IN_CALL`);
        await wait_state(ctx, to, 'IN_CALL', 15_000, `${to} в IN_CALL`);
        ctx.pool.hangup(from);
        await wait_state(ctx, from, 'REGISTERED', 15_000, `${from} после BYE`);
        await wait_state(ctx, to, 'REGISTERED', 15_000, `${to} после BYE`);
        need(
            ctx.journal.events.slice(start),
            { session: to, direction: 'out', kind: 'invite', code: 200 },
            '200 OK на первом вызове',
        );

        // — вызов 2: отклонение 486 —
        ctx.step(`вызов 2: ${from} → ${to}, отклоняю (reject 486)…`);
        ctx.pool.call(from, to);
        await wait_state(ctx, to, 'CALL_IN', 15_000, `второй входящий у ${to}`);
        ctx.pool.reject(to, 486);
        await wait_state(ctx, from, 'REGISTERED', 15_000, `${from} вернулся после 486`);
        await wait_state(ctx, to, 'REGISTERED', 15_000, `${to} вернулся после 486`);
        await sleep(400);

        const evs = ctx.journal.events.slice(start);
        need(
            evs,
            { session: to, direction: 'out', kind: 'invite', code: 486 },
            `486 от ${to}`,
        );
        need(
            evs,
            { session: from, direction: 'in', kind: 'invite', code: 486 },
            `486 у ${from}`,
        );
        const active = active_calls(ctx);
        if (active.length > 0)
            throw new Error(`зависшие диалоги в реестре: ${active.join(', ')}`);
        ctx.step(
            'первый вызов принят (200+BYE), второй отклонён (486), диалогов не осталось',
        );
        return (
            `приём+отклонение ${from}→${to}: вызов 1 принят и завершён BYE, ` +
            `вызов 2 отклонён 486, зависших диалогов нет`
        );
    }
    finally
    {
        await unregister_quietly(ctx, from, to);
    }
}

/**
 * case_4 (plan_2.md п.8.4): прокси-цепочка 9404→3203→52. Регистрируем ТОЛЬКО
 * 9404 и 52 (3203 — только цель вызова, pool не даст зарегистрировать);
 * INVITE уходит на 3203, станция проксирует его на 52 (стенд,
 * doc/.probe_e2e8.ts: 100 → 183 → 180 у вызывающего, отдельный INVITE с
 * peer=9404 у 52). Ассерт: входящий прилетел именно к 52 (call-in у 52),
 * событий абонента 3203 в журнале нет вообще, приём на ноге 52 → established
 * у обеих ног, BYE. Заодно на живом стенде подтверждается, что на 52 приходит
 * INVITE от 9404 (To-идентичность вызывающего), а не от 3203.
 */
async function case_4(ctx: RunContext): Promise<string>
{
    const from = ctx.config.subscribers[0].number;
    const to = ctx.config.subscribers[1].number;
    const proxy = ctx.config.subscribers[2].number;
    await clean_register(ctx, from);
    await clean_register(ctx, to);
    const start = ctx.journal.events.length;
    try
    {
        ctx.step(`вызываю ${from} → ${proxy} (цепочка прокси ${from}→${proxy}→${to})…`);
        ctx.pool.call(from, proxy);
        await wait_state(
            ctx,
            to,
            'CALL_IN',
            15_000,
            `входящий у ${to} после INVITE на ${proxy}`,
        );
        ctx.step(`входящий у ${to} — принимаю на ноге ${to}…`);
        ctx.pool.answer(to);
        await wait_state(
            ctx,
            from,
            'IN_CALL',
            15_000,
            `${from} в IN_CALL (нога через ${proxy})`,
        );
        await wait_state(ctx, to, 'IN_CALL', 15_000, `${to} в IN_CALL`);
        ctx.step('положил трубку вызывающий (BYE)…');
        ctx.pool.hangup(from);
        await wait_state(
            ctx,
            from,
            'REGISTERED',
            15_000,
            `${from} вернулся в REGISTERED`,
        );
        await wait_state(ctx, to, 'REGISTERED', 15_000, `${to} вернулся в REGISTERED`);
        await sleep(400);

        const evs = ctx.journal.events.slice(start);
        // INVITE уходил на 3203 (RURI из сырого сообщения).
        need(
            evs,
            { session: from, direction: 'out', kind: 'invite', detail_has: `→ ${proxy}` },
            `INVITE на ${proxy}`,
        );
        // Входящий — у 52, и вообще ничего не происходило на стороне 3203.
        need(
            evs,
            { session: to, direction: 'in', kind: 'call-in' },
            `входящий (call-in) у ${to}`,
        );
        if (evs.some((e) => e.session === proxy))
        {
            throw new Error(
                `в журнале появились события абонента-посредника ${proxy} — ` +
                    `его не должно быть в пуле`,
            );
        }
        // Приём на ноге 52 и штатное завершение обеих ног.
        need(
            evs,
            { session: to, direction: 'out', kind: 'invite', code: 200 },
            `200 OK от ${to}`,
        );
        need(
            evs,
            { session: from, direction: 'in', kind: 'invite', code: 200 },
            `200 OK для ${from}`,
        );
        need(evs, { session: from, direction: 'out', kind: 'bye' }, `BYE от ${from}`);
        need(evs, { session: to, direction: 'in', kind: 'bye' }, `BYE у ${to}`);
        const active = active_calls(ctx);
        if (active.length > 0)
            throw new Error(`зависшие диалоги в реестре: ${active.join(', ')}`);
        ctx.step(
            `входящий пришёл у ${to} (не у ${proxy}), established + BYE — ` +
                `цепочка подтверждена`,
        );
        return (
            `цепочка ${from}→${proxy}→${to}: INVITE на ${proxy}, ` +
            `входящий у ${to}, принят на ноге ${to}, established + BYE`
        );
    }
    finally
    {
        await unregister_quietly(ctx, from, to);
    }
}

/**
 * case_5 (plan_2.md п.8.5): пароли. Корректные пароли из .env (образец —
 * 123/321) → REGISTERED у 9404 и 52 (цепочка REGISTER → 200). Неверный
 * пароль: отдельный «теневой» пул с испорченным паролем абонента 1;
 * станция стенда REGISTER не чалленджит и пароль не проверяет
 * (doc/.probe_e2e8.ts: REGISTER с заведомо неверным паролем → 200), поэтому
 * ветка условная: станция отвергла (401/403) — обязан остаться
 * UNREGISTERED (регресс BUG-1: без ложного REGISTERED); станция приняла —
 * это фиксируется в отчёте как поведение стенда, итог берётся строго из
 * финального ответа (инвариант №3).
 */
async function case_5(ctx: RunContext): Promise<string>
{
    const a = ctx.config.subscribers[0];
    const b = ctx.config.subscribers[1];
    await unregister_quietly(ctx, a.number, b.number);
    const start = ctx.journal.events.length;
    try
    {
        ctx.step(`регистрирую ${a.number} и ${b.number} корректными паролями из .env…`);
        await ctx.pool.register_subscriber(a.number);
        await ctx.pool.register_subscriber(b.number);
        const evs_reg = ctx.journal.events.slice(start);
        for (const n of [a.number, b.number])
        {
            need(
                evs_reg,
                { session: n, direction: 'in', kind: 'register', code: 200 },
                `200 на REGISTER ${n}`,
            );
        }
        ctx.step('корректные пароли приняты — снимаю регистрации');
        await unregister_quietly(ctx, a.number, b.number);

        // — заведомо неверный пароль: теневой пул с тем же номером —
        ctx.step(
            `пробую REGISTER ${a.number} с заведомо неверным паролем (теневой пул)…`,
        );
        const wrong_cfg: AppConfig = {
            ...ctx.config,
            subscribers: ctx.config.subscribers.map((s) =>
                s.number === a.number ? { ...s, password: `${s.password}-wrong` } : s,
            ) as AppConfig['subscribers'],
        };
        const shadow = new SipSubscriberPool(wrong_cfg, ctx.journal);
        let rejected: PoolError | undefined;
        let accepted = false;
        try
        {
            await shadow.register_subscriber(a.number);
            accepted = true;
        }
        catch (e)
        {
            if (!(e instanceof PoolError)) throw e;
            rejected = e;
        }
        const shadow_state =
            shadow.list_subscribers().find((s) => s.number === a.number)?.state ??
            'ABSENT';
        let note: string;
        if (rejected)
        {
            if (rejected.code !== 401 && rejected.code !== 403)
            {
                throw new Error(
                    `ожидали 401/403 на неверный пароль, ` +
                        `получили code=${rejected.code} (${rejected.message})`,
                );
            }
            if (shadow_state !== 'UNREGISTERED')
            {
                throw new Error(
                    `РЕГРЕСС BUG-1: станция отвергла REGISTER (${rejected.code}), ` +
                        `но состояние ${shadow_state}`,
                );
            }
            note =
                `станция отвергла неверный пароль (${rejected.code}), ` +
                `абонент остался UNREGISTERED`;
        }
        else
        {
            if (shadow_state !== 'REGISTERED')
            {
                throw new Error(
                    `REGISTER принят, но состояние ${shadow_state} — ` +
                        `ложный итог (регресс BUG-1)`,
                );
            }
            note =
                'станция стенда не проверяет пароль REGISTER ' +
                '(200 без challenge — см. журнал п.8)';
        }
        await shadow.close();
        ctx.step(note);
        return `пароли: корректные ${a.number}/${b.number} приняты; неверный — ${note}`;
    }
    finally
    {
        await unregister_quietly(ctx, a.number, b.number);
    }
}

/**
 * case_6 «не-ответ» (plan_2.md п.8.6): вызов незарегистрированного номера.
 * На стенде станция отвечает 100 Trying → 502 Bad Gateway без 180 за доли
 * секунды (doc/.probe_e2e8.ts) — отклонение от плана (ожидались 180 +
 * 480/408), фиксация честная: финальный отказ станции 4xx/5xx обязан быть в
 * отчёте; 180 — если станция его послала; при молчании станции — CANCEL по
 * таймауту тоже считается зафиксированным «не-ответом». Ассерт: вызывающий
 * вернулся в REGISTERED, незавершённых записей нет.
 */
async function case_6_noanswer(ctx: RunContext): Promise<string>
{
    const from = ctx.config.subscribers[0].number;
    const to = ctx.config.subscribers[1].number;
    await unregister_quietly(ctx, from, to); // «не-ответ»: вызываемый НЕ зарегистрирован
    await clean_register(ctx, from);
    if (state_of(ctx, to) !== 'ABSENT' && state_of(ctx, to) !== 'UNREGISTERED')
    {
        throw new Error(
            `абонент ${to} должен быть незарегистрирован, а он ${state_of(ctx, to)}`,
        );
    }
    const start = ctx.journal.events.length;
    try
    {
        ctx.step(`вызываю незарегистрированного ${to} (${from} → ${to})…`);
        const rec = ctx.pool.call(from, to);
        const finished = await until(() => state_of(ctx, from) !== 'CALL_OUT', 20_000);
        let timed_out = false;
        if (!finished)
        {
            timed_out = true;
            ctx.step('станция молчит — отменяю вызов (CANCEL)…');
            ctx.pool.hangup(from); // CALL_OUT → CANCEL
            if (!(await until(() => state_of(ctx, from) === 'REGISTERED', 10_000)))
            {
                throw new Error(
                    `после CANCEL ${from} не вернулся в REGISTERED ` +
                        `(${state_of(ctx, from)})`,
                );
            }
        }
        else if (state_of(ctx, from) === 'UNREGISTERED')
        {
            throw new Error(
                `вызов оборвался (${state_of(ctx, from)}: ` +
                    `${sub_error(ctx, from)}) — не «не-ответ»`,
            );
        }
        await sleep(400);

        const evs = ctx.journal.events.slice(start);
        need(
            evs,
            { session: from, direction: 'out', kind: 'invite' },
            `INVITE от ${from}`,
        );
        const was_180 =
            has_ev(evs, { session: from, kind: 'ringing' }) ||
            has_ev(evs, { session: from, direction: 'in', kind: 'invite', code: 180 });
        let final_text: string;
        if (timed_out)
        {
            final_text = 'нет ответа станции (таймаут), зафиксирован CANCEL';
        }
        else
        {
            const finals = evs.filter(
                (e) =>
                    e.session === from &&
                    e.direction === 'in' &&
                    e.kind === 'invite' &&
                    (e.sip_code ?? 0) >= 300,
            );
            if (finals.length === 0)
                throw new Error(
                    'вызов завершился, но финального отказа станции в журнале нет',
                );
            const code = finals[finals.length - 1].sip_code ?? 0;
            const acceptable = [404, 408, 480, 486, 487, 488, 502, 503, 504, 603];
            if (!acceptable.includes(code))
                throw new Error(`неожиданный финальный код не-ответа: ${code}`);
            final_text = `финальный отказ станции ${code}`;
        }
        if (
            !rec.call_id.startsWith('tmp:') &&
            (ctx.pool.get_call(rec.call_id)?.ended_at ?? 0) === 0
        )
        {
            throw new Error('запись вызова в реестре не помечена завершённой');
        }
        if (active_calls(ctx).length > 0)
            throw new Error(
                `зависшие диалоги в реестре: ${active_calls(ctx).join(', ')}`,
            );
        ctx.step(
            `не-ответ подтверждён: ${final_text}` +
                `${was_180 ? ', 180 был' : ', 180 не было'}`,
        );
        return (
            `не-ответ ${from}→${to}: ${final_text}` +
            `${was_180 ? ' (180 зафиксирован)' : ' (станция не прислала 180)'}`
        );
    }
    finally
    {
        await unregister_quietly(ctx, from, to);
    }
}

/**
 * case_7 «Calling party number у 52» (по образцу case_4): цепочка
 * 9404→3203→52, но ассерт — наличие номера вызывающего ВО ВХОДЯЩЕМ INVITE
 * у абонента 52: user из заголовка `From` сырого сообщения (Calling party
 * number) обязан дойти до вызываемого и равняться 9404 (стенд: станция
 * сохраняет From-идентичность вызывающего, см. журнал case_4). Ответ на
 * вызов не даётся — отклонение 486 сразу после проверки (быстрый финиш).
 */
async function case_7_caller_number(ctx: RunContext): Promise<string>
{
    const from = ctx.config.subscribers[0].number;
    const to = ctx.config.subscribers[1].number;
    const proxy = ctx.config.subscribers[2].number;
    await clean_register(ctx, from);
    await clean_register(ctx, to);
    const start = ctx.journal.events.length;
    try
    {
        ctx.step(`вызываю ${from} → ${proxy} (проверка Calling party number у ${to})…`);
        ctx.pool.call(from, proxy);
        await wait_state(
            ctx,
            to,
            'CALL_IN',
            15_000,
            `входящий у ${to} после INVITE на ${proxy}`,
        );

        const evs = ctx.journal.events.slice(start);
        // Сырой входящий INVITE у 52: detail содержит `от <user>` из заголовка From
        // (journal.on_sip_message) — это и есть переданный станцией Calling party number.
        need(
            evs,
            { session: to, direction: 'in', kind: 'invite', detail_has: ` от ${from}` },
            `Calling party number (${from}) в заголовке From входящего INVITE у ${to}`,
        );
        // Подтверждение вехой транспорта: входящий зарегистрирован от того же номера.
        need(
            evs,
            { session: to, kind: 'call-in', detail_has: `от ${from}` },
            `веха call-in у ${to} с номером вызывающего ${from}`,
        );

        ctx.step('вызов отклоняю (reject 486) — проверка завершена');
        ctx.pool.reject(to, 486);
        await wait_state(ctx, from, 'REGISTERED', 15_000, `${from} вернулся после 486`);
        await wait_state(ctx, to, 'REGISTERED', 15_000, `${to} вернулся после 486`);
        await sleep(400);
        if (active_calls(ctx).length > 0)
            throw new Error(
                `зависшие диалоги в реестре: ${active_calls(ctx).join(', ')}`,
            );
        ctx.step(`Calling party number подтверждён: INVITE у ${to} с From=${from}`);
        return (
            `Calling party number у ${to}: входящий INVITE ` +
            `(цепочка ${from}→${proxy}→${to}) содержит номер вызывающего ${from}`
        );
    }
    finally
    {
        await unregister_quietly(ctx, from, to);
    }
}

// ---------- пакетные кейсы 24..47 (сверх плана_2.md, doc/task_18_plan_2.md;
// разделение на регистрация/снятие — doc/task_21_plan_2.md) ----------

/** Первый и последний номер диапазона пакетной регистрации включительно. */
const BATCH_FROM = 24;
const BATCH_TO = 47;

const batch_numbers: string[] = [];
for (let n = BATCH_FROM; n <= BATCH_TO; n++) batch_numbers.push(String(n));

/**
 * Теневой пул диапазона 24..47, ЖИВУЩИЙ между прогонами внутри одного процесса
 * сервера: REGISTER expires=0 станция сопоставляет с binding по Contact того
 * же UA (server/sip/sip_ua_transport.ts: user-часть Contact = номер, порт —
 * эфемерный сокет транспорта) — поэтому case_8a (регистрация) и case_8b
 * (снятие) обязаны видеть один и тот же пул, заведённый прогоном case_8a.
 * Пул, собранный заново в новом процессе, снял бы только собственную
 * (несуществующую) binding — снять регистрации прежнего процесса нереализуемо,
 * case_8b честно отказывает в этом случае (doc/task_21_plan_2.md). Журнал
 * сервера один на процесс (server/main.ts), поэтому повторные прогоны пишут
 * в тот же Journal, что читается ассертами.
 */
let batch_pool: SipSubscriberPool | undefined;

/**
 * Пул диапазона 24..47: лениво создаётся первым прогоном case_8a и живёт до
 * case_8b (см. batch_pool). Номера вне .env — синтетический AppConfig
 * (паттерн теневого пула case_5), пароль — абонента 1 из .env: станция стенда
 * пароль REGISTER не проверяет (doc/.probe_e2e8.ts), а при challenge Digest
 * использует именно его.
 */
function get_batch_pool(ctx: RunContext): SipSubscriberPool
{
    if (!batch_pool)
    {
        // Пул читает subscribers только через find/map — длина кортежа [3]
        // нигде не значима, расширение до 24 элементов безопасна (тот же
        // каст, что в case_5).
        const batch_config: AppConfig = {
            ...ctx.config,
            subscribers: batch_numbers.map((number): SubscriberConfig => ({
                number,
                password: ctx.config.subscribers[0].password,
                can_register: true,
            })) as AppConfig['subscribers'],
        };
        batch_pool = new SipSubscriberPool(batch_config, ctx.journal);
    }
    return batch_pool;
}

/** Состояние абонента диапазона в живущем пуле (ABSENT — записи нет). */
function batch_state(pool: SipSubscriberPool, number: string): SubscriberStatus['state']
{
    return pool.list_subscribers().find((s) => s.number === number)?.state ?? 'ABSENT';
}

/**
 * case_8a «пакетная регистрация 24..47» (основной; разделение case_8 по
 * запросу, doc/task_21_plan_2.md; vitest-вариант пары —
 * tests/e2e/batch_24_47_reg_unreg.test.ts): регистрирует 24 абонента
 * диапазона и ОСТАВЛЯЕТ их зарегистрированными — снятие вынесено во
 * второстепенный case_8b (тот же живой пул, см. batch_pool). Ассерты — по
 * сырым сообщениям журнала (REGISTER → 200 у каждого; challenge опционален —
 * стенд не чалленджит, Digest-ветка закрыта юнит-тестами пула). Оставленные
 * регистрации — ожидаемое поведение разделения: снимаются case_8b, `quit`
 * сервера (close_batch_pool в main.ts) или истекают по expires станции.
 */
async function case_8a_batch_reg(ctx: RunContext): Promise<string>
{
    const pool = get_batch_pool(ctx);
    const state = (number: string): SubscriberStatus['state'] =>
        batch_state(pool, number);

    // Чистый старт: прежние регистрации диапазона снимаем ТЕМ ЖЕ пулом (его
    // Contact — binding снимется корректно), иначе идемпотентный
    // register_subscriber не отправит REGISTER и цепочка прогона будет пустой.
    const stale = batch_numbers.filter(
        (n) => state(n) !== 'ABSENT' && state(n) !== 'UNREGISTERED',
    );
    if (stale.length > 0)
    {
        ctx.step(
            `снимаю прежние регистрации ${stale.length} абонентов ` +
                `(чистый старт кейса)`,
        );
        for (const number of stale)
        {
            await pool.unregister(number).catch(() =>
            {
                /* шнур мог уже оборваться — итог виден по состоянию ниже */
            });
        }
    }

    const start = ctx.journal.events.length;
    ctx.step(
        `регистрирую диапазон ${BATCH_FROM}..${BATCH_TO} на АТС ` +
            `${ctx.config.pbx_host}:${ctx.config.pbx_port}…`,
    );
    const failures: string[] = [];
    for (const number of batch_numbers)
    {
        try
        {
            // бросок PoolError = отказ станции этому номеру — прогон не
            // прерываем, чтобы отчёт показал весь список; успешные
            // регистрации остаются живыми до case_8b.
            await pool.register_subscriber(number);
        }
        catch (e)
        {
            failures.push(`${number}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    if (failures.length > 0)
    {
        throw new Error(
            `не зарегистрировались ${failures.length} из ` +
                `${batch_numbers.length}: ${failures.join('; ')} — ` +
                'снятие зарегистрированного: кейс batch24unreg',
        );
    }

    // Цепочка REGISTER → 200 у каждого номера по сырым сообщениям (как в
    // vitest-варианте); Digest-ветка закрыта юнит-тестами пула.
    const reg_evs = ctx.journal.events.slice(start);
    const missing: string[] = [];
    for (const number of batch_numbers)
    {
        const out = has_ev(reg_evs, {
            session: number,
            direction: 'out',
            kind: 'register',
        });
        const ok200 = has_ev(reg_evs, {
            session: number,
            direction: 'in',
            kind: 'register',
            code: 200,
        });
        if (!out || !ok200 || state(number) !== 'REGISTERED')
            missing.push(`${number} (${state(number)})`);
    }
    if (missing.length > 0)
    {
        throw new Error(
            `нет цепочки REGISTER → 200 (или состояния REGISTERED) для: ` +
                missing.join(', '),
        );
    }
    ctx.step(
        `зарегистрировано ${batch_numbers.length} абонентов ` +
            `(${BATCH_FROM}..${BATCH_TO}): REGISTER → 200 у каждого`,
    );
    return (
        `пакетная регистрация ${BATCH_FROM}..${BATCH_TO}: зарегистрировано ` +
        `${batch_numbers.length} абонентов (REGISTER → 200 у каждого); ` +
        'регистрации оставлены живыми — снятие второстепенным кейсом ' +
        'batch24unreg (тот же процесс сервера)'
    );
    // пул НЕ закрываем: регистрации обязаны пережить прогон до case_8b.
}

/**
 * case_8b «пакетное снятие 24..47» (второстепенный; разделение case_8 по
 * запросу, doc/task_21_plan_2.md): снимает регистрации, оставленные case_8a.
 * Обязан идти ТЕМ ЖЕ живущим пулом: expires=0 станция сопоставляет с binding
 * по Contact того же UA (см. batch_pool) — снять регистрации прежнего
 * процесса из нового нереализуемо, поэтому без живого пула кейс честно FAIL
 * с этим текстом (case_8a обязан быть выполнен ранее в ЭТОМ же процессе).
 * Снятие подтверждаем сырыми сообщениями (REGISTER expires=0 → 200 у
 * каждого). После снятия (успех или FAIL) пул закрывается и кэш сбрасывается:
 * «вислые» регистрации вне пары кейсов не живут, повторный case_8a заведёт
 * новый пул.
 */
async function case_8b_batch_unreg(ctx: RunContext): Promise<string>
{
    const pool = batch_pool;
    if (!pool)
    {
        throw new Error(
            `нет живого пула диапазона ${BATCH_FROM}..${BATCH_TO}: кейс ` +
                'второстепенный и требует выполненный ранее case_8a (batch24reg) ' +
                'в ЭТОМ ЖЕ процессе сервера — binding станции привязана к ' +
                'Contact транспорта, снять регистрации прежнего процесса ' +
                'новым пулом нереализуемо',
        );
    }
    try
    {
        const state = (number: string): SubscriberStatus['state'] =>
            batch_state(pool, number);
        const registered = batch_numbers.filter((n) => state(n) === 'REGISTERED');
        const skipped = batch_numbers.filter((n) => state(n) !== 'REGISTERED');
        if (registered.length === 0)
        {
            throw new Error(
                `в живом пуле нет зарегистрированных абонентов ` +
                    `${BATCH_FROM}..${BATCH_TO} — сначала выполните case_8a ` +
                    `(batch24reg)`,
            );
        }
        ctx.step(
            `снимаю ${registered.length} абонентов ${BATCH_FROM}..${BATCH_TO} ` +
                `с регистрации (REGISTER expires=0)…`,
        );
        const start = ctx.journal.events.length;
        const failures: string[] = [];
        for (const number of registered)
        {
            try
            {
                await pool.unregister(number);
            }
            catch (e)
            {
                failures.push(`${number}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        if (failures.length > 0)
            throw new Error(`не снялись с регистрации: ${failures.join('; ')}`);

        const left = registered.filter((n) => state(n) !== 'ABSENT');
        if (left.length > 0)
        {
            throw new Error(
                `после unregister запись пула осталась: ` +
                    left.map((n) => `${n}=${state(n)}`).join(', '),
            );
        }

        // Подтверждение станцией: исходящий REGISTER (expires=0) и 200 на него
        // (on_trace живёт до закрытия сокета — unregister резолвится по
        // финальному ответу).
        const unreg_evs = ctx.journal.events.slice(start);
        const no_ack: string[] = [];
        for (const number of registered)
        {
            const out = has_ev(unreg_evs, {
                session: number,
                direction: 'out',
                kind: 'register',
            });
            const ok200 = has_ev(unreg_evs, {
                session: number,
                direction: 'in',
                kind: 'register',
                code: 200,
            });
            if (!out || !ok200) no_ack.push(number);
        }
        if (no_ack.length > 0)
        {
            throw new Error(
                `станция не подтвердила снятие (нет REGISTER → 200) для: ` +
                    no_ack.join(', '),
            );
        }
        ctx.step(
            `снято ${registered.length} абонентов: ` +
                `200 на REGISTER expires=0 у каждого`,
        );
        return (
            `пакетное снятие ${BATCH_FROM}..${BATCH_TO}: снято ` +
            `${registered.length} абонентов (200 на REGISTER expires=0 у ` +
            `каждого)${skipped.length > 0 ? `; не были зарегистрированы: ${skipped.join(', ')}` : ''}`
        );
    }
    finally
    {
        // Идемпотентно: после успешного снятия записей пула нет, close()
        // дозакрывает остатки при FAIL («вислые» регистрации вне пары кейсов
        // не оставляем). Кэш сбрасываем — следующий case_8a заведёт новый пул.
        await pool.close();
        batch_pool = undefined;
    }
}

/**
 * Graceful-закрытие живущего пула диапазона 24..47 (shutdown сервера,
 * server/main.ts): иначе регистрации, оставленные case_8a без case_8b,
 * переживают процесс и истекают только по expires станции. Идемпотентен,
 * ошибок наружу не бросает.
 */
export async function close_batch_pool(): Promise<void>
{
    const pool = batch_pool;
    batch_pool = undefined;
    if (!pool) return;
    await pool.close().catch(() =>
    {
        /* шнур мог уже оборваться — регистрации истекут по expires станции */
    });
}

// ---------- кейсы-стимулы T1–T8 (генератор los_mem, doc/task_22_plan_2.md;
// интеграция в CLI/веб — doc/task_23_plan_2.md) ----------

// LOS_QUICK_OPTS — в server/los_mem/scenarios.ts (общий источник для
// реестра CASES и движка стимулов станции, doc/task_26_plan_2.md).

/**
 * Кейс-стимул поверх общего раннера: ScenarioCtx собирается из RunContext —
 * log/phase идут шагами прогона (терминал/журнал API), а фазы и сводка
 * пишутся ещё и в Journal: сырой SIP-слой (server/los_mem/raw_sip.ts) не
 * подключён к on_trace общего журнала, без этого отчёт T-кейса был бы пуст. CSV —
 * reports/los_<t>_<UTC>.csv, тот же путь и формат, что у standalone-CLI
 * (план §2.2 — фазовые метки для сшивки с мониторингом памяти).
 * stopped — всегда false: отмены прогона в очереди нет, досрочный выход —
 * Ctrl-C сервера. Вердикта стимулу нет по решению оператора
 * (doc/task_22_plan_2.md): PASS = «стимул сгенерирован, сводка получена»,
 * бросок сокета/конфига = FAIL.
 */
function los_case(id: string): CaseFn
{
    return async (ctx) =>
    {
        const def = LOS_SCENARIOS[id];
        const opts: ScenarioOpts = {
            ...BASE_SCENARIO_OPTS,
            ...def.defaults,
            ...(LOS_QUICK_OPTS[id] ?? {}),
        };
        const reports_dir = path.resolve('reports');
        const csv_path = path.join(reports_dir, `los_${id}_${utc_stamp(Date.now())}.csv`);
        ctx.step(
            `${def.title}; цель ${ctx.config.pbx_host}:${ctx.config.pbx_port} ` +
                `(${ctx.config.sip_protocol}), Via/Contact от ` +
                `${ctx.config.bridge_host}; CSV: ${csv_path}`,
        );
        const csv = new CsvLog(csv_path, id);
        ctx.journal.log(id, 'out', 'los-start', {
            detail: `${def.title}; цель ${ctx.config.pbx_host}:${ctx.config.pbx_port}`,
        });
        const started = Date.now();
        try
        {
            const summary = await def.run({
                config: ctx.config,
                target: { host: ctx.config.pbx_host, port: ctx.config.pbx_port },
                via_host: ctx.config.bridge_host,
                reports_dir,
                opts,
                log: (text) => ctx.step(text),
                phase: (name) =>
                {
                    ctx.step(`фаза: ${name}`);
                    csv.row('phase', name);
                    ctx.journal.log(id, 'out', 'los-phase', { detail: name });
                },
                tick: (sent) => csv.row('tick', String(sent)),
                stopped: () => false,
            });
            const secs = Math.round((Date.now() - started) / 1000);
            csv.row('summary', summary);
            ctx.journal.log(id, 'out', 'los-summary', { detail: summary });
            return (
                `${def.title} (короткая версия): ${summary}; итог ${secs} с, ` +
                `CSV: ${csv_path}`
            );
        }
        finally
        {
            csv.close();
        }
    };
}

/** Запись реестра кейсов: имя отчёта + тело (+ опциональная шапка номеров). */
export interface CaseDef
{
    name: string;
    run: CaseFn;
    /**
     * Строка `subscribers` в шапке отчёта вместо номеров из ctx.config: нужна
     * кейсам на теневом пуле (batch24reg/batch24unreg показывают в отчёте
     * диапазон 24..47, как vitest-вариант
     * tests/e2e/batch_24_47_reg_unreg.test.ts).
     */
    report_subscribers?: string[];
    /**
     * false — кейс не участвует в `test all` / «запустить все»: долгие или
     * агрессивные стимулы (T1–T8; t5 — flood станции) включают только
     * поимённо, иначе приёмочный прогон всех кейсов растягивался бы на часы
     * и глушил станцию.
     */
    in_all?: boolean;
}

/** Реестр кейсов (plan_2.md): id команды терминала/API → имя отчёта + тело. */
export const CASES: Record<string, CaseDef> = {
    '1': { name: 'case_1', run: case_1 },
    '2': { name: 'case_2', run: case_2 },
    '3': { name: 'case_3', run: case_3 },
    '4': { name: 'case_4', run: case_4 },
    '5': { name: 'case_5', run: case_5 },
    noanswer: { name: 'case_6_noanswer', run: case_6_noanswer },
    caller: { name: 'case_7_caller_number', run: case_7_caller_number },
    // Порядок значим для `test all`: снятие (второстепенный) идёт сразу за
    // регистрацией и закрывает живой пул диапазона (см. batch_pool).
    batch24reg: {
        name: 'case_8a_batch_reg_24_47',
        run: case_8a_batch_reg,
        report_subscribers: batch_numbers,
    },
    batch24unreg: {
        name: 'case_8b_batch_unreg_24_47',
        run: case_8b_batch_unreg,
        report_subscribers: batch_numbers,
    },
    // Стимулы T1–T8 генератора los_mem (короткая версия, см. LOS_QUICK_OPTS;
    // флаги — standalone-CLI). in_all: false — вне «запустить все»: долгие,
    // t5 ещё и flood'ит станцию; включаются только поимённо.
    t1: { name: 'los_t1_dialog_info', run: los_case('t1'), in_all: false },
    t2: { name: 'los_t2_event_list', run: los_case('t2'), in_all: false },
    t3: { name: 'los_t3_dup_subscribes', run: los_case('t3'), in_all: false },
    t4: { name: 'los_t4_provider_401', run: los_case('t4'), in_all: false },
    t5: { name: 'los_t5_flood', run: los_case('t5'), in_all: false },
    t6: { name: 'los_t6_ipc_frames', run: los_case('t6'), in_all: false },
    t7: { name: 'los_t7_resolver', run: los_case('t7'), in_all: false },
    t8: { name: 'los_t8_soak', run: los_case('t8'), in_all: false },
};

/** Реализованные id кейсов (для `test all` и честного ответа API). */
export function implemented_cases(): string[]
{
    return Object.keys(CASES);
}

/** id кейсов для `test all` / «запустить все»: реестр минус in_all: false. */
export function cases_for_all(): string[]
{
    return implemented_cases().filter((id) => CASES[id].in_all !== false);
}

// ---------- раннер ----------

/**
 * Прогнать один кейс: тело кейса → вердикт PASS/FAIL → отчёт в reports/
 * (пишется и при FAIL — в нём разбор причины). Бросает Error на неизвестный id.
 */
export async function run_case(
    case_id: string,
    ctx: { pool: SipPool; journal: Journal; config: AppConfig; step?: Step },
): Promise<CaseVerdict>
{
    const def = CASES[case_id];
    if (!def)
        throw new Error(
            `Неизвестный кейс ${case_id} (доступны: ${implemented_cases().join(', ')})`,
        );
    const step: Step = ctx.step ?? (() => undefined);

    const start = ctx.journal.events.length; // границы прогона в общем журнале
    let verdict: 'PASS' | 'FAIL' = 'PASS';
    let verdict_text = '';
    try
    {
        verdict_text = await def.run({ ...ctx, step });
    }
    catch (e)
    {
        verdict = 'FAIL';
        verdict_text = e instanceof Error ? e.message : String(e);
    }

    // В отчёт — только события этого прогона (иначе `test all` включал бы в
    // отчёт кейса N этапы кейсов 1..N-1 из общего журнала сервера).
    const events = ctx.journal.events.slice(start);
    // Вызовы прогона (кому отправляли / от кого приходил): записи реестра, чей
    // Call-ID засветился в событиях окна (tmp-id в журнал не попадает — окно
    // отсекает вызовы предыдущих кейсов при `test all`).
    const window_ids = new Set(events.map((e) => e.call_id).filter(Boolean));
    const calls = ctx.pool
        .list_calls()
        .filter((c) => window_ids.has(c.call_id))
        .map((c) => ({ from: c.from, to: c.to, direction: c.direction }));
    const report = ctx.journal.render_report(
        {
            case: def.name,
            verdict,
            verdict_text,
            pbx_host: ctx.config.pbx_host,
            pbx_port: ctx.config.pbx_port,
            sip_protocol: ctx.config.sip_protocol,
            subscribers:
                def.report_subscribers ?? ctx.config.subscribers.map((s) => s.number),
            calls,
        },
        events,
    );
    return { case: def.name, verdict, verdict_text, report };
}
