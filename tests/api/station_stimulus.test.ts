// Api-тесты стимульного ресурса станции (doc/task_26): /api/station/stimulus*
// через DI-мок StationStimulusApi (без сокетов и АТС) — коды 200/202/400/409,
// форма статуса+списка кейсов, порядок остановки «сначала стимул, потом
// станция» в POST /api/station/stop; приложение со станцией, но без движка —
// 404 на /stimulus*. Сеть и порты не используются.
// related: server/controllers/station_controller.ts, server/station/stimulus.ts
// (StationStimulusApi), tests/api/helpers.ts, tests/api/station.test.ts (мок
// станции — образец).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { make_api_app, temp_dir } from './helpers';
import type {
    StationStimulusApi,
    StimulusCaseInfo,
    StimulusStatus,
} from '../../server/station/stimulus';
import type { Station, StationEvent, StationStatus } from '../../server/station/station';

/**
 * Мок движка: состояние прогона — public-поля теста; сокетов нет, фаз нет.
 */
class MockStimulus implements StationStimulusApi
{
    mock_state: StimulusStatus['state'] = 'idle';
    mock_id = '';
    /** Непустой текст → start() бросает Error с ним (имитация гонки POST). */
    start_error = '';
    start_calls: string[] = [];
    stop_calls = 0;

    cases(): StimulusCaseInfo[]
    {
        return ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'].map((id) => ({
            id,
            title: `стимул ${id}`,
        }));
    }

    status(): StimulusStatus
    {
        const running = this.mock_state !== 'idle';
        return {
            state: this.mock_state,
            id: this.mock_id,
            started_at: running ? '2026-11-06T10:00:00.000Z' : '',
            uptime_s: running ? 7 : 0,
            log: running ? [`[${this.mock_id}] фаза: stim_start`] : [],
            summary: running ? '' : `стимул ${this.mock_id} сгенерирован`,
            error: '',
            csv: running ? `reports/los_${this.mock_id}_x.csv` : '',
        };
    }

    start(id: string): void
    {
        this.start_calls.push(id);
        if (this.start_error) throw new Error(this.start_error);
        this.mock_state = 'running';
        this.mock_id = id;
    }

    async stop(): Promise<void>
    {
        this.stop_calls += 1;
        this.mock_state = 'idle';
    }
}

/**
 * Мок станции: только состояние (движок проверяется своим моком); события —
 * пусто (журнал здесь не ассертится).
 */
class MockStation implements Station
{
    mock_state: StationStatus['state'] = 'running';
    sas_on = false;

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
        return false;
    }

    set_silent_invite(_on: boolean): void
    {
        /* мок: режим молчания на INVITE здесь не ассертится */
    }

    forward_invite_mode(): boolean
    {
        return false;
    }

    set_forward_invite(_on: boolean): void
    {
        /* мок: режим перенаправления INVITE здесь не ассертится */
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

    status(): StationStatus
    {
        return {
            state: this.mock_state,
            host: '192.168.80.159',
            port: 5060,
            proto: 'both',
            uptime_s: this.mock_state === 'running' ? 42 : 0,
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

    events(limit?: number): StationEvent[]
    {
        const events: StationEvent[] = [];
        return events.slice(0, limit ?? 200);
    }

    async start(): Promise<void>
    {
        this.mock_state = 'running';
    }

    async stop(): Promise<void>
    {
        this.mock_state = 'stopped';
    }
}

let app: Express;
let station: MockStation;
let stimulus: MockStimulus;
let app_no_stimulus: Express;
let cleanup: () => void;

beforeAll(() =>
{
    const t = temp_dir();
    cleanup = t.cleanup;
    station = new MockStation();
    stimulus = new MockStimulus();
    app = make_api_app({ root: t.dir, station, stimulus }).app;
    app_no_stimulus = make_api_app({ root: t.dir, station }).app;
});

afterAll(() => cleanup());

describe('GET /api/station/stimulus', () =>
{
    it('200 — status (idle) + cases t1..t8', async () =>
    {
        const res = await request(app).get('/api/station/stimulus').expect(200);
        expect(res.body.status.state).toBe('idle');
        expect(res.body.status.id).toBe('');
        expect(res.body.cases).toHaveLength(8);
        expect(res.body.cases[0]).toEqual({ id: 't1', title: 'стимул t1' });
        expect(res.body.cases[7].id).toBe('t8');
    });
});

describe('POST /api/station/stimulus {id}', () =>
{
    it('старт 202 → running; повторный старт занят — 409', async () =>
    {
        const ok = await request(app).post('/api/station/stimulus').send({ id: 't6' });
        expect(ok.status).toBe(202);
        expect(ok.body.state).toBe('running');
        expect(ok.body.id).toBe('t6');
        expect(stimulus.start_calls).toEqual(['t6']);
        const busy = await request(app)
            .post('/api/station/stimulus')
            .send({ id: 't1' })
            .expect(409);
        expect(busy.body.error).toContain('уже выполняется');
        expect(stimulus.start_calls).toEqual(['t6']);
        await request(app).post('/api/station/stimulus/stop').expect(200);
    });

    it('битое тело и неизвестный id — 400 без запуска', async () =>
    {
        await request(app).post('/api/station/stimulus').send({}).expect(400);
        await request(app).post('/api/station/stimulus').send({ id: 't9' }).expect(400);
        await request(app).post('/api/station/stimulus').send({ id: 7 }).expect(400);
        expect(stimulus.start_calls).toEqual(['t6']);
    });

    it('станция остановлена — 409 (стимул идёт через её сокет)', async () =>
    {
        station.mock_state = 'stopped';
        const res = await request(app)
            .post('/api/station/stimulus')
            .send({ id: 't2' })
            .expect(409);
        expect(res.body.error).toContain('Станция остановлена');
        station.mock_state = 'running';
    });

    it('движок бросил (гонка POST) — 409 с его текстом', async () =>
    {
        stimulus.start_error = 'Стимул «t3» уже выполняется';
        const res = await request(app)
            .post('/api/station/stimulus')
            .send({ id: 't3' })
            .expect(409);
        expect(res.body.error).toContain('Стимул «t3» уже выполняется');
        stimulus.start_error = '';
        stimulus.start_calls = [];
    });
});

describe('POST /api/station/stimulus/stop', () =>
{
    it('200 → idle; повторный stop (idle) — 409', async () =>
    {
        await request(app).post('/api/station/stimulus').send({ id: 't1' }).expect(202);
        const res = await request(app).post('/api/station/stimulus/stop').expect(200);
        expect(res.body.state).toBe('idle');
        await request(app).post('/api/station/stimulus/stop').expect(409);
    });
});

describe('POST /api/station/stop гасит стимул раньше станции', () =>
{
    it('идёт зачистка прогона, потом снятие слушателя', async () =>
    {
        station.mock_state = 'running';
        await request(app).post('/api/station/stimulus').send({ id: 't4' }).expect(202);
        stimulus.stop_calls = 0;
        const res = await request(app).post('/api/station/stop').expect(200);
        expect(res.body.state).toBe('stopped');
        expect(stimulus.stop_calls).toBe(1);
        expect(stimulus.mock_state).toBe('idle');
        station.mock_state = 'running';
    });
});

describe('Стимулы без DI', () =>
{
    it('станция есть, движка нет — 404 на /stimulus*', async () =>
    {
        await request(app_no_stimulus).get('/api/station/stimulus').expect(404);
        await request(app_no_stimulus)
            .post('/api/station/stimulus')
            .send({ id: 't1' })
            .expect(404);
        await request(app_no_stimulus).post('/api/station/stimulus/stop').expect(404);
    });
});
