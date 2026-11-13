// E2E «пакетная регистрация 24..47» против ЖИВОЙ АТС из .env: два теста в
// одном файле с ОБЩИМ пулом и журналом — первый регистрирует абонентов
// 24..47 и оставляет их зарегистрированными, второй снимает их с регистрации.
// Общие пул и журнал обязательны: REGISTER expires=0 станция сопоставляет с
// binding по Contact того же UA (server/sip/sip_ua_transport.ts: user-часть
// Contact = номер, порт — эфемерный сокет транспорта); пул, созданный заново,
// снял бы только собственную (несуществующую) binding, а не созданную первым
// тестом.
//
// Номера 24..47 вне .env (там 9404/52/3203), поэтому пул поднимается на
// синтетическом AppConfig: subscribers — весь диапазон, can_register: true,
// пароль — SIP_PASS_1: станция стенда пароль REGISTER не проверяет
// (doc/.probe_e2e8.ts), а при challenge Digest использует именно его.
// Тесты зависимые (второй требует регистраций первого) — внутри файла vitest
// последователен; при FAIL любого теста afterAll снимает зарегистрированное,
// «вислые» регистрации (expires 600 с) прогон не переживают.
// related: tests/e2e/case_1_registration.test.ts, server/sip_pool.ts,
// e2e_runner.ts (паттерн вердикта+отчёта), doc/sip_rfc.md §5.10.

import { afterAll, expect, test } from 'vitest';
import {
    load_config_from_env,
    type AppConfig,
    type SubscriberConfig,
} from '../../server/config';
import { Journal } from '../../server/journal';
import {
    PoolError,
    SipSubscriberPool,
    type SubscriberStatus,
} from '../../server/sip_pool';

/** Первый и последний номер диапазона включительно (по запросу — 24..47). */
const BATCH_FROM = 24;
const BATCH_TO = 47;

const batch_numbers: string[] = [];
for (let n = BATCH_FROM; n <= BATCH_TO; n++) batch_numbers.push(String(n));

const config = load_config_from_env();

// Пул читает subscribers только через find/map (server/sip_pool.ts), длина
// кортежа [3] нигде не значима — расширение до 24 элементов безопасна
// (то же приведение, что в case_5 раннера e2e_runner.ts).
const batch_config: AppConfig = {
    ...config,
    subscribers: batch_numbers.map((number): SubscriberConfig => ({
        number,
        password: config.subscribers[0].password,
        can_register: true,
    })) as AppConfig['subscribers'],
};

const journal = new Journal(); // отчёты — в ./reports (страница показывает их)
const pool = new SipSubscriberPool(batch_config, journal);

/** Состояние абонента в пуле (ABSENT — записи нет: ещё не или уже снят). */
function state_of(number: string): SubscriberStatus['state']
{
    return pool.list_subscribers().find((s) => s.number === number)?.state ?? 'ABSENT';
}

/**
 * Прогнать тело кейса как run_case (e2e_runner.ts): вердикт PASS/FAIL, отчёт
 * в ./reports (пишется и при FAIL) и expect(PASS) — при FAIL в тексте причина
 * и id отчёта.
 */
async function run_batch_case(name: string, body: () => Promise<string>): Promise<void>
{
    const start = journal.events.length; // границы прогона в общем журнале
    let verdict: 'PASS' | 'FAIL' = 'PASS';
    let verdict_text = '';
    try
    {
        verdict_text = await body();
    }
    catch (e)
    {
        verdict = 'FAIL';
        verdict_text = e instanceof Error ? e.message : String(e);
    }
    const report = journal.render_report(
        {
            case: name,
            verdict,
            verdict_text,
            pbx_host: config.pbx_host,
            pbx_port: config.pbx_port,
            sip_protocol: config.sip_protocol,
            subscribers: batch_numbers,
        },
        journal.events.slice(start),
    );
    const note = `вердикт-текст: ${verdict_text} (отчёт ${report.id})`;
    expect(verdict, note).toBe('PASS');
}

