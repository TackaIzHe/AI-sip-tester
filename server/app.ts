// Сборка express-приложения (plan_2.md п.5.1): json-парсер, request_logger,
// /api-маршруты (routes.ts), статика `/` → public/ (страница, п.6) и
// `/reports` → reports/ (HTML/MD-отчёты п.3), 404 и error_handler — последними.
//
// Приложение создаётся ФАБРИКОЙ с DI (config, pool, каталоги), а не синглтоном
// модуля: api-тесты (п.9, supertest) поднимают его с моком SipPool без listen
// и без сети; main.ts поднимает его же с боевым пулом. Порядок middleware
// значим: статика до 404-хендлера, error_handler — самый последний.
// related: server/main.ts (bootstrap), server/routes.ts (карта маршрутов).

import fs from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';
import type { AppConfig } from './config';
import type { Journal } from './journal';
import type { SipPool } from './sip_pool';
import type { StationOutboundApi } from './station/outbound';
import type { RegistrationsApi } from './station/registrations';
import type { StationSasApi } from './station/sas';
import type { StationStimulusApi } from './station/stimulus';
import type { Station } from './station/station';
import { build_api_router } from './routes';
import { request_logger } from './middleware/request_logger';
import { error_handler, not_found_handler } from './middleware/error_handler';

/** Зависимости приложения (в бою — из main.ts; в тестах — мок pool + temp-каталоги). */
export interface AppDeps
{
    config: AppConfig;
    /** Боевой SipSubscriberPool или мок (DI-контракт, п.4.2). */
    pool: SipPool;
    /**
     * Журнал событий (нужен исполнению POST /api/test_runs, п.8); в тестах —
     * реальный, он без сети.
     */
    journal: Journal;
    /** Корень дерева файлов для /api/files/* (по умолчанию cwd процесса). */
    files_root?: string;
    /** Каталог отчётов (по умолчанию ./reports — как у Journal по умолчанию). */
    reports_dir?: string;
    /** Каталог статики страницы (по умолчанию ./public, появится в п.6). */
    public_dir?: string;
    /**
     * Станция-эмулятор (plan_4.md п.3); нет — /api/station не смонтирован,
     * вкладки страницы молчат (404 на endpoints).
     */
    station?: Station;
    /**
     * Движок стимулов утечки памяти при станции (doc/task_26); нет —
     * /api/station/stimulus* не смонтированы (404).
     */
    stimulus?: StationStimulusApi;
    /**
     * Движок SAS-режима при станции (план 6); нет — /api/station/sas* не
     * смонтированы (404).
     */
    sas?: StationSasApi;
    /**
     * Движок исходящего вызова на нижестоящую станцию
     * (doc/task_30_plan_2.md); нет — /api/station/call* не смонтированы (404).
     */
    outbound?: StationOutboundApi;
    /**
     * Таблица регистраций нижестоящей станции (doc/task_33_plan_2.md); нет —
     * /api/station/registrations* не смонтированы (404).
     */
    registrations?: RegistrationsApi;
}

/** Собрать готовое express-приложение (без listen — портом ведает main.ts). */
export function create_app(deps: AppDeps): Express
{
    const app = express();
    app.disable('x-powered-by');

    const files_root = path.resolve(deps.files_root ?? process.cwd());
    const reports_dir = path.resolve(deps.reports_dir ?? 'reports');
    const public_dir = path.resolve(deps.public_dir ?? 'public');

    app.use(express.json());
    app.use(request_logger);

    app.use(
        '/api',
        build_api_router({
            config: deps.config,
            pool: deps.pool,
            journal: deps.journal,
            files_root,
            reports_dir,
            station: deps.station,
            stimulus: deps.stimulus,
            sas: deps.sas,
            outbound: deps.outbound,
            registrations: deps.registrations,
        }),
    );

    // Статика отчётов: отчёт открывается в браузере как /reports/<id>.html.
    // Каталог мог ещё не существовать (первый запуск) — создаём, иначе
    // express.static на каждый запрос ловит ENOENT.
    fs.mkdirSync(reports_dir, { recursive: true });
    app.use('/reports', express.static(reports_dir));
    app.use('/', express.static(public_dir));

    app.use(not_found_handler);
    app.use(error_handler);
    return app;
}
