// Логирование HTTP-запросов (plan_2.md п.5.1): одна строка на запрос —
// метод, путь, код ответа, длительность. Работает по событию 'finish',
// чтобы видеть итоговый код и после контроллеров, и после error_handler.
// related: server/app.ts (подключение), middleware/error_handler.ts.

import type { RequestHandler } from 'express';

/** Middleware: писать «METHOD path → код (мс)» по завершении каждого запроса. */
export const request_logger: RequestHandler = (req, res, next) =>
{
    const started = Date.now();
    res.on('finish', () =>
    {
        console.log(
            `[http] ${req.method} ${req.originalUrl} → ${res.statusCode} ` +
                `(${Date.now() - started} мс)`,
        );
    });
    next();
};
