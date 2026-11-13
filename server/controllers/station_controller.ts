// Контроллер собственной станции-эмулятора (plan_4.md п.3): GET /api/station —
// статус/счётчики, POST /start|/stop — запуск/останов слушателя (кнопки
// вкладки «Станция»), GET /api/station/events — журнал обращений (newest
// first) и стимулы утечки памяти (doc/task_26): GET /api/station/stimulus —
// статус+список T1–T8, POST /api/station/stimulus {id} — старт короткого
// прогона (202, движок в фоне), POST /stimulus/stop — досрочная остановка.
// SAS-режим (план 6 п.3): GET /api/station/sas — статус/подписки, POST
// /sas/enable|/disable — роль SAS/SSW-сервера; SAS и стимул делят сокет и
// хук входящих — контроллер разводит их 409 в обе стороны, останов станции
// гасит SAS до снятия слушателя (как прогон). Режим «не отвечать на вызовы»
// (doc/task_29): POST /api/station/silent_invite {on} — галочка страницы,
// флаг станции (не слушателя) — 200 со статусом, без 409-состояний.
// Исходящий вызов на нижестоящую станцию (doc/task_30_plan_2.md): GET/POST
// /api/station/call (статус / INVITE по номеру из формы, необязательный
// origin «откуда пришёл вызов» — ретрансляция, doc/task_31_plan_2.md),
// POST /call/cancel (CANCEL) и POST /call/hangup (BYE); со стимулом — 409 в
// обе стороны, с SAS-режимом совместим (мультикаст-хук), останов станции
// гасит вызов abort() первым.
// Перенаправление входящих INVITE по таблице регистраций
// (doc/task_34_plan_2.md): POST /api/station/forward_invite {on} — галочка
// вкладки «Станция», флаг станции (как silent_invite, 409 нет); INVITE
// забирает постоянный хук движка вызова — флаг действует при outbound и
// registrations в DI (в бою есть всегда).
// Игнорирование Trying/Ringing после перенаправленного INVITE
// (doc/task_36_plan_2.md): POST /api/station/ignore_provisional {on} — та же
// галочка-флаг вкладки «Станция» (контракт silent_invite); фильтрует 100/180
// движок вызова, здесь только переключение флага станции.
// Умножение перенаправляемого INVITE ×10 (doc/task_37_plan_2.md): POST
// /api/station/multiply_invite {on} — галочка-флаг той же вкладки (контракт
// silent_invite); фан-аут делает хук перенаправления StationOutbound
// (копии — теневые диалоги), здесь только переключение флага станции.
// Таблица регистраций нижестоящей станции (doc/task_33_plan_2.md): GET/POST
// /api/station/registrations, POST /registrations/:id/update, DELETE
// /registrations/:id (registrations DI) — вкладка «Регистрации»: номер вводит
// оператор, identifier (u00s00p00) и адрес — из приходящих REGISTER в
// SAS-режиме; формы номера/идентификатора проверяются здесь (400), уникальность
// identifier — Error из хранилища (409, как dial у вызова).
// Кодирование 200/202/400/409/502 — здесь (по образцу test_runs_controller,
// error_handler не расширяем): 409 — неправильное состояние (старт на
// работающей, стимул на занятом движке/остановленной станции), 502 — bind не
// удался (текст ошибки сервиса + подсказка про привилегии порта 5060 уже в
// сообщении SipStation).
// related: server/station/station.ts (Station/SipStation), server/station/
// stimulus.ts (StationStimulusApi), server/station/sas.ts (StationSasApi),
// server/station/outbound.ts (StationOutboundApi), server/station/
// registrations.ts (RegistrationsApi), server/routes.ts,
// doc/api.md (раздел «Станция»), doc/task_26_plan_2.md, doc/plan_6.md,
// doc/task_29_plan_2.md, doc/task_30_plan_2.md, doc/task_32_plan_2.md,
// doc/task_33_plan_2.md, doc/task_36_plan_2.md, doc/task_37_plan_2.md.

import { Router } from 'express';
import type { StationOutboundApi } from '../station/outbound';
import type { RegistrationEntry, RegistrationsApi } from '../station/registrations';
import type { StationSasApi } from '../station/sas';
import type { StationStimulusApi } from '../station/stimulus';
import type { Station } from '../station/station';

