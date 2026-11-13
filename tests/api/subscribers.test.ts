// Api-тесты /api/subscribers/* (plan_2.md п.9.2): список, регистрация и снятие
// через мок SipPool (DI, без сети). Покрыты коды: 200 (идемпотентная
// регистрация), 403 (3203 — только цель вызова), 404 (неизвестный номер),
// 502 + sip_code (станция отвергла REGISTER — поле status у PoolError).
// related: server/controllers/subscribers_controller.ts,
// server/middleware/error_handler.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { API_CONFIG, make_api_app, MockPool, temp_dir } from './helpers';

let root: string;
let cleanup: () => void;

beforeAll(() =>
{
    const t = temp_dir();
    root = t.dir;
    cleanup = t.cleanup;
});

afterAll(() => cleanup());

/** Свежее приложение на чистом моке (мок пула мутирует состояния). */
function fresh_app(pool?: MockPool): Express
{
    return make_api_app({ root, pool }).app;
}

describe('GET /api/subscribers', () =>
{
    it('отдаёт всех абонентов конфига с флагом can_register', async () =>
    {
        const res = await request(fresh_app()).get('/api/subscribers').expect(200);
        expect(res.body.subscribers).toEqual([
            {
                number: '9404',
                can_register: true,
                state: 'ABSENT',
                peer: '',
                error: '',
                registering: false,
            },
            {
                number: '52',
                can_register: true,
                state: 'ABSENT',
                peer: '',
                error: '',
                registering: false,
            },
            {
                number: '3203',
                can_register: false,
                state: 'ABSENT',
                peer: '',
                error: '',
                registering: false,
            },
        ]);
    });
});

describe('POST /api/subscribers/:number/register', () =>
{
    it('200 — итог регистрации, состояние становится REGISTERED', async () =>
    {
        const pool = fresh_pool();
        const app = make_api_app({ root, pool }).app;
        const res = await request(app).post('/api/subscribers/9404/register').expect(200);
        expect(res.body).toEqual({ number: '9404', ok: true, code: 0, text: '' });
        const list = await request(app).get('/api/subscribers').expect(200);
        expect(
            list.body.subscribers.find((s: { number: string }) => s.number === '9404')
                .state,
        ).toBe('REGISTERED');
    });

    it('200 — повторная регистрация идемпотентна (критерий п.4 через API)', async () =>
    {
        const pool = fresh_pool();
        const app = make_api_app({ root, pool }).app;
        await request(app).post('/api/subscribers/9404/register').expect(200);
        const res = await request(app).post('/api/subscribers/9404/register').expect(200);
        expect(res.body.ok).toBe(true);
    });

    it('403 — регистрация запрещена для 3203 (только цель вызова)', async () =>
    {
        const res = await request(fresh_app())
            .post('/api/subscribers/3203/register')
            .expect(403);
        expect(res.body.error).toContain('3203');
    });

    it('404 — неизвестный абонент', async () =>
    {
        await request(fresh_app())
            .post('/api/subscribers/777/register')
            .expect(404)
            .expect((r) =>
            {
                expect(r.body.error).toContain('777');
            });
    });

    it('502 + sip_code=401 — станция отвергла REGISTER (PoolError→HTTP)', async () =>
    {
        const pool = new MockPool(API_CONFIG, undefined, true);
        const res = await request(make_api_app({ root, pool }).app)
            .post('/api/subscribers/9404/register')
            .expect(502);
        expect(res.body.error).toContain('REGISTER');
        expect(res.body.sip_code).toBe(401);
    });

    it('400 — битый JSON в теле (express.json → error_handler)', async () =>
    {
        await request(fresh_app())
            .post('/api/subscribers/9404/register')
            .set('content-type', 'application/json')
            .send('{"ok":')
            .expect(400);
    });
});

describe('DELETE /api/subscribers/:number/register', () =>
{
    it('200 {number, ok:true} — абонент снят (UNREGISTERED)', async () =>
    {
        const pool = fresh_pool();
        const app = make_api_app({ root, pool }).app;
        await request(app).post('/api/subscribers/9404/register').expect(200);
        const res = await request(app)
            .delete('/api/subscribers/9404/register')
            .expect(200);
        expect(res.body).toEqual({ number: '9404', ok: true });
        const list = await request(app).get('/api/subscribers');
        expect(
            list.body.subscribers.find((s: { number: string }) => s.number === '9404')
                .state,
        ).toBe('UNREGISTERED');
    });

    it('404 — неизвестный абонент', async () =>
    {
        await request(fresh_app()).delete('/api/subscribers/777/register').expect(404);
    });
});

function fresh_pool(): MockPool
{
    return new MockPool(API_CONFIG);
}
