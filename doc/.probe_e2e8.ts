// Прогон-зонд для фиксации ассертов plan_2.md п.8 (не тест, не в бандле):
//   npx tsx doc/.probe_e2e8.ts
// Риск-раздел плана требует зонд ДО фиксации assert-ов case_4. Зонд отвечает:
//  1) «не-ответ»: какие коды шлёт станция на вызов незарегистрированного 52
//     (180? финал 480/404/487/таймаут, длительность);
//  2) case_2: полный цикл 9404→52 (180/200/ACK/BYE) — базовая проходимость;
//  3) case_3: reject(486) — финальный код у вызывающего, возврат в REGISTERED;
//  4) case_4: прокси-цепочка — INVITE на 3203: куда приходит входящий (52?),
//     кто peer, принимает ли станция 200 на ноге 52, BYE;
//  5) case_5: REGISTER с заведомо неверным паролем — challenge/401/403 или 200
//     (станция стенда REGISTER не чалленджит — нужна эмпирика для ассертов).
// Журнал печатается по шагам; пароли в лог не пишутся.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load_config_from_env } from '../server/config';
import { Journal } from '../server/journal';
import { PoolError, SipSubscriberPool } from '../server/sip_pool';

const app = load_config_from_env();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e8-probe-'));
const journal = new Journal({ reports_dir: tmp });
const pool = new SipSubscriberPool(app, journal);

const [A, B, C] = app.subscribers.map((s) => s.number); // 9404, 52, 3203

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(
    pred: () => boolean,
    timeoutMs: number,
    stepMs = 200,
): Promise<boolean>
{
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline)
    {
        if (pred()) return true;
        await sleep(stepMs);
    }
    return pred();
}

function state_of(number: string): string
{
    return pool.list_subscribers().find((s) => s.number === number)?.state ?? 'ABSENT';
}

/** Все события журнала от индекса marked (сырые + вехи) — краткая строка. */
function chain_from(mark: number): string[]
{
    return journal.events
        .slice(mark)
        .map(
            (e) =>
                `  [${e.session}] ${e.direction} ${e.kind}` +
                `${e.sip_code ? ' ' + e.sip_code : ''} — ${e.detail}` +
                `${e.call_id ? ' cid=' + e.call_id.slice(0, 24) : ''}`,
        );
}

function dump(title: string, mark: number): void
{
    console.log(
        `\n=== ${title} (состояния: ${A}=${state_of(A)} ${B}=${state_of(B)}) ===`,
    );
    console.log(chain_from(mark).join('\n'));
}

