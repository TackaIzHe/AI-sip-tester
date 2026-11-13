// E2E case_2 «вызов и приём» (plan_2.md п.8.2) против ЖИВОЙ АТС из .env:
// 9404 и 52 зарегистрированы, 9404→52, ответ, IN_CALL у обоих, BYE →
// REGISTERED; в отчёте — полная цепочка INVITE/180/200/ACK/BYE (проверяется
// ассертами кейса в e2e_runner). Запуск — только с живой АТС (критерий п.8).
// related: e2e_runner.ts (case_2), doc/task_8_plan_2.md.

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
    'case_2: вызов с ответом — IN_CALL у обоих, BYE, ' + 'цепочка INVITE/180/200/ACK/BYE',
    async () =>
    {
        const v = await run_case('2', { pool, journal, config });
        expect(v.verdict, `вердикт-текст: ${v.verdict_text}`).toBe('PASS');
    },
    180_000,
);
