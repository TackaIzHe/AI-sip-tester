// Api-тесты SAS-ресурса станции (план 6 п.4): /api/station/sas* через
// DI-мок StationSasApi (без сокетов и АТС) — форма статуса (state/subs/sent/
// answered/log), коды 200/409 на enable/disable, разведение SAS и стимула
// (409 в обе стороны), останов станции гасит SAS до снятия слушателя, блок
// sas в /api/health; приложение со станцией, но без SAS-движка — 404.
// related: server/controllers/station_controller.ts, server/station/sas.ts
// (StationSasApi), tests/api/helpers.ts, tests/api/station_stimulus.test.ts
// (образец мока).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { make_api_app, temp_dir } from './helpers';
import type { SasStatus, StationSasApi } from '../../server/station/sas';
import type {
    StationStimulusApi,
    StimulusCaseInfo,
    StimulusStatus,
} from '../../server/station/stimulus';
import type { Station, StationEvent, StationStatus } from '../../server/station/station';

/** Мок SAS-движка: состояние — public-поле; семантика ошибок как у движка. */
class MockSas implements StationSasApi
{
    mock_state: SasStatus['state'] = 'off';

    status(): SasStatus
    {
        return {
            state: this.mock_state,
            enabled_at: this.mock_state === 'on' ? '2026-11-09T10:00:00.000Z' : '',
            subs:
                this.mock_state === 'on'
                    ? [
                          {
                              call_id: 'sas-1',
                              event: 'ssw-srvm',
                              number: 'u00s00p00',
                              remote: { host: '192.168.80.133', port: 5060 },
                              expires_at: '2026-11-09T12:00:00.000Z',
                              sent: 2,
                              last_notify_at: '2026-11-09T10:00:30.000Z',
                              last_response: '200',
                          },
                      ]
                    : [],
            sent: 2,
            answered: { '200': 2 },
            log: this.mock_state === 'on' ? ['[..] SAS-режим включён'] : [],
        };
    }

    enable(): void
    {
        if (this.mock_state === 'on') throw new Error('SAS-режим уже включён');
        this.mock_state = 'on';
    }

    disable(): void
    {
        if (this.mock_state === 'off') throw new Error('SAS-режим уже выключен');
        this.mock_state = 'off';
    }
}

/** Мок стимула: только состояние для проверки взаимной блокировки. */
class IdleStimulus implements StationStimulusApi
{
    busy = false;

    cases(): StimulusCaseInfo[]
    {
        // id обязан быть в списке — иначе контроллер отсекает 400 раньше
        // проверки занятости/SAS.
        return [{ id: 't1', title: 'стимул t1' }];
    }

    status(): StimulusStatus
    {
        return {
            state: this.busy ? 'running' : 'idle',
            id: this.busy ? 't2' : '',
            started_at: '',
            uptime_s: 0,
            log: [],
            summary: '',
            error: '',
            csv: '',
        };
    }

    start(_id: string): void
    {
        this.busy = true;
    }

    async stop(): Promise<void>
    {
        this.busy = false;
    }
}

class MockStation implements Station
{
    mock_state: StationStatus['state'] = 'running';

    status(): StationStatus
    {
        return {
            state: this.mock_state,
            host: '192.168.80.159',
            port: 5060,
            proto: 'udp',
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

    sas_mode(): boolean
    {
        return false;
    }

    set_sas_mode(_on: boolean): void
    {
        /* мок: флаг станции здесь не ассертится (движок — свой мок) */
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

    events(limit?: number): StationEvent[]
    {
        return [].slice(0, limit ?? 200) as StationEvent[];
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
let app_no_sas: Express;
let station: MockStation;
let sas: MockSas;
let stimulus: IdleStimulus;
let cleanup: () => void;

beforeAll(() =>
{
    const t = temp_dir();
    cleanup = t.cleanup;
    station = new MockStation();
    sas = new MockSas();
    stimulus = new IdleStimulus();
    app = make_api_app({ root: t.dir, station, stimulus, sas }).app;
    app_no_sas = make_api_app({ root: t.dir, station }).app;
});

afterAll(() => cleanup());

describe('GET /api/station/sas', () =>
{
    it('200 — форма статуса выключенного режима', async () =>
    {
        const res = await request(app).get('/api/station/sas').expect(200);
        expect(res.body.state).toBe('off');
        expect(res.body.subs).toEqual([]);
        expect(res.body.sent).toBe(2);
        expect(res.body.answered).toEqual({ '200': 2 });
    });
});

describe('POST /api/station/sas/enable и /disable', () =>
{
    it('enable 200 → on со подписками, повторный enable — 409, disable — 200', async () =>
    {
        const on = await request(app).post('/api/station/sas/enable').expect(200);
        expect(on.body.state).toBe('on');
        expect(on.body.subs[0].event).toBe('ssw-srvm');
        expect(on.body.subs[0].remote).toEqual({ host: '192.168.80.133', port: 5060 });
        const again = await request(app).post('/api/station/sas/enable').expect(409);
        expect(again.body.error).toContain('уже включён');
        const off = await request(app).post('/api/station/sas/disable').expect(200);
        expect(off.body.state).toBe('off');
        await request(app).post('/api/station/sas/disable').expect(409);
    });

    it('enable на остановленной станции — 409 (сокет станции нужен)', async () =>
    {
        await request(app).post('/api/station/stop').expect(200);
        const res = await request(app).post('/api/station/sas/enable').expect(409);
        expect(res.body.error).toContain('Станция остановлена');
        await request(app).post('/api/station/start').expect(200);
    });

    it('SAS и стимул делят сокет — 409 в обе стороны', async () =>
    {
        stimulus.busy = true;
        const blocked = await request(app).post('/api/station/sas/enable').expect(409);
        expect(blocked.body.error).toContain('Стимул выполняется');
        stimulus.busy = false;
        await request(app).post('/api/station/sas/enable').expect(200);
        const stim = await request(app)
            .post('/api/station/stimulus')
            .send({ id: 't1' })
            .expect(409);
        expect(stim.body.error).toContain('SAS-режим включён');
        await request(app).post('/api/station/sas/disable').expect(200);
    });

    it('останов станции гасит SAS до снятия слушателя', async () =>
    {
        await request(app).post('/api/station/sas/enable').expect(200);
        await request(app).post('/api/station/stop').expect(200);
        expect(sas.mock_state).toBe('off');
        expect(station.mock_state).toBe('stopped');
        await request(app).post('/api/station/start').expect(200);
    });
});

describe('SAS в health и без DI', () =>
{
    it('/api/health — блок sas со состоянием', async () =>
    {
        const res = await request(app).get('/api/health').expect(200);
        expect(res.body.sas).toEqual({ state: 'off' });
    });

    it('приложение без SAS-движка — 404 на /api/station/sas*', async () =>
    {
        await request(app_no_sas).get('/api/station/sas').expect(404);
        await request(app_no_sas).post('/api/station/sas/enable').expect(404);
        const res = await request(app_no_sas).get('/api/health').expect(200);
        expect(res.body.sas).toBeUndefined();
    });
});
