// Api-тесты /api/reports/* (plan_2.md п.9.2): список, просмотр и удаление
// отчётов по temp-каталогу, который наполняет реальный Journal.render_report
// (п.3, без сети). Покрыты коды: 200 (список/JSON/id), пустой список, 400
// (некорректный id — safe_id), 404 (нет файла); удаление — DELETE /:id (200/
// 404/400, снимаются все три файла отчёта) и DELETE / (200, каталог пуст);
// заодно — статика /reports/<id>.html (п.5.1).
// related: server/controllers/reports_controller.ts, server/journal.ts.

import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { Journal } from '../../server/journal';
import { make_api_app, temp_dir } from './helpers';

let root: string;
let cleanup: () => void;
let app: Express;
let reports_dir: string;

const META = {
    case: 'case_1',
    verdict: 'PASS' as const,
    verdict_text: 'регистрация 9404 подтверждена: REGISTER → 200',
    pbx_host: '192.168.80.157',
    pbx_port: 5060,
    sip_protocol: 'udp',
    subscribers: ['9404', '52', '3203'],
};

beforeAll(() =>
{
    const t = temp_dir();
    root = t.dir;
    cleanup = t.cleanup;
    reports_dir = join(root, 'reports');
    const journal = new Journal({ reports_dir });
    journal.log('9404', 'out', 'register', { detail: 'REGISTER → 9404' });
    journal.log('9404', 'in', 'register', { code: 200, detail: '200 OK для REGISTER' });
    journal.render_report(META);
    app = make_api_app({ root }).app;
});

afterAll(() => cleanup());

describe('GET /api/reports', () =>
{
    it('200 — список с путями ко всем трём представлениям', async () =>
    {
        const res = await request(app).get('/api/reports').expect(200);
        expect(res.body.reports).toHaveLength(1);
        const r = res.body.reports[0];
        expect(r.id.endsWith('_case_1')).toBe(true); // имя = <UTC-метка>_<кейс>
        expect(r.json).toBe(`/api/reports/${encodeURIComponent(r.id)}`);
        expect(r.md).toBe(`/reports/${r.id}.md`);
        expect(r.html).toBe(`/reports/${r.id}.html`);
        expect(r.size).toBeGreaterThan(0);
    });

    it('200 — пустой список на пустом каталоге', async () =>
    {
        const empty = make_api_app({ root: temp_dir().dir }).app;
        const res = await request(empty).get('/api/reports').expect(200);
        expect(res.body).toEqual({ reports: [] });
    });
});

describe('GET /api/reports/:id', () =>
{
    it('200 — распарсенный JSON отчёта (meta+events)', async () =>
    {
        const list = await request(app).get('/api/reports').expect(200);
        const id = list.body.reports[0].id;
        const res = await request(app).get(`/api/reports/${id}`).expect(200);
        expect(res.body.id).toBe(id);
        expect(res.body.meta).toMatchObject({
            case: 'case_1',
            verdict: 'PASS',
            pbx_host: '192.168.80.157',
        });
        expect(res.body.events.map((e: { kind: string }) => e.kind)).toEqual([
            'register',
            'register',
        ]);
    });

    it('400 — некорректный id (safe_id: «..», пробел)', async () =>
    {
        await request(app).get('/api/reports/..').expect(400);
        await request(app)
            .get(`/api/reports/${encodeURIComponent('bad name')}`)
            .expect(400);
    });

    it('404 — отчёта нет на диске', async () =>
    {
        const res = await request(app)
            .get('/api/reports/20260101T000000Z_case_9')
            .expect(404);
        expect(res.body.error).toContain('не найден');
    });
});

