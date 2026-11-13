// Api-тесты ресурса станции (plan_4.md п.6): /api/station через DI-мок Station
// (без сокетов) — коды 200/409/502/400, форма JSON статуса и журнала, блок
// station в /api/health; приложение БЕЗ станции — честный 404 на весь ресурс
// (router монтируется только при deps.station). Сеть и порты не используются.
// related: server/controllers/station_controller.ts, tests/api/helpers.ts
// (make_api_app со станцией), tests/api/health.test.ts (образец).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { make_api_app, temp_dir } from './helpers';
import type { Station, StationEvent, StationStatus } from '../../server/station/station';

/**
 * Мок станции: состояния и текст ошибки bind — public-поля теста; сокетов нет.
 */
class MockStation implements Station
{
    mock_state: StationStatus['state'] = 'stopped';
    /** Непустой текст → start() бросает Error с ним (имитация bind-ошибки). */
    start_error = '';
    /** SAS-флаг мока (план 6) — endpoint-ы SAS читают состояние станции. */
    sas_on = false;
    /** Флаг «не отвечать на вызовы» (doc/task_29) — его переключает endpoint. */
    silent_on = false;
    /** Флаг «перенаправлять INVITE» (doc/task_32_plan_2.md) — тем более. */
    forward_on = false;
    /** Флаг «игнорировать Trying/Ringing» (doc/task_36_plan_2.md). */
    ignore_on = false;
    /** Флаг «умножать перенаправляемый INVITE ×10» (doc/task_37_plan_2.md). */
    multiply_on = false;
    readonly internal_events: StationEvent[] = [
        {
            ts: '2026-11-05T10:00:21.000Z',
            peer: '192.168.80.157:5060',
            proto: 'udp',
            method: 'OPTIONS',
            ruri: 'sip:192.168.80.159:5060',
            cseq: '16570 OPTIONS',
            call_id: 'ka-1',
            code: 200,
            event: '',
        },
        {
            ts: '2026-11-05T10:00:20.000Z',
            peer: '192.168.80.157:5061',
            proto: 'tcp',
            method: 'REGISTER',
            ruri: 'sip:192.168.80.159:5060',
            cseq: '1 REGISTER',
            call_id: 'reg-1',
            code: 405,
            event: '',
        },
    ];

    sas_mode(): boolean
    {
        return this.sas_on;
    }

    set_sas_mode(on: boolean): void
    {
        this.sas_on = on;
    }

    silent_invite_mode(): boolean
    {
        return this.silent_on;
    }

    set_silent_invite(on: boolean): void
    {
        this.silent_on = on;
    }

    forward_invite_mode(): boolean
    {
        return this.forward_on;
    }

    set_forward_invite(on: boolean): void
    {
        this.forward_on = on;
    }

    ignore_provisional_mode(): boolean
    {
        return this.ignore_on;
    }

    set_ignore_provisional(on: boolean): void
    {
        this.ignore_on = on;
    }

    multiply_invite_mode(): boolean
    {
        return this.multiply_on;
    }

    set_multiply_invite(on: boolean): void
    {
        this.multiply_on = on;
    }

    status(): StationStatus
    {
        return {
            state: this.mock_state,
            host: '192.168.80.159',
            port: 5060,
            proto: 'both',
            uptime_s: this.mock_state === 'running' ? 42 : 0,
            counters: {
                requests_in: { OPTIONS: 3, REGISTER: 1 },
                answered: { '200': 3, '405': 1 },
                ignored: 1,
                peers: ['192.168.80.157:5060'],
            },
            last_keepalive_at: '2026-11-05T10:00:21.000Z',
            error: '',
            silent_invite: this.silent_on,
            forward_invite: this.forward_on,
            ignore_provisional: this.ignore_on,
            multiply_invite: this.multiply_on,
            last_downstream: '',
        };
    }

    events(limit?: number): StationEvent[]
    {
        return this.internal_events.slice(0, limit ?? 200);
    }

    async start(): Promise<void>
    {
        if (this.start_error) throw new Error(this.start_error);
        this.mock_state = 'running';
    }

