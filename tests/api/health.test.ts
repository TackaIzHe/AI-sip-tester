// Api-тест GET /api/health (plan_2.md п.9.2): статус-строка страницы (п.6.2)
// — адрес/протокол АТС, bridge и абоненты конфига; только чтение AppConfig,
// пул и сеть не затрагиваются.
// related: server/controllers/health_controller.ts, server/config.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { make_api_app, temp_dir } from './helpers';

let app: Express;
let cleanup: () => void;

beforeAll(() =>
{
    const t = temp_dir();
    app = make_api_app({ root: t.dir }).app;
    cleanup = t.cleanup;
});

afterAll(() => cleanup());

describe('GET /api/health', () =>
{
    it('200 — статус, АТС и bridge из конфига', async () =>
    {
        const res = await request(app).get('/api/health').expect(200);
        expect(res.body.status).toBe('ok');
        expect(res.body.uptime_s).toBeGreaterThanOrEqual(0);
        expect(res.body.pbx_host).toBe('192.168.80.157');
        expect(res.body.pbx_port).toBe(5060);
        expect(res.body.sip_protocol).toBe('udp');
        expect(res.body.bridge).toBe('192.168.80.159:8090');
    });

    it('200 — абоненты конфига с флагом can_register (3203 — false)', async () =>
    {
        const res = await request(app).get('/api/health').expect(200);
        expect(res.body.subscribers).toEqual([
            { number: '9404', can_register: true },
            { number: '52', can_register: true },
            { number: '3203', can_register: false },
        ]);
    });
});
