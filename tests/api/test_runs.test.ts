// Api-тесты /api/test_runs/* (plan_2.md п.9.2): GET / отдаёт список кейсов из
// реестра CASES (вкладка «Тесты» страницы, doc/task_16_plan_2.md), POST ставит
// прогон в очередь и сразу отвечает 202, GET /:id отдаёт статус, вердикты и
// журнал в JSON.
// Исполнение — общий e2e_runner.run_case на МОКЕ пула (DI, без сети): кейс 1
// проходит насквозь, мок-пул пишет REGISTER/200 в реальный Journal, отчёт
// пишется в temp-каталог. Кейс 5 не гоняем — он поднимает боевой
// SipSubscriberPool для теневого REGISTER (нужна живая АТС).
// related: server/controllers/test_runs_controller.ts, e2e_runner.ts.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { cases_for_all, implemented_cases } from '../../e2e_runner';
import { make_api_app, temp_dir } from './helpers';

let app: Express;
let root: string;
let cleanup: () => void;

beforeAll(() =>
{
    const t = temp_dir();
    root = t.dir;
    cleanup = t.cleanup;
    app = make_api_app({ root }).app;
});

afterAll(() => cleanup());

describe('GET /api/test_runs', () =>
{
    it('200 — список кейсов из реестра CASES (id+name, без тела кейса)', async () =>
    {
        const res = await request(app).get('/api/test_runs').expect(200);
        const body: { cases: { id: string; name: string }[] } = res.body;
        expect(body.cases.map((c) => c.id)).toEqual([
            '1',
            '2',
            '3',
            '4',
            '5',
            'noanswer',
            'caller',
            'batch24reg',
            'batch24unreg',
            't1',
            't2',
            't3',
            't4',
            't5',
            't6',
            't7',
            't8',
        ]);
        // Первый элемент — sample: id реестра + имя отчёта (case_1).
        const first: { id: string; name: string } = body.cases[0];
        expect(first).toEqual({ id: '1', name: 'case_1' });
    });

    it('стимулы t1..t8 в реестре, но вне all (in_all: false, doc/task_23_plan_2.md)', () =>
    {
        const all = cases_for_all();
        for (const id of ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'])
        {
            expect(implemented_cases()).toContain(id);
            expect(all).not.toContain(id);
        }
        // Основные кейсы остаются в all (тот же список, что был до стимулов).
        expect(all).toEqual([
            '1',
            '2',
            '3',
            '4',
            '5',
            'noanswer',
            'caller',
            'batch24reg',
            'batch24unreg',
        ]);
    });
});

describe('POST /api/test_runs', () =>
{
    it('202 — очередь: {id, status}, прогон case 1 доходит до PASS с отчётом', async () =>
    {
        const post = await request(app)
            .post('/api/test_runs')
            .send({ case: 1 })
            .expect(202);
        expect(post.body.id).toMatch(/^run_\d{8}T\d{6}Z_case1$/);
        expect(post.body.status).toBe('running');

        // Очередь исполняет прогон асинхронно — перечитываем запись до 'done'.
        type RunBody = {
            status: string;
            verdicts?: {
                case: string;
                verdict: string;
                verdict_text: string;
                report: { json_path: string };
            }[];
            events?: { kind: string; direction: string; sip_code?: number }[];
        };
        let body: RunBody = { status: 'running' };
        for (let i = 0; i < 300 && body.status !== 'done'; i++)
        {
            body = (await request(app).get(`/api/test_runs/${post.body.id}`).expect(200))
                .body;
            if (body.status !== 'done') await new Promise((r) => setTimeout(r, 10));
        }
        expect(body.status).toBe('done');
        expect(body.verdicts).toHaveLength(1);
        const v = body.verdicts![0]; // массив гарантирован toHaveLength выше
        expect(v.case).toBe('case_1');
        expect(v.verdict).toBe('PASS');
        expect(v.verdict_text).toContain('регистрация 9404');
        expect(existsSync(v.report.json_path)).toBe(true);
        expect(existsSync(v.report.json_path.replace(/\.json$/, '.html'))).toBe(true);
        // журнал прогона (events) — цепочка REGISTER → 200 из мока станции.
        expect(
            body.events?.some((e) => e.kind === 'register' && e.direction === 'out'),
        ).toBe(true);
        expect(
            body.events?.some((e) => e.kind === 'register' && e.sip_code === 200),
        ).toBe(true);
    });

    it('202 — строковый id кейса "noanswer" тоже принимается', async () =>
    {
        const post = await request(app)
            .post('/api/test_runs')
            .send({ case: 'noanswer' })
            .expect(202);
        expect(post.body.id).toContain('_casenoanswer');
    });

    it('400 — без тела и с неизвестным кейсом', async () =>
    {
        await request(app).post('/api/test_runs').send({}).expect(400);
        const res = await request(app)
            .post('/api/test_runs')
            .send({ case: 99 })
            .expect(400);
        expect(res.body.error).toContain('case');
    });
});

describe('GET /api/test_runs/:id', () =>
{
    it('404 — неизвестный прогон', async () =>
    {
        const res = await request(app).get('/api/test_runs/run_no_such').expect(404);
        expect(res.body.error).toContain('run_no_such');
    });
});
