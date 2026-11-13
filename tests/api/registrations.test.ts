// Api-тесты таблицы регистраций (doc/task_33_plan_2.md): эндпоинты 36-39
// /api/station/registrations* — CRUD-коды 200/201/400/404/409 rails-style.
// Хранилище — РЕАЛЬНЫЙ класс StationRegistrations (оно без сети, DI-контракт
// соблюдает), мок — только контракт Station (по образцу station_sas.test.ts).
// Честный 404 без DI проверяется приложением со станцией, но без хранилища.
// Сеть не нужна. Запуск: npm run test:api.
// related: server/controllers/station_controller.ts,
// server/station/registrations.ts, tests/api/helpers.ts (make_api_app).

import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { make_api_app, temp_dir } from './helpers';
import type { Station, StationEvent, StationStatus } from '../../server/station/station';
import { StationRegistrations } from '../../server/station/registrations';

class MockStation implements Station
{
    status(): StationStatus
    {
        return {
            state: 'running',
            host: '127.0.0.1',
            port: 5060,
            proto: 'udp',
            uptime_s: 1,
            counters: { requests_in: {}, answered: {}, ignored: 0, peers: [] },
            last_keepalive_at: '',
            error: '',
            silent_invite: false,
            forward_invite: false,
            ignore_provisional: false,
            multiply_invite: false,
            last_downstream: '',
        };
    }

    sas_mode(): boolean
    {
        return false;
    }

    set_sas_mode(_on: boolean): void
    {
        /* мок: SAS здесь не ассертится */
    }

    silent_invite_mode(): boolean
    {
        return false;
    }

    set_silent_invite(_on: boolean): void
    {
        /* мок: молчание на INVITE здесь не ассертится */
    }

    forward_invite_mode(): boolean
    {
        return false;
    }

    set_forward_invite(_on: boolean): void
    {
        /* мок: перенаправление INVITE здесь не ассертится */
    }

    ignore_provisional_mode(): boolean
    {
        return false;
    }

    set_ignore_provisional(_on: boolean): void
    {
        /* мок: игнорирование Trying/Ringing здесь не ассертится */
    }

    multiply_invite_mode(): boolean
    {
        return false;
    }

    set_multiply_invite(_on: boolean): void
    {
        /* мок: умножение INVITE ×10 здесь не ассертится */
    }

    events(limit?: number): StationEvent[]
    {
        return [].slice(0, limit ?? 200) as StationEvent[];
    }

    async start(): Promise<void>
    {
        /* мок: слушатель не поднимается */
    }

    async stop(): Promise<void>
    {
        /* мок: слушатель не снимается */
    }
}

const t = temp_dir();

afterAll(() => t.cleanup());

/** Новое приложение со своим чистым хранилищем (тесты не наследуют строки). */
function fresh_app(): { app: Express; store: StationRegistrations }
{
    const store = new StationRegistrations();
    const app = make_api_app({
        root: t.dir,
        station: new MockStation(),
        registrations: store,
    }).app;
    return { app, store };
}

describe('GET /api/station/registrations', () =>
{
    it('200 — пустая таблица в форме {registrations: []}', async () =>
    {
        const { app } = fresh_app();
        const res = await request(app).get('/api/station/registrations').expect(200);
        expect(res.body).toEqual({ registrations: [] });
    });

    it('честный 404 без хранилища в DI (станция есть, /registrations нет)', async () =>
    {
        const app = make_api_app({ root: t.dir, station: new MockStation() }).app;
        await request(app).get('/api/station/registrations').expect(404);
        await request(app).post('/api/station/registrations').expect(404);
    });
});

