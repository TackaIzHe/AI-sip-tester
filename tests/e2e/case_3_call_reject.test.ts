// E2E case_3 «приём и отклонение» (plan_2.md п.8.3) против ЖИВОЙ АТС:
// первый вызов 9404→52 принят (200+BYE), второй отклонён (reject → 486),
// вызывающий возвращается в REGISTERED без зависших диалогов (проверяется
// ассертами кейса). related: e2e_runner.ts (case_3), doc/task_8_plan_2.md.

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
    'case_3: приём (200) и отклонение (486), ' +
        'возвращающий вызывающий без зависших диалогов',
    async () =>
    {
        const v = await run_case('3', { pool, journal, config });
        expect(v.verdict, `вердикт-текст: ${v.verdict_text}`).toBe('PASS');
    },
    180_000,
);
