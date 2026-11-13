// Контроллер абонентов (plan_2.md п.5.3): статусы, регистрация и снятие
// виртуальных абонентов поверх DI-интерфейса SipPool (server/sip_pool.ts).
// Контроллер — тонкая обёртка: никаких состояний сам, все ошибки — PoolError
// c HTTP-status (error_handler конвертирует в {error}); «неизвестный абонент»
// и «нет вызова» в валидацию здесь не превращаем — источник истины пул.
// related: server/routes.ts, doc/task_4_plan_2.md (справка по пулу).

import { Router } from 'express';
import type { SipPool } from '../sip_pool';
import { async_handler } from '../middleware/error_handler';

/** Router: GET /, POST /:number/register, DELETE /:number/register. */
export function subscribers_controller(pool: SipPool): Router
{
    const router = Router();

    router.get('/', (_req, res) =>
    {
        res.json({ subscribers: pool.list_subscribers() });
    });

    // Идемпотентность повторной регистрации — внутри пула (критерий п.4).
    router.post(
        '/:number/register',
        async_handler(async (req, res) =>
        {
            const outcome = await pool.register_subscriber(req.params.number);
            res.json(outcome);
        }),
    );

    router.delete(
        '/:number/register',
        async_handler(async (req, res) =>
        {
            await pool.unregister(req.params.number);
            res.json({ number: req.params.number, ok: true });
        }),
    );

    return router;
}
