// E2E case_1 «регистрация» (plan_2.md п.8.1) против ЖИВОЙ АТС из .env:
// тот же run_case, что у терминала сервера и POST /api/test_runs (п.8).
// Критерий п.8 — кейсы зелёные на живой АТС, отчёт виден на странице (пишется
// в ./reports). Стенд: АТС 192.168.80.157:5060 udp, абонент 9404 (пароль из
// .env). Без сети до АТС кейс FAIL — это честно: e2e-критерий требует стенда.
// related: e2e_runner.ts, doc/task_8_plan_2.md.

import { afterAll, expect, test } from 'vitest';
import { load_config_from_env } from '../../server/config';
import { Journal } from '../../server/journal';
import { SipSubscriberPool } from '../../server/sip_pool';
import { run_case } from '../../e2e_runner';

const config = load_config_from_env();
const journal = new Journal(); // отчёты — в ./reports (express.static отдаёт их странице)
const pool = new SipSubscriberPool(config, journal);

afterAll(async () =>
{
    await pool.close(); // graceful: unregister всех (терминальный путь quit)
}, 30_000);

test(
    `case_1: регистрация ${config.subscribers[0].number} и снятие ` + `(REGISTER → 200)`,
    async () =>
    {
        const v = await run_case('1', { pool, journal, config });
        expect(v.verdict, `вердикт-текст: ${v.verdict_text}`).toBe('PASS');
    },
    180_000,
);