// Удаление — на своём app/temp-каталоге с двумя отчётами: тесты ниже по
// порядку делят один каталог, удаление не должно ломать соседние кейсы.
describe('DELETE /api/reports/:id и DELETE /api/reports', () =>
{
    let d_dir: string;
    let d_cleanup: () => void;
    let d_app: Express;
    let d_reports_dir: string;

    beforeAll(() =>
    {
        const t = temp_dir();
        d_dir = t.dir;
        d_cleanup = t.cleanup;
        d_reports_dir = join(d_dir, 'reports');
        const journal = new Journal({ reports_dir: d_reports_dir });
        journal.log('9404', 'out', 'register', { detail: 'REGISTER → 9404' });
        journal.render_report({ ...META, case: 'case_1' });
        journal.render_report({
            ...META,
            case: 'case_2',
            verdict: 'FAIL',
            verdict_text: 'нет 200 на REGISTER',
        });
        d_app = make_api_app({ root: d_dir }).app;
    });

    afterAll(() => d_cleanup());

    it('200 — снимается вся триада файлов (.json/.md/.html), список пустеет', async () =>
    {
        const list = await request(d_app).get('/api/reports').expect(200);
        expect(list.body.reports).toHaveLength(2);
        const id = list.body.reports[0].id;
        const res = await request(d_app).delete(`/api/reports/${id}`).expect(200);
        expect(res.body.deleted).toBe(id);
        for (const ext of ['.json', '.md', '.html'])
        {
            expect(existsSync(join(d_reports_dir, id + ext))).toBe(false);
        }
        const after = await request(d_app).get('/api/reports').expect(200);
        expect(after.body.reports.map((r: { id: string }) => r.id)).toEqual([
            list.body.reports[1].id,
        ]);
    });

    it('400 — некорректный id (safe_id)', async () =>
    {
        await request(d_app).delete('/api/reports/..').expect(400);
    });

    it('404 — отчёта нет на диске', async () =>
    {
        const res = await request(d_app)
            .delete('/api/reports/20260101T000000Z_case_9')
            .expect(404);
        expect(res.body.error).toContain('не найден');
    });

    it('200 — DELETE / чистит каталог целиком, id удалённых в ответе', async () =>
    {
        const list = await request(d_app).get('/api/reports').expect(200);
        const ids = list.body.reports.map((r: { id: string }) => r.id);
        expect(ids.length).toBeGreaterThan(0);
        const res = await request(d_app).delete('/api/reports').expect(200);
        expect(res.body.count).toBe(ids.length);
        expect([...res.body.deleted].sort()).toEqual([...ids].sort());
        expect(readdirSync(d_reports_dir)).toEqual([]);
        const after = await request(d_app).get('/api/reports').expect(200);
        expect(after.body).toEqual({ reports: [] });
    });

    it('200 — DELETE / на пустом каталоге (count 0, идемпотентность)', async () =>
    {
        const res = await request(d_app).delete('/api/reports').expect(200);
        expect(res.body).toEqual({ deleted: [], count: 0 });
    });
});

describe('статика /reports', () =>
{
    it(
        'GET /reports/<id>.html — HTML-отчёт ' + 'открывается (п.5.1, страница п.6)',
        async () =>
        {
            const list = await request(app).get('/api/reports').expect(200);
            const id = list.body.reports[0].id;
            const res = await request(app).get(`/reports/${id}.html`).expect(200);
            expect(res.headers['content-type']).toContain('text/html');
            expect(res.text).toContain('Отчёт прогона');
        },
    );
});

// Маршрут вне карты — JSON 404 (not_found_handler app.ts), не html-заглушка.
it('GET /api/unknown-маршрут → JSON 404', async () =>
{
    const res = await request(app).get('/api/nope').expect(404);
    expect(res.body.error).toContain('Маршрут не найден');
});

// Файл отчёта с «неправильным» расширением в список не попадает — контроллер
// фильтрует *.json.
it('список игнорирует не-json файлы каталога', async () =>
{
    writeFileSync(join(reports_dir, 'заметка.txt'), 'не отчёт');
    const res = await request(app).get('/api/reports').expect(200);
    expect(res.body.reports.map((r: { id: string }) => r.id)).not.toContain(
        'заметка.txt',
    );
});