async function main(): Promise<void>
{
    console.log(
        `[probe] АТС ${app.pbx_host}:${app.pbx_port} (${app.sip_protocol}); ` +
            `${A} → {${B}, ${C}}`,
    );

    // --- 1) «не-ответ»: вызов незарегистрированного B (plan_2.md п.8.6) ---
    await pool.register_subscriber(A);
    let mark = journal.events.length;
    const t_no = Date.now();
    pool.call(A, B);
    const ended = await until(() => state_of(A) === 'REGISTERED', 30_000);
    console.log(
        `\n[probe] не-ответ: возврат в REGISTERED=${ended} за ` +
            `${Date.now() - t_no} мс, ошибка="` +
            `${pool.list_subscribers().find((s) => s.number === A)?.error}"`,
    );
    dump('не-ответ ' + A + '→' + B, mark);
    // после финала станции повторная регистрация A — на всякий (станция могла сбросить)
    if (state_of(A) !== 'REGISTERED') await pool.register_subscriber(A);

    // --- 2) полный цикл вызова с ответом (case_2) ---
    await pool.register_subscriber(B);
    mark = journal.events.length;
    pool.call(A, B);
    const ring_b = await until(() => state_of(B) === 'CALL_IN', 12_000);
    console.log(`\n[probe] входящий у ${B}: ${ring_b}`);
    if (ring_b)
    {
        pool.answer(B);
        const both = await until(
            () => state_of(A) === 'IN_CALL' && state_of(B) === 'IN_CALL',
            10_000,
        );
        console.log(`[probe] IN_CALL у обоих: ${both}`);
        pool.hangup(A);
        await until(
            () => state_of(A) === 'REGISTERED' && state_of(B) === 'REGISTERED',
            10_000,
        );
        dump('полный цикл ' + A + '→' + B, mark);
    }
    else
    {
        dump('входящий НЕ пришёл', mark);
        pool.hangup(A);
    }

    // --- 3) отклонение (case_3): reject(486) на входящем ---
    mark = journal.events.length;
    pool.call(A, B);
    const ring2 = await until(() => state_of(B) === 'CALL_IN', 12_000);
    console.log(`\n[probe] входящий для отклонения у ${B}: ${ring2}`);
    if (ring2)
    {
        pool.reject(B, 486);
        const back = await until(
            () => state_of(A) === 'REGISTERED' && state_of(B) === 'REGISTERED',
            10_000,
        );
        const err_a = pool.list_subscribers().find((s) => s.number === A)?.error;
        console.log(
            `[probe] после reject: оба REGISTERED=${back}, ошибка вызывающего="${err_a}"`,
        );
    }
    dump('reject ' + A + '→' + B, mark);

    // --- 4) прокси-цепочка (case_4): INVITE на 3203, входящий ждём у 52 ---
    mark = journal.events.length;
    pool.call(A, C);
    const ring_c = await until(() => state_of(B) === 'CALL_IN', 12_000);
    console.log(`\n[probe] цепочка: входящий у ${B} после INVITE на ${C}: ${ring_c}`);
    if (ring_c)
    {
        const peer = pool.list_calls().find((r) => r.owner === B && r.ended_at === 0);
        console.log(`[probe] запись входящего у ${B}: ${JSON.stringify(peer)}`);
        pool.answer(B);
        const both = await until(
            () => state_of(A) === 'IN_CALL' && state_of(B) === 'IN_CALL',
            10_000,
        );
        console.log(`[probe] цепочка established (оба IN_CALL): ${both}`);
        pool.hangup(A);
        await until(
            () => state_of(A) === 'REGISTERED' && state_of(B) === 'REGISTERED',
            10_000,
        );
    }
    else
    {
        // возможно, станция сразу завершила вызов — зафиксируем финал у A
        console.log(
            `[probe] цепочка: финал у ${A}: state=${state_of(A)} ` +
                `error="` +
                `${pool.list_subscribers().find((s) => s.number === A)?.error}"`,
        );
        if (state_of(A) !== 'REGISTERED') pool.hangup(A);
    }
    dump('цепочка ' + A + '→' + C + '(→' + B + ')', mark);

    // --- 5) неверный пароль REGISTER (case_5) ---
    await pool.unregister(A);
    const shadow_cfg = {
        ...app,
        subscribers: app.subscribers.map((s, i) =>
            i === 0 ? { ...s, password: s.password + '-wrong' } : s,
        ) as typeof app.subscribers,
    };
    const shadow = new SipSubscriberPool(shadow_cfg, journal);
    mark = journal.events.length;
    try
    {
        const res = await shadow.register_subscriber(A);
        console.log(
            `\n[probe] неверный пароль: REGISTER ПРИНЯТ (ok=${res.ok}) — ` +
                `станция пароль не проверяет`,
        );
    }
    catch (e)
    {
        if (e instanceof PoolError)
            console.log(
                `\n[probe] неверный пароль: отказ code=${e.code} text="${e.message}"`,
            );
        else throw e;
    }
    console.log(
        `[probe] неверный пароль: состояние ${A} = ` +
            `${shadow.list_subscribers().find((s) => s.number === A)?.state}`,
    );
    await shadow.close();
    dump('неверный пароль ' + A, mark);

    await pool.close();
    console.log('\n[probe] готово');
}

main()
    .then(() => process.exit(0))
    .catch((e) =>
    {
        console.error('[probe] FAIL:', e);
        process.exit(1);
    });
