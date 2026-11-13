// Api-тесты /api/calls/* (plan_2.md п.9.2): реестр вызовов и команды
// answer/reject/hangup поверх мока SipPool (DI, без сети). Покрыты коды:
// 201 (создание), 200 (чтение/действия), 400 (тело/код отклонения),
// 404 (нет записи/номера), 409 (не зарегистрирован, уже в вызове, нет
// входящего). Порядок вызовов в реестре — order() по id записей.
// related: server/controllers/calls_controller.ts, server/sip_pool.ts (CallRecord).

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

/** Пара {приложение, мок} на чистом моке; состояние пула мутируется запросами. */
function fresh(): { app: Express; pool: MockPool }
{
    const pool = new MockPool(API_CONFIG);
    return { app: make_api_app({ root, pool }).app, pool };
}

/** Зарегистрировать обоих абонентов (через API, как это сделал бы клиент). */
async function register_both(app: Express): Promise<void>
{
    await request(app).post('/api/subscribers/9404/register').expect(200);
    await request(app).post('/api/subscribers/52/register').expect(200);
}

describe('POST /api/calls', () =>
{
    it('201 — запись реестра {call_id, from, to, state CALL_OUT, owner}', async () =>
    {
        const { app } = fresh();
        await register_both(app);
        const res = await request(app)
            .post('/api/calls')
            .send({ from: '9404', to: '52' })
            .expect(201);
        expect(res.body.call).toMatchObject({
            from: '9404',
            to: '52',
            state: 'CALL_OUT',
            direction: 'out',
            owner: '9404',
            ended_at: 0,
        });
        expect(res.body.call.call_id).toBeTruthy();
    });

    it('400 — без тела / не-строки / self-call', async () =>
    {
        const { app } = fresh();
        await register_both(app);
        await request(app).post('/api/calls').send({}).expect(400);
        await request(app).post('/api/calls').send({ from: 9404, to: '52' }).expect(400);
        await request(app)
            .post('/api/calls')
            .send({ from: '9404', to: '9404' })
            .expect(400);
    });

    it(
        '404 — неизвестный абонент (пул), 403 — звонит 3203, ' +
            '409 — не зарегистрирован',
        async () =>
        {
            const { app } = fresh();
            await request(app)
                .post('/api/calls')
                .send({ from: '777', to: '52' })
                .expect(404);
            await request(app)
                .post('/api/calls')
                .send({ from: '3203', to: '52' })
                .expect(403);
            await request(app)
                .post('/api/calls')
                .send({ from: '9404', to: '52' })
                .expect(409); // ещё не REGISTERED
        },
    );

    it('409 — абонент уже в вызове (один активный диалог на ногу)', async () =>
    {
        const { app } = fresh();
        await register_both(app);
        await request(app)
            .post('/api/calls')
            .send({ from: '9404', to: '52' })
            .expect(201);
        await request(app)
            .post('/api/calls')
            .send({ from: '9404', to: '52' })
            .expect(409);
    });
});

describe('GET /api/calls, GET /api/calls/:id', () =>
{
    it('список и чтение по id', async () =>
    {
        const { app } = fresh();
        await register_both(app);
        const created = await request(app)
            .post('/api/calls')
            .send({ from: '9404', to: '52' })
            .expect(201);
        const list = await request(app).get('/api/calls').expect(200);
        expect(list.body.calls.map((c: { call_id: string }) => c.call_id)).toContain(
            created.body.call.call_id,
        );
        const one = await request(app)
            .get(`/api/calls/${created.body.call.call_id}`)
            .expect(200);
        expect(one.body.call).toEqual(created.body.call);
    });

    it('404 — неизвестный id', async () =>
    {
        const { app } = fresh();
        await request(app).get('/api/calls/does-not-exist').expect(404);
    });
});

describe('POST /api/calls/:id/answer|reject|hangup', () =>
{
    it('answer по входящему id — 200, обе ноги IN_CALL', async () =>
    {
        const { app, pool } = fresh();
        await register_both(app);
        await request(app)
            .post('/api/calls')
            .send({ from: '9404', to: '52' })
            .expect(201);
        const inbound = pool.list_calls().find((c) => c.direction === 'in')!;
        const res = await request(app)
            .post(`/api/calls/${inbound.call_id}/answer`)
            .expect(200);
        expect(res.body.call.state).toBe('IN_CALL');
        expect(pool.get_call(inbound.call_id)?.state).toBe('IN_CALL');
        const outbound = pool.list_calls().find((c) => c.direction === 'out')!;
        expect(outbound.state).toBe('IN_CALL');
    });

    it('answer по исходящему id — 409 (входящего у вызывающего нет)', async () =>
    {
        const { app, pool } = fresh();
        await register_both(app);
        const created = await request(app)
            .post('/api/calls')
            .send({ from: '9404', to: '52' })
            .expect(201);
        await request(app)
            .post(`/api/calls/${created.body.call.call_id}/answer`)
            .expect(409);
    });

    it('reject — 200, код отклонения из тела, обе ноги завершены', async () =>
    {
        const { app, pool } = fresh();
        await register_both(app);
        await request(app)
            .post('/api/calls')
            .send({ from: '9404', to: '52' })
            .expect(201);
        const inbound = pool.list_calls().find((c) => c.direction === 'in')!;
        const res = await request(app)
            .post(`/api/calls/${inbound.call_id}/reject`)
            .send({ code: 603 })
            .expect(200);
        expect(res.body.call.state).toBe('REGISTERED');
        expect(res.body.call.ended_at).toBeGreaterThan(0);
        for (const c of pool.list_calls()) expect(c.ended_at).toBeGreaterThan(0);
    });

    it('reject — 400 на невалидный code, 404 на неизвестный id', async () =>
    {
        const { app, pool } = fresh();
        await register_both(app);
        await request(app)
            .post('/api/calls')
            .send({ from: '9404', to: '52' })
            .expect(201);
        const inbound = pool.list_calls().find((c) => c.direction === 'in')!;
        await request(app)
            .post(`/api/calls/${inbound.call_id}/reject`)
            .send({ code: 200 })
            .expect(400);
        await request(app)
            .post(`/api/calls/${inbound.call_id}/reject`)
            .send({ code: 'abc' })
            .expect(400);
        await request(app).post('/api/calls/no-such-id/reject').send({}).expect(404);
    });

    it('hangup — 200 после разговора, запись завершена', async () =>
    {
        const { app, pool } = fresh();
        await register_both(app);
        await request(app)
            .post('/api/calls')
            .send({ from: '9404', to: '52' })
            .expect(201);
        const inbound = pool.list_calls().find((c) => c.direction === 'in')!;
        await request(app).post(`/api/calls/${inbound.call_id}/answer`).expect(200);
        const outbound = pool.list_calls().find((c) => c.direction === 'out')!;
        const res = await request(app)
            .post(`/api/calls/${outbound.call_id}/hangup`)
            .expect(200);
        expect(res.body.call.ended_at).toBeGreaterThan(0);
        expect(res.body.call.state).toBe('REGISTERED');
    });

    it('hangup без активного вызова — 409; hangup по неизвестному id — 404', async () =>
    {
        const { app, pool } = fresh();
        await register_both(app);
        await request(app)
            .post('/api/calls')
            .send({ from: '9404', to: '52' })
            .expect(201);
        const outbound = pool.list_calls().find((c) => c.direction === 'out')!;
        await request(app).post(`/api/calls/${outbound.call_id}/hangup`).expect(200);
        await request(app).post(`/api/calls/${outbound.call_id}/hangup`).expect(409);
        await request(app).post('/api/calls/no-such-id/hangup').expect(404);
    });
});
