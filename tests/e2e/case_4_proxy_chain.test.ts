// E2E case_4 «прокси-цепочка 9404→3203→52» (plan_2.md п.8.4) против ЖИВОЙ
// АТС: регистрируются ТОЛЬКО 9404 и 52; INVITE уходит на 3203, входящий
// прилетает к 52, приём на ноге 52, established + BYE. Ассерт «входящий у 52,
// не у 3203» — из прогона-зонда doc/.probe_e2e8.ts (требование риск-раздела
// плана). related: e2e_runner.ts (case_4), doc/task_8_plan_2.md.

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
    'case_4: цепочка 9404→3203→52 — ' + 'входящий у 52 (не у 3203), established + BYE',
    async () =>
    {
        const v = await run_case('4', { pool, journal, config });
        expect(v.verdict, `вердикт-текст: ${v.verdict_text}`).toBe('PASS');
    },
    180_000,
);