test(
    `регистрирует абонентов ${BATCH_FROM}..${BATCH_TO} на АТС ` +
        `${config.pbx_host}:${config.pbx_port} (REGISTER → 200)`,
    async () =>
    {
        await run_batch_case('batch_reg_24_47', async () =>
        {
            const start = journal.events.length;
            const failures: string[] = [];
            for (const number of batch_numbers)
            {
                try
                {
                    // бросок PoolError = отказ станции этому номеру — не
                    // прерываем прогон, чтобы отчёт показал весь список;
                    // успешные регистрации живут до второго теста.
                    await pool.register_subscriber(number);
                }
                catch (e)
                {
                    const text =
                        e instanceof PoolError
                            ? `${e.message} (код ${e.code})`
                            : String(e);
                    failures.push(`${number}: ${text}`);
                }
            }
            if (failures.length > 0)
            {
                throw new Error(
                    `не зарегистрировались ${failures.length} из ` +
                        `${batch_numbers.length}: ${failures.join('; ')}`,
                );
            }

            // Ассерта по сырым сообщениям журнала (как case_1): REGISTER от
            // абонента и финальный 200 станции; challenge опционален — стенд
            // не чалленджит (Digest-ветка закрыта юнит-тестами пула).
            const regs = journal.events.slice(start);
            const missing: string[] = [];
            for (const number of batch_numbers)
            {
                const mine = regs.filter(
                    (e) => e.session === number && e.kind === 'register',
                );
                const out = mine.some((e) => e.direction === 'out');
                const ok200 = mine.some(
                    (e) => e.direction === 'in' && e.sip_code === 200,
                );
                if (!out || !ok200 || state_of(number) !== 'REGISTERED')
                    missing.push(`${number} (${state_of(number)})`);
            }
            if (missing.length > 0)
            {
                throw new Error(
                    `нет цепочки REGISTER → 200 (или состояния REGISTERED) ` +
                        `для: ${missing.join(', ')}`,
                );
            }
            return (
                `зарегистрировано ${batch_numbers.length} абонентов ` +
                `(${BATCH_FROM}..${BATCH_TO}): цепочка REGISTER → 200 у каждого`
            );
        });
    },
    // 24 регистрации последовательно; худшая ветка — таймаут REGISTER 15 с
    // на номер (REGISTER_TIMEOUT_MS) + запас на connect.
    420_000,
);

test(
    `снимает абонентов ${BATCH_FROM}..${BATCH_TO} с регистрации ` +
        `(REGISTER expires=0 → 200)`,
    async () =>
    {
        await run_batch_case('batch_unreg_24_47', async () =>
        {
            // Пул тот же, что у теста регистрации: expires=0 обязан уйти с
            // того же Contact, иначе станция снимет не ту binding (см. шапку).
            const not_registered = batch_numbers.filter(
                (n) => state_of(n) !== 'REGISTERED',
            );
            if (not_registered.length > 0)
            {
                throw new Error(
                    `до снятия не зарегистрированы: ${not_registered.join(', ')} — ` +
                        'сначала выполните тест регистрации этого файла',
                );
            }
            const start = journal.events.length;
            const failures: string[] = [];
            for (const number of batch_numbers)
            {
                try
                {
                    await pool.unregister(number);
                }
                catch (e)
                {
                    failures.push(
                        `${number}: ${e instanceof Error ? e.message : String(e)}`,
                    );
                }
            }
            if (failures.length > 0)
                throw new Error(`не снялись с регистрации: ${failures.join('; ')}`);

            const left = batch_numbers.filter((n) => state_of(n) !== 'ABSENT');
            if (left.length > 0)
            {
                const detail = left.map((n) => `${n}=${state_of(n)}`).join(', ');
                throw new Error(`после unregister запись пула осталась: ${detail}`);
            }

            // Подтверждение станцией: исходящий REGISTER (expires=0) и 200 на
            // него в сырых сообщениях прогона (on_trace живёт до закрытия
            // сокета — registerer.unregister резолвится по финальному ответу).
            const evs = journal.events.slice(start);
            const no_ack: string[] = [];
            for (const number of batch_numbers)
            {
                const mine = evs.filter(
                    (e) => e.session === number && e.kind === 'register',
                );
                const out = mine.some((e) => e.direction === 'out');
                const ok200 = mine.some(
                    (e) => e.direction === 'in' && e.sip_code === 200,
                );
                if (!out || !ok200) no_ack.push(number);
            }
            if (no_ack.length > 0)
            {
                throw new Error(
                    `станция не подтвердила снятие ` +
                        `(нет REGISTER → 200) для: ${no_ack.join(', ')}`,
                );
            }
            return (
                `снято с регистрации ${batch_numbers.length} абонентов ` +
                `(${BATCH_FROM}..${BATCH_TO}): 200 на REGISTER expires=0 у каждого`
            );
        });
    },
    // 24 снятия; транзакция REGISTER non-INVITE до 32 с без ответа — запас.
    300_000,
);

afterAll(async () =>
{
    // Идемпотентно: после успешного второго теста записей пула нет; при FAIL
    // любого теста снимаем зарегистрированное (graceful, как терминальный quit).
    await pool.close();
}, 60_000);