/** Номер для формы INVITE и таблицы регистраций: цифры, опц. «+», до 24. */
const NUMBER_RE = /^\+?\d{1,24}$/;

/** target в форме: «host» или «host:порт» (разбор/порт — за движком). */
const TARGET_RE = /^[a-zA-Z0-9._-]+(?::\d{1,5})?$/;

/** identifier линии в таблице регистраций (u00s00p00 и ручные правки). */
const IDENTIFIER_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Router: GET /, POST /start, POST /stop, GET /events?limit=; при stimulus —
 * GET /stimulus, POST /stimulus {id}, POST /stimulus/stop (doc/task_26);
 * при sas — GET /sas, POST /sas/enable, POST /sas/disable (план 6 п.3);
 * при outbound — GET /call, POST /call {callee,caller?,target?},
 * POST /call/cancel, POST /call/hangup (doc/task_30_plan_2.md);
 * при registrations — GET/POST /registrations,
 * POST /registrations/:id/update, DELETE /registrations/:id
 * (doc/task_33_plan_2.md).
 */
export function station_controller(
    station: Station,
    stimulus?: StationStimulusApi,
    sas?: StationSasApi,
    outbound?: StationOutboundApi,
    registrations?: RegistrationsApi,
): Router
{
    const router = Router();

    router.get('/', (_req, res) =>
    {
        res.json(station.status());
    });

    router.post('/start', async (_req, res) =>
    {
        if (station.status().state === 'running')
        {
            return res.status(409).json({ error: 'Станция уже запущена' });
        }
        try
        {
            await station.start();
        }
        catch (e: unknown)
        {
            // bind-ошибки (EACCES/EADDRINUSE) — штатный исход для
            // привилегированного порта.
            const msg = e instanceof Error ? e.message : String(e);
            return res.status(502).json({ error: msg });
        }
        return res.json(station.status());
    });

    router.post('/stop', async (_req, res) =>
    {
        if (station.status().state === 'stopped')
        {
            return res.status(409).json({ error: 'Станция уже остановлена' });
        }
        // Исходящий вызов гасится ПЕРВЫМ: его CANCEL/BYE идут через сокет
        // станции, а abort() синхронен и обязан снять хук до остановки
        // слушателя (doc/task_30_plan_2.md).
        if (outbound) outbound.abort();
        // Стимул идёт через сокет станции: сначала дождаться его зачистки
        // (graceful unsubscribe/unreg), иначе stop() снимет слушатель посреди
        // прогона и отправка упадёт с ошибкой сокета (doc/task_26).
        if (stimulus && stimulus.status().state !== 'idle') await stimulus.stop();
        // SAS-движок тоже шлёт через сокет станции — гасим до stop(), иначе
        // хук ответов и SAS-флаг пережили бы останов и пережили restart.
        if (sas && sas.status().state === 'on') sas.disable();
        await station.stop();
        return res.json(station.status());
    });

    router.get('/events', (req, res) =>
    {
        const raw = req.query.limit;
        if (raw === undefined) return res.json({ events: station.events() });
        const limit = Number(raw);
        if (!Number.isInteger(limit) || limit < 1)
        {
            return res.status(400).json({ error: 'limit — целое число >= 1' });
        }
        return res.json({ events: station.events(limit) });
    });

    // Режим «не отвечать на вызовы (INVITE)» — галочка вкладки «Станция»
    // (doc/task_29). Флаг — настройка станции, а не слушателя: переключается
    // в любом состоянии (409 тут нет), ответ — полный статус, чтобы странице
    // не перечитывать GET.
    router.post('/silent_invite', (req, res) =>
    {
        const on = (req.body as { on?: unknown })?.on;
        if (typeof on !== 'boolean')
        {
            return res.status(400).json({ error: 'Ожидается {"on":true|false}' });
        }
        station.set_silent_invite(on);
        return res.json(station.status());
    });

    // Перенаправление INVITE по таблице регистраций — галочка вкладки
    // «Станция» (doc/task_34_plan_2.md). Тот же контракт, что у
    // silent_invite: флаг станции, 200 со статусом, 400 на неboolean;
    // разбор INVITE и набор делает хук движка вызова (StationOutbound).
    router.post('/forward_invite', (req, res) =>
    {
        const on = (req.body as { on?: unknown })?.on;
        if (typeof on !== 'boolean')
        {
            return res.status(400).json({ error: 'Ожидается {"on":true|false}' });
        }
        station.set_forward_invite(on);
        return res.json(station.status());
    });

    // Игнорирование Trying/Ringing после перенаправленного INVITE — галочка
    // вкладки «Станция» (doc/task_36_plan_2.md). Контракт тот же, что у
    // silent_invite; 100/180 фильтрует StationOutbound по флагу станции.
    router.post('/ignore_provisional', (req, res) =>
    {
        const on = (req.body as { on?: unknown })?.on;
        if (typeof on !== 'boolean')
        {
            return res.status(400).json({ error: 'Ожидается {"on":true|false}' });
        }
        station.set_ignore_provisional(on);
        return res.json(station.status());
    });

    // Умножение перенаправляемого INVITE ×10 — галочка вкладки «Станция»
    // (doc/task_37_plan_2.md). Контракт тот же, что у silent_invite; фан-аут
    // делает StationOutbound в хуке перенаправления (без forward_invite
    // флаг ни на что не влияет).
    router.post('/multiply_invite', (req, res) =>
    {
        const on = (req.body as { on?: unknown })?.on;
        if (typeof on !== 'boolean')
        {
            return res.status(400).json({ error: 'Ожидается {"on":true|false}' });
        }
        station.set_multiply_invite(on);
        return res.json(station.status());
    });

    // Стимулы утечки памяти T1–T8 (doc/task_26): монтируются только при DI
    // движка — приложение без стимульного движка отдаёт на них 404.
    if (stimulus)
    {
        router.get('/stimulus', (_req, res) =>
        {
            res.json({ status: stimulus.status(), cases: stimulus.cases() });
        });

        router.post('/stimulus', (req, res) =>
        {
            const id = (req.body as { id?: unknown })?.id;
            if (typeof id !== 'string' || id === '')
            {
                return res.status(400).json({ error: 'Ожидается {"id":"t1".."t8"}' });
            }
            if (!stimulus.cases().some((c) => c.id === id))
            {
                return res
                    .status(400)
                    .json({ error: `Неизвестный стимул «${id}» (ждутся t1..t8)` });
            }
            if (stimulus.status().state !== 'idle')
            {
                return res
                    .status(409)
                    .json({ error: `Стимул «${stimulus.status().id}» уже выполняется` });
            }
            if (station.status().state !== 'running')
            {
                return res
                    .status(409)
                    .json({ error: 'Станция остановлена — стимул идёт через её сокет' });
            }
            // SAS и прогон делят UDP-сокет и хук входящих (SAS забирает
            // ответы на свои NOTIFY) — одновременно их быть не может.
            if (sas && sas.status().state === 'on')
            {
                return res
                    .status(409)
                    .json({ error: 'SAS-режим включён — сначала выключите его' });
            }
            // Исходящий вызов — третий претендент на сокет/хук (task_30).
            if (outbound && outbound.status().state !== 'idle')
            {
                return res
                    .status(409)
                    .json({ error: 'Исходящий вызов активен — сначала отбой' });
            }
            try
            {
                stimulus.start(id);
            }
            catch (e: unknown)
            {
                // гонка двух POST: движок уже занят — то же состояние.
                return res
                    .status(409)
                    .json({ error: e instanceof Error ? e.message : String(e) });
            }
            return res.status(202).json(stimulus.status());
        });

        router.post('/stimulus/stop', async (_req, res) =>
        {
            if (stimulus.status().state === 'idle')
            {
                return res.status(409).json({ error: 'Стимул не выполняется' });
            }
            await stimulus.stop();
            return res.json(stimulus.status());
        });
    }

    // SAS-режим (план 6 п.3): монтируются только при DI движка.
    if (sas)
    {
        router.get('/sas', (_req, res) =>
        {
            res.json(sas.status());
        });

        router.post('/sas/enable', (_req, res) =>
        {
            if (station.status().state !== 'running')
            {
                return res.status(409).json({
                    error: 'Станция остановлена — SAS-NOTIFY идут через её сокет',
                });
            }
            if (stimulus && stimulus.status().state !== 'idle')
            {
                return res.status(409).json({
                    error: 'Стимул выполняется — SAS и прогон делят сокет станции',
                });
            }
            // Исходящий вызов НЕ блокирует SAS (doc/task_31_plan_2.md):
            // хуки мультикастятся, режим совместим в обе стороны.
            try
            {
                sas.enable();
            }
            catch (e: unknown)
            {
                // гонка двух POST enable: уже включено — то же состояние.
                return res
                    .status(409)
                    .json({ error: e instanceof Error ? e.message : String(e) });
            }
            return res.json(sas.status());
        });

        router.post('/sas/disable', (_req, res) =>
        {
            try
            {
                sas.disable();
            }
            catch (e: unknown)
            {
                return res
                    .status(409)
                    .json({ error: e instanceof Error ? e.message : String(e) });
            }
            return res.json(sas.status());
        });
    }

    // Исходящий вызов на нижестоящую станцию (doc/task_30_plan_2.md):
    // монтируется только при DI движка. dial/cancel/hangup бросают Error с
    // русским текстом (состояния движка/адресат) — всё честный 409;
    // валидные формы номера/адреса проверяются здесь (400).
    if (outbound)
    {
        router.get('/call', (_req, res) =>
        {
            res.json(outbound.status());
        });

        router.post('/call', (req, res) =>
        {
            const body = (req.body ?? {}) as {
                callee?: unknown;
                caller?: unknown;
                target?: unknown;
                origin?: unknown;
            };
            const callee = typeof body.callee === 'string' ? body.callee.trim() : '';
            if (!NUMBER_RE.test(callee))
            {
                return res
                    .status(400)
                    .json({ error: 'callee — цифры (опционально «+»), 1–24' });
            }
            const caller = typeof body.caller === 'string' ? body.caller.trim() : '';
            if (caller !== '' && !NUMBER_RE.test(caller))
            {
                return res
                    .status(400)
                    .json({ error: 'caller — цифры (опционально «+»), 1–24' });
            }
            const target = typeof body.target === 'string' ? body.target.trim() : '';
            if (target !== '' && !TARGET_RE.test(target))
            {
                return res.status(400).json({ error: 'target — «host» или «host:порт»' });
            }
            // Origin — адрес «откуда пришёл вызов» (ретрансляция From/Via,
            // doc/task_31_plan_2.md); форма та же, что у target.
            const origin = typeof body.origin === 'string' ? body.origin.trim() : '';
            if (origin !== '' && !TARGET_RE.test(origin))
            {
                return res.status(400).json({ error: 'origin — «host» или «host:порт»' });
            }
            if (station.status().state !== 'running')
            {
                return res.status(409).json({
                    error: 'Станция остановлена — INVITE идёт через её UDP-сокет',
                });
            }
            if (stimulus && stimulus.status().state !== 'idle')
            {
                return res.status(409).json({
                    error: 'Стимул выполняется — вызов делит с ним сокет станции',
                });
            }
            // SAS-режим НЕ блокирует вызов (doc/task_31_plan_2.md): хуки
            // станции мультикастятся, NOTIFY и ножка вызова живут параллельно.
            try
            {
                outbound.dial({
                    callee,
                    ...(caller ? { caller } : {}),
                    ...(target ? { target } : {}),
                    ...(origin ? { origin } : {}),
                });
            }
            catch (e: unknown)
            {
                // гонка двух POST / неизвестный адресат — то же состояние.
                return res
                    .status(409)
                    .json({ error: e instanceof Error ? e.message : String(e) });
            }
            return res.status(202).json(outbound.status());
        });

        router.post('/call/cancel', (_req, res) =>
        {
            try
            {
                outbound.cancel();
            }
            catch (e: unknown)
            {
                return res
                    .status(409)
                    .json({ error: e instanceof Error ? e.message : String(e) });
            }
            return res.json(outbound.status());
        });

        router.post('/call/hangup', (_req, res) =>
        {
            try
            {
                outbound.hangup();
            }
            catch (e: unknown)
            {
                return res
                    .status(409)
                    .json({ error: e instanceof Error ? e.message : String(e) });
            }
            return res.json(outbound.status());
        });
    }

    // Таблица регистраций нижестоящей станции (doc/task_33_plan_2.md):
    // монтируется только при DI хранилища. Номер вводит оператор, identifier
    // (u00s00p00) и адрес прихода — автозахват из REGISTER в SAS-режиме
    // (record() станции); формы проверяются здесь (400), уникальность
    // identifier — бросок Error из хранилища (409, как outbound.dial).
    if (registrations)
    {
        router.get('/registrations', (_req, res) =>
        {
            res.json({ registrations: registrations.list() });
        });

        router.post('/registrations', (req, res) =>
        {
            const body = (req.body ?? {}) as {
                identifier?: unknown;
                phone?: unknown;
            };
            const identifier =
                typeof body.identifier === 'string' ? body.identifier.trim() : '';
            if (!IDENTIFIER_RE.test(identifier))
            {
                return res.status(400).json({
                    error:
                        'identifier — идентификатор линии (u00s00p00), ' +
                        '1–64 символа [A-Za-z0-9._-]',
                });
            }
            const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
            if (phone !== '' && !NUMBER_RE.test(phone))
            {
                return res
                    .status(400)
                    .json({ error: 'phone — цифры (опционально «+»), 1–24' });
            }
            try
            {
                return res
                    .status(201)
                    .json({ registration: registrations.add(identifier, phone) });
            }
            catch (e: unknown)
            {
                // дубль identifier (гонка двух POST или ручная строка) —
                // то же состояние, текст хранилища.
                return res
                    .status(409)
                    .json({ error: e instanceof Error ? e.message : String(e) });
            }
        });

        // Правка строки по стабильному id (identifier редактируем и он может
        // занятость ловить — адресация не им). Тело — >=1 поле; пустой phone
        // очищает номер, identifier обязан остаться уникальным.
        router.post('/registrations/:id/update', (req, res) =>
        {
            const id = Number(req.params.id);
            if (!Number.isInteger(id) || id < 1)
            {
                return res.status(400).json({ error: ':id — целое число >= 1' });
            }
            const body = (req.body ?? {}) as {
                phone?: unknown;
                identifier?: unknown;
            };
            if (body.phone === undefined && body.identifier === undefined)
            {
                return res.status(400).json({
                    error: 'Ожидается поле «phone» и/или «identifier»',
                });
            }
            const patch: { phone?: string; identifier?: string } = {};
            if (body.phone !== undefined)
            {
                if (typeof body.phone !== 'string')
                {
                    return res.status(400).json({ error: 'phone — строка' });
                }
                const phone = body.phone.trim();
                if (phone !== '' && !NUMBER_RE.test(phone))
                {
                    return res.status(400).json({
                        error: 'phone — цифры (опционально «+»), 1–24, или пусто',
                    });
                }
                patch.phone = phone;
            }
            if (body.identifier !== undefined)
            {
                if (typeof body.identifier !== 'string')
                {
                    return res.status(400).json({ error: 'identifier — строка' });
                }
                const identifier = body.identifier.trim();
                if (!IDENTIFIER_RE.test(identifier))
                {
                    return res.status(400).json({
                        error:
                            'identifier — идентификатор линии (u00s00p00), ' +
                            '1–64 символа [A-Za-z0-9._-]',
                    });
                }
                patch.identifier = identifier;
            }
            let updated: RegistrationEntry | undefined;
            try
            {
                updated = registrations.update(id, patch);
            }
            catch (e: unknown)
            {
                return res
                    .status(409)
                    .json({ error: e instanceof Error ? e.message : String(e) });
            }
            if (!updated)
            {
                return res
                    .status(404)
                    .json({ error: `Строка ${id} не найдена (перечитайте таблицу)` });
            }
            return res.json({ registration: updated });
        });

        router.delete('/registrations/:id', (req, res) =>
        {
            const id = Number(req.params.id);
            if (!Number.isInteger(id) || id < 1)
            {
                return res.status(400).json({ error: ':id — целое число >= 1' });
            }
            if (!registrations.remove(id))
            {
                return res
                    .status(404)
                    .json({ error: `Строка ${id} не найдена (перечитайте таблицу)` });
            }
            return res.json({ ok: true });
        });
    }

    return router;
}
