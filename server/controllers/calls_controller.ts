// Контроллер вызовов (plan_2.md п.5.3): реестр вызовов пула + команды по
// записи реестра. Действия answer/reject/hangup в пуле адресуются номером
// нашего абонента, а REST работает с id вызова (Call-ID или tmp-id) —
// контроллер раскрывает id → запись → owner (серверная нога диалога).
// reject принимает необязательный {code} (SIP-код отклонения, по умолчанию
// 486; для кейсов п.8 — 603 и т.п.) — валидируется здесь, доставка — пулу.
// related: server/routes.ts, server/sip_pool.ts (CallRecord, ошибки 409/404).

import { Router, type RequestHandler } from 'express';
import type { CallRecord, SipPool } from '../sip_pool';

/** Валидный SIP-код отклонения (doc/sip_rfc.md §7): 4xx/5xx/6xx. */
function is_reject_code(code: unknown): code is number
{
    return (
        typeof code === 'number' && Number.isInteger(code) && code >= 400 && code <= 699
    );
}

/**
 * Router: GET /, POST / {from,to}, GET /:id,
 * POST /:id/answer|reject|hangup.
 */
export function calls_controller(pool: SipPool): Router
{
    const router = Router();

    router.get('/', (_req, res) =>
    {
        res.json({ calls: pool.list_calls() });
    });

    router.post('/', (req, res, next) =>
    {
        try
        {
            const { from, to } = (req.body ?? {}) as { from?: unknown; to?: unknown };
            if (typeof from !== 'string' || typeof to !== 'string' || !from || !to)
            {
                return res
                    .status(400)
                    .json({ error: 'Тело {from, to} обязательно (строки-номера)' });
            }
            return res.status(201).json({ call: pool.call(from, to) });
        }
        catch (e)
        {
            next(e);
        }
    });

    router.get('/:id', (req, res) =>
    {
        const rec = pool.get_call(req.params.id);
        if (!rec)
            return res.status(404).json({ error: `Вызов ${req.params.id} не найден` });
        return res.json({ call: rec });
    });

    /**
     * Обёртка действий по id: запись ищется здесь (404), действие идёт по
     * owner записи; состояния (нет входящего/активного) проверяет пул (409).
     * Ответ — перечитанная запись: стейт-машина обновляет её синхронно.
     */
    function act(fn: (rec: CallRecord) => void): RequestHandler
    {
        return (req, res, next) =>
        {
            try
            {
                const rec = pool.get_call(req.params.id);
                if (!rec)
                    return res
                        .status(404)
                        .json({ error: `Вызов ${req.params.id} не найден` });
                fn(rec);
                return res.json({ call: pool.get_call(rec.call_id) ?? rec });
            }
            catch (e)
            {
                next(e);
            }
        };
    }

    router.post(
        '/:id/answer',
        act((rec) => pool.answer(rec.owner)),
    );
    router.post(
        '/:id/hangup',
        act((rec) => pool.hangup(rec.owner)),
    );

    router.post('/:id/reject', (req, res, next) =>
    {
        try
        {
            const raw = (req.body ?? {}).code;
            if (raw !== undefined && !is_reject_code(raw))
            {
                return res
                    .status(400)
                    .json({ error: 'code — целое 400–699 (SIP-код отклонения)' });
            }
            const rec = pool.get_call(req.params.id);
            if (!rec)
                return res
                    .status(404)
                    .json({ error: `Вызов ${req.params.id} не найден` });
            pool.reject(rec.owner, raw as number | undefined);
            return res.json({ call: pool.get_call(rec.call_id) ?? rec });
        }
        catch (e)
        {
            next(e);
        }
    });

    return router;
}