    async stop(): Promise<void>
    {
        this.mock_state = 'stopped';
    }
}

let app: Express;
let station: MockStation;
let app_no_station: Express;
let cleanup: () => void;

beforeAll(() =>
{
    const t = temp_dir();
    cleanup = t.cleanup;
    station = new MockStation();
    app = make_api_app({ root: t.dir, station }).app;
    app_no_station = make_api_app({ root: t.dir }).app;
});

afterAll(() => cleanup());

describe('GET /api/station', () =>
{
    it('200 — форма статуса: state/host/port/proto, uptime, счётчики', async () =>
    {
        const res = await request(app).get('/api/station').expect(200);
        expect(res.body.state).toBe('stopped');
        expect(res.body.host).toBe('192.168.80.159');
        expect(res.body.port).toBe(5060);
        expect(res.body.proto).toBe('both');
        expect(res.body.uptime_s).toBe(0);
        expect(res.body.counters).toEqual({
            requests_in: { OPTIONS: 3, REGISTER: 1 },
            answered: { '200': 3, '405': 1 },
            ignored: 1,
            peers: ['192.168.80.157:5060'],
        });
        expect(res.body.last_keepalive_at).toBe('2026-11-05T10:00:21.000Z');
        expect(res.body.error).toBe('');
        expect(res.body.silent_invite).toBe(false); // настройка из task_29
        expect(res.body.forward_invite).toBe(false); // настройка из task_32
        expect(res.body.ignore_provisional).toBe(false); // настройка из task_36
        expect(res.body.multiply_invite).toBe(false); // настройка из task_37
    });
});

describe('POST /api/station/silent_invite (не отвечать на INVITE, doc/task_29)', () =>
{
    it('{"on":true} → 200 со статусом silent_invite=true, {"on":false} — обратно', async () =>
    {
        const on = await request(app)
            .post('/api/station/silent_invite')
            .send({ on: true })
            .expect(200);
        expect(on.body.silent_invite).toBe(true);
        expect(station.silent_on).toBe(true);
        const off = await request(app)
            .post('/api/station/silent_invite')
            .send({ on: false })
            .expect(200);
        expect(off.body.silent_invite).toBe(false);
        expect(station.silent_on).toBe(false);
    });

    it('без on / on не boolean — 400, флаг не меняется', async () =>
    {
        await request(app).post('/api/station/silent_invite').send({}).expect(400);
        await request(app)
            .post('/api/station/silent_invite')
            .send({ on: 'да' })
            .expect(400);
        expect(station.silent_on).toBe(false);
    });
});

describe('POST /api/station/forward_invite (перенаправление INVITE, doc/task_32_plan_2.md)', () =>
{
    it('{"on":true} → 200 со статусом forward_invite=true, {"on":false} — обратно', async () =>
    {
        const on = await request(app)
            .post('/api/station/forward_invite')
            .send({ on: true })
            .expect(200);
        expect(on.body.forward_invite).toBe(true);
        expect(station.forward_on).toBe(true);
        const off = await request(app)
            .post('/api/station/forward_invite')
            .send({ on: false })
            .expect(200);
        expect(off.body.forward_invite).toBe(false);
        expect(station.forward_on).toBe(false);
    });

    it('без on / on не boolean — 400, флаг не меняется', async () =>
    {
        await request(app).post('/api/station/forward_invite').send({}).expect(400);
        await request(app)
            .post('/api/station/forward_invite')
            .send({ on: 'да' })
            .expect(400);
        expect(station.forward_on).toBe(false);
    });
});

