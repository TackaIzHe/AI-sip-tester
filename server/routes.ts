// Карта маршрутов REST API (plan_2.md п.5.4, rails-style): все маршруты
// проекта — в одном месте, контроллеры — по категориям (server/controllers/).
// Только чтение карты: зависимости (конфиг, пул, каталоги) приходят из
// create_app (server/app.ts) — в api-тестах (п.9) подставляется мок пула.
//
//   GET    /api/files/tree                 GET    /api/files/content?path=
//   GET    /api/reports                    GET    /api/reports/:id
//   DELETE /api/reports                    DELETE /api/reports/:id
//   GET    /api/subscribers                POST   /api/subscribers/:number/register
//                                           DELETE /api/subscribers/:number/register
//   GET    /api/calls                      POST   /api/calls {from,to}
//   GET    /api/calls/:id                  POST   /api/calls/:id/answer|reject|hangup
//   GET    /api/test_runs (список кейсов)
//   POST   /api/test_runs {case:1..5|noanswer|all}  GET /api/test_runs/:id
//   (исполнение — п.8)
//   GET    /api/health
//   GET    /api/station (монтируется только при deps.station, plan_4.md п.3)
//   POST   /api/station/start|stop  GET /api/station/events
//   GET    /api/station/stimulus        POST /api/station/stimulus {id}
//   POST   /api/station/stimulus/stop   (stimulus DI, doc/task_26)
//   GET    /api/station/sas             POST /api/station/sas/enable|disable
//                                        (sas DI, doc/plan_6.md)
//   POST   /api/station/silent_invite {on}  режим «не отвечать на INVITE»
//                                        (галочка вкладки, doc/task_29)
//   POST   /api/station/forward_invite {on} перенаправление INVITE на
//                                        адрес из R-URI (doc/task_32_plan_2.md)
//   POST   /api/station/ignore_provisional {on} игнор 100/180 после
//                                        перенаправленного INVITE
//                                        (doc/task_36_plan_2.md)
//   POST   /api/station/multiply_invite {on} умножение перенаправляемого
//                                        INVITE ×10 (doc/task_37_plan_2.md)
//   GET    /api/station/call              POST /api/station/call {callee,...}
//   POST   /api/station/call/cancel       POST /api/station/call/hangup
//                                        (outbound DI, doc/task_30_plan_2.md)
//   GET    /api/station/registrations     POST /api/station/registrations
//   POST   /api/station/registrations/:id/update
//   DELETE /api/station/registrations/:id (registrations DI,
//                                        doc/task_33_plan_2.md)
//
// related: server/app.ts, doc/api.md (п.10 — документация по endpoint-ам).

import { Router } from 'express';
import type { AppConfig } from './config';
import type { Journal } from './journal';
import type { SipPool } from './sip_pool';
import type { StationOutboundApi } from './station/outbound';
import type { RegistrationsApi } from './station/registrations';
import type { StationSasApi } from './station/sas';
import type { StationStimulusApi } from './station/stimulus';
import type { Station } from './station/station';
import { files_controller } from './controllers/files_controller';
import { reports_controller } from './controllers/reports_controller';
import { subscribers_controller } from './controllers/subscribers_controller';
import { calls_controller } from './controllers/calls_controller';
import { health_controller } from './controllers/health_controller';
import { station_controller } from './controllers/station_controller';
import { test_runs_controller } from './controllers/test_runs_controller';

/** Зависимости маршрутов (DI — те же, что у create_app). */
export interface RouteDeps
{
    config: AppConfig;
    pool: SipPool;
    /** Журнал для исполнения прогонов POST /api/test_runs (п.8). */
    journal: Journal;
    /** Корень дерева файлов (в бою process.cwd()). */
    files_root: string;
    /** Каталог отчётов (Journal.render_report пишет сюда же). */
    reports_dir: string;
    /** Станция-эмулятор (plan_4.md); нет — /api/station не монтируется (404). */
    station?: Station;
    /**
     * Движок стимулов утечки при станции (doc/task_26); нет — /stimulus* не
     * монтируются (404), станции-режимы кнопок не мешают.
     */
    stimulus?: StationStimulusApi;
    /**
     * Движок SAS-режима (план 6); нет — /api/station/sas* не монтируются (404).
     */
    sas?: StationSasApi;
    /**
     * Движок исходящего вызова (doc/task_30_plan_2.md); нет — /api/station/call*
     * не монтируются (404).
     */
    outbound?: StationOutboundApi;
    /**
     * Таблица регистраций нижестоящей станции (doc/task_33_plan_2.md); нет —
     * /api/station/registrations* не монтируются (404).
     */
    registrations?: RegistrationsApi;
}

/** Собрать router со всеми /api-маршрутами (монтируется на '/' целиком). */
export function build_api_router(deps: RouteDeps): Router
{
    const router = Router();

    router.use('/files', files_controller(deps.files_root));
    router.use('/reports', reports_controller(deps.reports_dir));
    router.use('/subscribers', subscribers_controller(deps.pool));
    router.use('/calls', calls_controller(deps.pool));
    router.use(
        '/test_runs',
        test_runs_controller({
            config: deps.config,
            pool: deps.pool,
            journal: deps.journal,
        }),
    );
    router.use(
        '/health',
        health_controller(deps.config, undefined, deps.station, deps.sas),
    );
    // Станция монтируется только при наличии DI (паттерн plan_4.md п.3):
    // приложение без станции отвечает на /api/station честное 404; /stimulus*,
    // /sas* и /call* внутри контроллера — только при своих deps (doc/task_26,
    // план 6, doc/task_30_plan_2.md).
    if (deps.station)
    {
        router.use(
            '/station',
            station_controller(
                deps.station,
                deps.stimulus,
                deps.sas,
                deps.outbound,
                deps.registrations,
            ),
        );
    }

    return router;
}
