// Api-тесты ресурса исходящего вызова (doc/task_30_plan_2.md, origin —
// doc/task_31_plan_2.md): /api/station/call* через DI-мок StationOutboundApi
// (без сокетов и АТС) — коды 200/202/400/409, форма статуса, валидные формы
// номера/адреса/origin (400), состояния движка и пересечения со стимулом
// (409), совместимость с SAS-режимом в обе стороны (202/200), останов
// станции гасит вызов abort() раньше снятия слушателя; приложение со
// станцией, но без движка вызова — 404 на /call*. Сеть и порты не
// используются.
// related: server/controllers/station_controller.ts, server/station/outbound.ts
// (StationOutboundApi), tests/api/helpers.ts, tests/api/station_sas.test.ts
// (образец мока).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { make_api_app, temp_dir } from './helpers';
import type {
    OutboundState,
    OutboundStatus,
    StationOutboundApi,
} from '../../server/station/outbound';
import type { SasStatus, StationSasApi } from '../../server/station/sas';
import type {
    StationStimulusApi,
    StimulusCaseInfo,
    StimulusStatus,
} from '../../server/station/stimulus';
import type { Station, StationEvent, StationStatus } from '../../server/station/station';

/**
 * Мок движка вызова: состояние dial/cancel/hangup — public-поля теста;
 * непустые *_error бросают Error с ним (имитация состояний движка/гонки).
 */
class MockOutbound implements StationOutboundApi
{
    mock_state: OutboundState = 'idle';
    mock_callee = '';
    mock_caller = '';
    mock_target = '';
    mock_origin = '';
    dial_error = '';
    cancel_error = '';
    hangup_error = '';
    dial_calls: Array<{
        callee: string;
        caller?: string;
        target?: string;
        origin?: string;
    }> = [];
    abort_calls = 0;

    status(): OutboundStatus
    {
        const active = this.mock_state !== 'idle';
        return {
            state: this.mock_state,
            callee: this.mock_callee,
            caller: this.mock_caller,
            target: this.mock_target,
            origin: this.mock_origin,
            call_id: active ? 'ob-call-1' : '',
            last_code: active ? 180 : 0,
            last_reason: active ? 'Ringing' : '',
            error: '',
            sent: active ? 1 : 0,
            answered: active ? { '180': 1 } : {},
            log: active ? ['[..] INVITE → 192.168.80.133:5060'] : [],
            // Фан-аут ×10 мок не имитирует — только форма контракта.
            multiplied_active: 0,
        };
    }

    dial(init: {
        callee: string;
        caller?: string;
        target?: string;
        origin?: string;
    }): void
    {
        this.dial_calls.push(init);
        if (this.dial_error) throw new Error(this.dial_error);
        this.mock_state = 'calling';
        this.mock_callee = init.callee;
        this.mock_caller = init.caller ?? '9404';
        this.mock_target = init.target ?? '192.168.80.133:5060';
        this.mock_origin = init.origin ?? '';
    }

    cancel(): void
    {
        if (this.cancel_error) throw new Error(this.cancel_error);
        this.mock_state = 'cancelling';
    }

    hangup(): void
    {
        if (this.hangup_error) throw new Error(this.hangup_error);
        this.mock_state = 'terminating';
    }

    abort(): void
    {
        this.abort_calls += 1;
        this.mock_state = 'idle';
    }
}

/** Мок SAS: только состояние для взаимной блокировки с вызовом. */
class IdleSas implements StationSasApi
{
    on = false;

    status(): SasStatus
    {
        return {
            state: this.on ? 'on' : 'off',
            enabled_at: '',
            subs: [],
            sent: 0,
            answered: {},
            log: [],
        };
    }

    enable(): void
    {
        this.on = true;
    }

    disable(): void
    {
        this.on = false;
    }
}

/** Мок стимула: только состояние для взаимной блокировки с вызовом. */
class IdleStimulus implements StationStimulusApi
{
    busy = false;