describe('POST /api/station/ignore_provisional (игнор 100/180, doc/task_36)', () =>
{
    it('{"on":true} → 200 ignore_provisional=true, выкл. — обратно', async () =>
    {
        const on = await request(app)
            .post('/api/station/ignore_provisional')
            .send({ on: true })
            .expect(200);
        expect(on.body.ignore_provisional).toBe(true);
        expect(station.ignore_on).toBe(true);
        const off = await request(app)
            .post('/api/station/ignore_provisional')
            .send({ on: false })
            .expect(200);
        expect(off.body.ignore_provisional).toBe(false);
        expect(station.ignore_on).toBe(false);
    });

    it('без on / on не boolean — 400, флаг не меняется', async () =>
    {
        await request(app).post('/api/station/ignore_provisional').send({}).expect(400);
        await request(app)
            .post('/api/station/ignore_provisional')
            .send({ on: 'да' })
            .expect(400);
        expect(station.ignore_on).toBe(false);
    });
});

describe('POST /api/station/multiply_invite (умножение INVITE ×10, doc/task_37)', () =>
{
    it('{"on":true} → 200 multiply_invite=true, выкл. — обратно', async () =>
    {
        const on = await request(app)
            .post('/api/station/multiply_invite')
            .send({ on: true })
            .expect(200);
        expect(on.body.multiply_invite).toBe(true);
        expect(station.multiply_on).toBe(true);
        const off = await request(app)
            .post('/api/station/multiply_invite')
            .send({ on: false })
            .expect(200);
        expect(off.body.multiply_invite).toBe(false);
        expect(station.multiply_on).toBe(false);
    });

    it('без on / on не boolean — 400, флаг не меняется', async () =>
    {
        await request(app).post('/api/station/multiply_invite').send({}).expect(400);
        await request(app)
            .post('/api/station/multiply_invite')
            .send({ on: 'да' })
            .expect(400);
        expect(station.multiply_on).toBe(false);
    });
});

describe('POST /api/station/start и /stop', () =>
{
    it('start 200 → running, повторный start — 409', async () =>
    {
        const ok = await request(app).post('/api/station/start').expect(200);
        expect(ok.body.state).toBe('running');
        expect(ok.body.uptime_s).toBe(42);
        const again = await request(app).post('/api/station/start').expect(409);
        expect(again.body.error).toContain('уже запущена');
    });

    it('stop 200 → stopped, повторный stop — 409', async () =>
    {
        const ok = await request(app).post('/api/station/stop').expect(200);
        expect(ok.body.state).toBe('stopped');
        await request(app).post('/api/station/stop').expect(409);
    });

    it('bind не удался (EACCES) — 502 с текстом сервиса, сервер жив', async () =>
    {
        station.start_error =
            'Не поднять станцию 192.168.80.159:5060: EACCES ' +
            '(порт привилегированный)';
        const res = await request(app).post('/api/station/start').expect(502);
        expect(res.body.error).toContain('EACCES');
        station.start_error = '';
        await request(app).get('/api/health').expect(200);
        expect(station.mock_state).toBe('stopped');
    });
});

describe('GET /api/station/events', () =>
{
    it('200 — журнал newest first, поля строк', async () =>
    {
        const res = await request(app).get('/api/station/events').expect(200);
        expect(res.body.events).toHaveLength(2);
        expect(res.body.events[0].method).toBe('OPTIONS');
        expect(res.body.events[0].code).toBe(200);
        expect(res.body.events[1].proto).toBe('tcp');
    });

    it('limit работает; битый limit — 400', async () =>
    {
        const limited = await request(app).get('/api/station/events?limit=1').expect(200);
        expect(limited.body.events).toHaveLength(1);
        await request(app).get('/api/station/events?limit=abc').expect(400);
        await request(app).get('/api/station/events?limit=0').expect(400);
    });
});

describe('Станция в health и без DI', () =>
{
    it('/api/health — блок station (state/host/port)', async () =>
    {
        const res = await request(app).get('/api/health').expect(200);
        expect(res.body.station).toEqual({
            state: 'stopped',
            host: '192.168.80.159',
            port: 5060,
        });
    });

    it('приложение без станции — 404 на весь /api/station, health без блока', async () =>
    {
        await request(app_no_station).get('/api/station').expect(404);
        await request(app_no_station).post('/api/station/start').expect(404);
        const res = await request(app_no_station).get('/api/health').expect(200);
        expect(res.body.station).toBeUndefined();
    });
});
