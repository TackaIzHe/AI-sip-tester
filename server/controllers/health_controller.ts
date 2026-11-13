// Контроллер здоровья (plan_2.md п.5.4, GET /api/health): статус-строка
// страницы (п.6.2) — адрес/протокол АТС и параметры сервера. Только чтение
// конфига: пула не трогаем, чтобы health не зависал на SIP-операциях.
// related: server/config.ts (AppConfig), public/index.html (потребитель, п.6).

import { Router } from 'express';
import type { AppConfig } from '../config';
import type { StationSasApi } from '../station/sas';
import type { Station } from '../station/station';

/** Router: GET / — JSON статуса стенда. */
export function health_controller(
    config: AppConfig,
    started_at?: number,
    station?: Station,
    sas?: StationSasApi,
): Router
{
    const router = Router();
    // Значение по умолчанию без побочного эффекта в сигнатуре: мёртвое время
    // фиксируется один раз при сборке контроллера.
    const started = started_at ?? Date.now();

    router.get('/', (_req, res) =>
    {
        // status().state — только чтение памяти сервиса, health по-прежнему
        // не зависит от SIP-операций (plan_4.md п.3).
        const st = station?.status();
        res.json({
            status: 'ok',
            uptime_s: Math.round((Date.now() - started) / 1000),
            pbx_host: config.pbx_host,
            pbx_port: config.pbx_port,
            sip_protocol: config.sip_protocol,
            bridge: `${config.bridge_host}:${config.bridge_port}`,
            station: st ? { state: st.state, host: st.host, port: st.port } : undefined,
            // SAS-режим (план 6 п.3): только флаг — счётчики в GET /api/station/sas.
            sas: sas ? { state: sas.status().state } : undefined,
            subscribers: config.subscribers.map((s) => ({
                number: s.number,
                can_register: s.can_register,
            })),
        });
    });

    return router;
}
