// E2E case_7 «Calling party number у 52» против ЖИВОЙ АТС (за основу взят
// case_4): цепочка 9404→3203→52, ассерт — входящий INVITE у абонента 52
// содержит номер вызывающего (Calling party number, user из заголовка `From`)
// и он равен 9404; затем отклонение 486. related: e2e_runner.ts (caller),
// doc/task_8_plan_2.md.

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

test('case_7: у 52 во входящем INVITE есть Calling party number (From=9404)', async () =>
{
    const v = await run_case('caller', { pool, journal, config });
    expect(v.verdict, `вердикт-текст: ${v.verdict_text}`).toBe('PASS');
}, 180_000);