describe('POST /api/station/registrations', () =>
{
    it('201 — ручная строка с номером и пустыми адресом/временем', async () =>
    {
        const { app } = fresh_app();
        const res = await request(app)
            .post('/api/station/registrations')
            .send({ identifier: 'u00s00p00', phone: '100' })
            .expect(201);
        expect(res.body.registration).toMatchObject({
            id: 1,
            identifier: 'u00s00p00',
            phone: '100',
            address: '',
            last_seen_at: '',
        });
    });

    it('400 — identifier не по форме/пуст, phone не по NUMBER_RE', async () =>
    {
        const { app } = fresh_app();
        await request(app)
            .post('/api/station/registrations')
            .send({ identifier: 'плохой identifier!' })
            .expect(400);
        await request(app)
            .post('/api/station/registrations')
            .send({ identifier: '' })
            .expect(400);
        await request(app)
            .post('/api/station/registrations')
            .send({ identifier: 'u00s00p00', phone: 'abc' })
            .expect(400);
    });

    it('409 — identifier уже занят (ручная или авто-строка)', async () =>
    {
        const { app, store } = fresh_app();
        store.record('u00s00p00', '192.168.80.157:5060');
        const res = await request(app)
            .post('/api/station/registrations')
            .send({ identifier: 'u00s00p00' })
            .expect(409);
        expect(res.body.error).toMatch(/уже есть/);
    });
});

describe('POST /api/station/registrations/:id/update', () =>
{
    it('200 — правка телефона; применяется к массиву (GET показывает)', async () =>
    {
        const { app } = fresh_app();
        const add = await request(app)
            .post('/api/station/registrations')
            .send({ identifier: 'u00s00p00' })
            .expect(201);
        const id = add.body.registration.id as number;
        const upd = await request(app)
            .post(`/api/station/registrations/${id}/update`)
            .send({ phone: '100' })
            .expect(200);
        expect(upd.body.registration).toMatchObject({ id, phone: '100' });
        const list = await request(app).get('/api/station/registrations').expect(200);
        expect(list.body.registrations[0].phone).toBe('100');
    });

    it('400 — :id не целое, пустое тело, поля не по форме', async () =>
    {
        const { app } = fresh_app();
        await request(app)
            .post('/api/station/registrations/x/update')
            .send({ phone: '100' })
            .expect(400);
        await request(app)
            .post('/api/station/registrations/1/update')
            .send({})
            .expect(400);
        await request(app)
            .post('/api/station/registrations/1/update')
            .send({ phone: 'нет-такого-номера' })
            .expect(400);
    });

    it('404 — нет такой строки; 409 — identifier занят другой строкой', async () =>
    {
        const { app } = fresh_app();
        await request(app)
            .post('/api/station/registrations/7/update')
            .send({ phone: '100' })
            .expect(404);
        await request(app)
            .post('/api/station/registrations')
            .send({ identifier: 'u00s00p00' })
            .expect(201);
        const second = await request(app)
            .post('/api/station/registrations')
            .send({ identifier: 'u00s00p01' })
            .expect(201);
        const res = await request(app)
            .post(`/api/station/registrations/${second.body.registration.id}/update`)
            .send({ identifier: 'u00s00p00' })
            .expect(409);
        expect(res.body.error).toMatch(/занят строкой/);
    });
});

describe('DELETE /api/station/registrations/:id', () =>
{
    it('200 — строка снята (повторный DELETE — 404)', async () =>
    {
        const { app } = fresh_app();
        const add = await request(app)
            .post('/api/station/registrations')
            .send({ identifier: 'u00s00p00', phone: '100' })
            .expect(201);
        const id = add.body.registration.id as number;
        await request(app)
            .delete(`/api/station/registrations/${id}`)
            .expect(200, { ok: true });
        const list = await request(app).get('/api/station/registrations').expect(200);
        expect(list.body.registrations).toEqual([]);
        await request(app).delete(`/api/station/registrations/${id}`).expect(404);
    });

    it('400 — :id не целое', async () =>
    {
        const { app } = fresh_app();
        await request(app).delete('/api/station/registrations/0').expect(400);
        await request(app).delete('/api/station/registrations/abc').expect(400);
    });
});
