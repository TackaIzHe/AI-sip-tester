// Обработка ошибок REST API (plan_2.md п.5.1): любой необработанный throw
// превращается в JSON {error} с осмысленным HTTP-кодом — тело в стиле rails,
// чтобы страница (п.6) единообразно показывала отказы.
//
// Источники кода:
//  - PoolError — поле `status` проставлено в месте броска (server/sip_pool.ts):
//    неизвестный абонент 404, запрет 3203 / без регистрации / нет вызова 403/409,
//    отказ станции 502 (SIP-код — в теле как sip_code);
//  - SyntaxError от express.json() (битый JSON в теле) — 400;
//  - прочее — 500: инструмент внутренний, отдаём err.message без стек-трейса.
// related: server/sip_pool.ts (PoolError), server/app.ts (подключение последним).

import type { ErrorRequestHandler, RequestHandler } from 'express';
import { PoolError } from '../sip_pool';

/** 404 для неизвестных маршрутов: тоже JSON {error} (curl/страница ждут JSON). */
export const not_found_handler: RequestHandler = (req, res) =>
{
    res.status(404).json({
        error: `Маршрут не найден: ${req.method} ${req.originalUrl}`,
    });
};

/** Express 4 не ловит reject async-хендлера — обёртка передаёт его в next. */
export function async_handler(
    fn: (
        req: Parameters<RequestHandler>[0],
        res: Parameters<RequestHandler>[1],
        next: Parameters<RequestHandler>[2],
    ) => Promise<unknown>,
): RequestHandler
{
    return (req, res, next) =>
    {
        fn(req, res, next).catch(next);
    };
}

/** Финальный error-handler: JSON {error} (+ sip_code для ошибок станции). */
export const error_handler: ErrorRequestHandler = (err, req, res, next) =>
{
    if (res.headersSent) return next(err);
    if (err instanceof PoolError)
    {
        const body: Record<string, unknown> = { error: err.message };
        if (err.code) body.sip_code = err.code;
        if (!err.status) return res.status(500).json(body);
        return res.status(err.status).json(body);
    }
    // express.json() бросает SyntaxError с свойством body при битом JSON.
    if (err instanceof SyntaxError && 'body' in err)
    {
        return res.status(400).json({ error: 'Некорректный JSON в теле запроса' });
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[http] необработанная ошибка ${req.method} ${req.originalUrl}:`, err);
    return res.status(500).json({ error: message });
};