    cases(): StimulusCaseInfo[]
    {
        return [{ id: 't1', title: 'стимул t1' }];
    }

    status(): StimulusStatus
    {
        return {
            state: this.busy ? 'running' : 'idle',
            id: '',
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
            last_downstream: '192.168.80.133:5060',
        };
    }

    sas_mode(): boolean
    {
        return false;
    }

    set_sas_mode(_on: boolean): void
    {
        /* мок: флаг станции здесь не ассертится */
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
let app_no_outbound: Express;
let station: MockStation;
let outbound: MockOutbound;
let sas: IdleSas;
let stimulus: IdleStimulus;
let cleanup: () => void;

beforeAll(() =>
{
    const t = temp_dir();
    cleanup = t.cleanup;
    station = new MockStation();
    outbound = new MockOutbound();
    sas = new IdleSas();
    stimulus = new IdleStimulus();
    app = make_api_app({ root: t.dir, station, stimulus, sas, outbound }).app;
    app_no_outbound = make_api_app({ root: t.dir, station }).app;
});

afterAll(() => cleanup());

describe('GET /api/station/call', () =>
{
    it('200 — форма статуса idle', async () =>
    {
        const res = await request(app).get('/api/station/call').expect(200);
        expect(res.body.state).toBe('idle');
        expect(res.body.callee).toBe('');
        expect(res.body.target).toBe('');
        expect(res.body.answered).toEqual({});
    });
});

describe('POST /api/station/call {callee,caller?,target?}', () =>
{
    it('успех — 202 и статус calling (caller/target по умолчанию движка)', async () =>
    {
        const res = await request(app).post('/api/station/call').send({ callee: '52' });
        expect(res.status).toBe(202);
        expect(res.body.state).toBe('calling');
        expect(res.body.callee).toBe('52');
        expect(outbound.dial_calls).toEqual([{ callee: '52' }]);
        outbound.mock_state = 'idle';
        outbound.dial_calls = [];
    });

    it('с caller/target — уходят движку как есть', async () =>
    {
        const res = await request(app)
            .post('/api/station/call')
            .send({ callee: '+7123', caller: ' 52 ', target: '10.0.0.1:5061' });
        expect(res.status).toBe(202);
        expect(outbound.dial_calls).toEqual([
            { callee: '+7123', caller: '52', target: '10.0.0.1:5061' },
        ]);
        outbound.mock_state = 'idle';
        outbound.dial_calls = [];
    });

    it('битые callee/caller/target/origin и пустое тело — 400 без dial', async () =>
    {
        await request(app).post('/api/station/call').send({}).expect(400);
        await request(app).post('/api/station/call').send({ callee: 'abc' }).expect(400);
        await request(app).post('/api/station/call').send({ callee: '' }).expect(400);
        await request(app)
            .post('/api/station/call')
            .send({ callee: '52', caller: 'а-я' })
            .expect(400);
        await request(app)
            .post('/api/station/call')
            .send({ callee: '52', target: 'http://x' })
            .expect(400);
        await request(app)
            .post('/api/station/call')
            .send({ callee: '52', origin: 'http://x' })
            .expect(400);
        expect(outbound.dial_calls).toEqual([]);
    });

    it('с origin (host:порт) — 202, origin уходит движку', async () =>
    {
        const res = await request(app)
            .post('/api/station/call')
            .send({ callee: '52', origin: '192.168.80.200:5070' });
        expect(res.status).toBe(202);
        expect(res.body.origin).toBe('192.168.80.200:5070');
        expect(outbound.dial_calls).toEqual([
            { callee: '52', origin: '192.168.80.200:5070' },
        ]);
        outbound.mock_state = 'idle';
        outbound.mock_origin = '';
        outbound.dial_calls = [];
    });

    it('станция остановлена / стимул идёт — 409 без dial', async () =>
    {
        station.mock_state = 'stopped';
        const r1 = await request(app)
            .post('/api/station/call')
            .send({ callee: '52' })
            .expect(409);
        expect(r1.body.error).toContain('Станция остановлена');
        station.mock_state = 'running';

        stimulus.busy = true;
        const r2 = await request(app)
            .post('/api/station/call')
            .send({ callee: '52' })
            .expect(409);
        expect(r2.body.error).toContain('Стимул выполняется');
        stimulus.busy = false;
        expect(outbound.dial_calls).toEqual([]);
    });

    // doc/task_31_plan_2.md: SAS-режим и вызов совместимы (хуки станции
    // мультикастятся) — SAS больше не 409 на POST /call.
    it('SAS включён — вызов проходит (202), режимы совместимы', async () =>
    {
        sas.on = true;
        const res = await request(app).post('/api/station/call').send({ callee: '52' });
        expect(res.status).toBe(202);
        expect(outbound.dial_calls).toEqual([{ callee: '52' }]);
        sas.on = false;
        outbound.mock_state = 'idle';
        outbound.dial_calls = [];
    });

    it('движок бросил (занято/нет адресата) — 409 с его текстом', async () =>
    {
        outbound.dial_error =
            'адрес нижестоящей станции неизвестен (пир ещё не обращался)';
        const res = await request(app)
            .post('/api/station/call')
            .send({ callee: '52' })
            .expect(409);
        expect(res.body.error).toContain('неизвестен');
        outbound.dial_error = '';
        outbound.dial_calls = [];
    });
});

describe('POST /api/station/call/cancel и /call/hangup', () =>
{
    it('cancel из calling — 200+статус; ошибка движка — 409 с текстом', async () =>
    {
        outbound.mock_state = 'calling';
        const ok = await request(app).post('/api/station/call/cancel').expect(200);
        expect(ok.body.state).toBe('cancelling');
        outbound.cancel_error = 'CANCEL уже отправлен';
        const bad = await request(app).post('/api/station/call/cancel').expect(409);
        expect(bad.body.error).toContain('уже отправлен');
        outbound.cancel_error = '';
        outbound.mock_state = 'idle';
    });

    it('hangup из answered — 200+статус; не из answered — 409', async () =>
    {
        outbound.mock_state = 'answered';
        const ok = await request(app).post('/api/station/call/hangup').expect(200);
        expect(ok.body.state).toBe('terminating');
        outbound.hangup_error = 'Вызов ещё не соединён — отмена CANCEL (cancel)';
        const bad = await request(app).post('/api/station/call/hangup').expect(409);
        expect(bad.body.error).toContain('не соединён');
        outbound.hangup_error = '';
        outbound.mock_state = 'idle';
    });
});

describe('Встречные блокировки и останов станции', () =>
{
    it('вызов активен — стимул 409, SAS-режим проходит (task_31)', async () =>
    {
        outbound.mock_state = 'ringing';
        const stim = await request(app)
            .post('/api/station/stimulus')
            .send({ id: 't1' })
            .expect(409);
        expect(stim.body.error).toContain('Исходящий вызов активен');
        const sas_res = await request(app).post('/api/station/sas/enable').expect(200);
        expect(sas_res.body.state).toBe('on');
        await request(app).post('/api/station/sas/disable').expect(200);
        outbound.mock_state = 'idle';
    });

    it('POST /stop гасит вызов abort() раньше станции', async () =>
    {
        outbound.mock_state = 'answered';
        outbound.abort_calls = 0;
        const res = await request(app).post('/api/station/stop').expect(200);
        expect(res.body.state).toBe('stopped');
        expect(outbound.abort_calls).toBe(1);
        expect(outbound.mock_state).toBe('idle');
        station.mock_state = 'running';
    });
});

describe('Вызов без DI', () =>
{
    it('станция есть, движка нет — 404 на /call*', async () =>
    {
        await request(app_no_outbound).get('/api/station/call').expect(404);
        await request(app_no_outbound)
            .post('/api/station/call')
            .send({ callee: '52' })
            .expect(404);
        await request(app_no_outbound).post('/api/station/call/cancel').expect(404);
        await request(app_no_outbound).post('/api/station/call/hangup').expect(404);
    });
});
