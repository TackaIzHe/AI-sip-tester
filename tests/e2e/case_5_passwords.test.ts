// E2E case_5 «пароли» (plan_2.md п.8.5) против ЖИВОЙ АТС: корректные пароли
// из .env → REGISTERED; заведомо неверный → условная ветка (стенд REGISTER
// не чалленджит и пароль не проверяет — doc/.probe_e2e8.ts): отказ станции
// обязан оставить UNREGISTERED (регресс BUG-1), принятие фиксируется в
// отчёте. related: e2e_runner.ts (case_5), doc/task_8_plan_2.md.

import { afterAll, expect, test } from 'vitest';
import { load_config_from_env } from '../../server/config';
import { Journal } from '../../server/journal';
import { SipSubscriberPool } from '../../server/sip_pool';
import { run_case } from '../../e2e_runner';

const config = load_config_from_env();
const journal = new Journal();
const pool = new SipSubscriberPool(config, journal);

afterAll(async () =>
{
    await pool.close();
}, 30_000);

test(
    'case_5: корректные пароли приняты; ' +
        'неверный — 401/403 c UNREGISTERED ' +
        'либо «станция не проверяет»',
    async () =>
    {
        const v = await run_case('5', { pool, journal, config });
        expect(v.verdict, `вердикт-текст: ${v.verdict_text}`).toBe('PASS');
    },
    180_000,
);
