// E2E case_6 «не-ответ» (plan_2.md п.8.6) против ЖИВОЙ АТС: вызов
// незарегистрированного номера; в отчёте фиксируются 180 (если был) и
// финальный отказ станции (на стенде — 100 → 502 Bad Gateway без 180, см.
// doc/.probe_e2e8.ts и отклонение в doc/task_8_plan_2.md) либо таймаут с
// CANCEL. related: e2e_runner.ts (case_6_noanswer), doc/task_8_plan_2.md.

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
    'case_6: вызов незарегистрированного — ' +
        'финальный отказ/таймаут зафиксирован, ' +
        'вызывающий в REGISTERED',
    async () =>
    {
        const v = await run_case('noanswer', { pool, journal, config });
        expect(v.verdict, `вердикт-текст: ${v.verdict_text}`).toBe('PASS');
    },
    180_000,
);
