# task_38 — игнорирование регистраций и подписок в SAS-режиме (сверх плана, запрос пользователя)

## Запрос

Добавить чекбоксы для включения режимов:

1. игнорировать регистрации (REGISTER) в SAS-режиме;
2. игнорировать подписки (SUBSCRIBE) в SAS-режиме.

Согласованные решения (по образцу молчания на INVITE, doc/task_29):

- «игнорировать» = не отвечать вовсе: REGISTER/SUBSCRIBE от пира остаются
  без ответа (тишина вместо 200 SAS-ветки; в журнале обращений `code: 0`),
  пир видит «SAS-сервер молчит» — по таймерам pjsip его port-register/
  подписка умирает с cause 408;
- REGISTER в молчащем режиме НЕ пишется в таблицу регистраций (регистрация
  у пира не состоялась — заводить справочную строку некорректно); SUBSCRIBE
  не заводит диалог подписки (`subscriptions()` пуст, SAS-движок слать
  NOTIFY некуда);
- флаги действуют ТОЛЬКО в SAS-режиме: вне режима REGISTER → 405 (прежняя
  мимикрия), подписки пакетов event-list/dialog/… принимает пассивный UAS
  (план 5) — флаги его не касаются;
- флаги — настройки станции (как silent_invite/forward_invite/…): живут
  между stop/start, переключаются в любом состоянии слушателя, 409 нет.

## План (согласован)

1. `server/station/station.ts`: `StationStatus.ignore_register_sas` /
   `ignore_subscribe_sas: boolean`; контракт `Station` —
   `ignore_register_sas_mode()`/`set_ignore_register_sas(on)` и
   `ignore_subscribe_sas_mode()`/`set_ignore_subscribe_sas(on)`;
   `SipStation` — два private-флага; `handle_request` — молчание в начале
   SAS-веток REGISTER (до `registrations.record`) и SUBSCRIBE
   (`push_event` с `code: 0`, ответ `''`); шапка — пункт контракта.
2. REST: `POST /api/station/ignore_register_sas {"on":bool}` и
   `POST /api/station/ignore_subscribe_sas {"on":bool}` — контракт 1-в-1 с
   `/silent_invite` (200 с полным статусом, 400 на не-boolean); карта
   маршрутов `server/routes.ts` (эндпоинты 42–43).
3. `public/index.html`: две галочки в блоке «SAS-режим (SSW)» вкладки
   «Станция» (`station-ignore-register-sas`,
   `station-ignore-subscribe-sas`), функции `ignore_register_sas_set()` /
   `ignore_subscribe_sas_set()` по образцу `silent_invite_set()`,
   синхронизация в поллере статуса, обработчики `change`, заголовок.
4. Тесты:
   - unit `tests/unit/station.test.ts` — round-trip флагов в статусе;
     SAS+игнор REGISTER → тишина, журнал `code: 0`, подписки живы;
     SAS+игнор SUBSCRIBE → тишина, диалог не заведён, регистрации живы;
     вне SAS-режима флаги ни на что не влияют (405 / UAS 200);
   - api `tests/api/station.test.ts` — 200/эхо/400 на оба эндпоинта + поля
     формы `GET /api/station`; моки `Station` всех api-файлов — 2 метода +
     поля статуса.
5. Документация: `doc/api.md` — эндпоинты 42–43, поля статуса, карта
   41 → 43; `CLAUDE.md` — пункт «Сверх плана».

Критерий: `npm run build`, `npm run test:unit`, `npm run test:api` зелёные;
приёмка на живой АТС — за стендом (как task_29…37).

## Результат (2026-11-17)

Выполнены пункты 1–5 плана; отклонений нет.

1. `server/station/station.ts` — `StationStatus.ignore_register_sas`/
   `ignore_subscribe_sas`; контракт `Station` —
   `ignore_register_sas_mode()`/`set_ignore_register_sas(on)`,
   `ignore_subscribe_sas_mode()`/`set_ignore_subscribe_sas(on)`;
   `SipStation` — два private-флага (живут между stop/start). В
   `handle_request` молчание в начале SAS-веток: REGISTER — до
   `registrations?.record(...)` (в таблицу не пишется), SUBSCRIBE — условно
   `sas_enabled && ignore_subscribe_sas` внутри ветки `accepts_event`
   (диалог не заводится); обе — `push_event(..., code 0, ...)` и ответ `''`.
   Счётчик `requests_in` продолжает считать запрос, `answered` не двигается.
2. `server/controllers/station_controller.ts` — `POST
   /api/station/ignore_register_sas` и `/ignore_subscribe_sas` (1-в-1 с
   `/silent_invite`: 200 с полным статусом, 400 — `on` не boolean); карта в
   `server/routes.ts` дополнена (эндпоинты 42–43).
3. `public/index.html` — в блоке «SAS-режим (SSW)» две галочки
   (`station-ignore-register-sas`, `station-ignore-subscribe-sas`) с
   title-подсказками про SAS-only; `ignore_register_sas_set()`/
   `ignore_subscribe_sas_set()` (по образцу `silent_invite_set()`, чекбокс
   дизэйблится на время POST); синхронизация в `load_station()` под
   `!cb.disabled`-гардом; слушатели `change`.
4. Тесты:
   - unit `tests/unit/station.test.ts` — новый describe (5 тестов):
     round-trip флагов в статусе; SAS+игнор REGISTER → тишина (нет ответа
     по таймауту), журнал `code: 0`, `requests_in` считает, `answered`
     не двинуто, таблица регистраций пуста (`attach_registrations` +
     `list()`), SUBSCRIBE/OPTIONS отвечаются; SAS+игнор SUBSCRIBE → тишина,
     `subscriptions_count() === 0`, REGISTER отвечает; снятие флага
     возвращает 200/200 и диалог; вне SAS флаги инертны (REGISTER → 405,
     event-list → 200 пассивного UAS с диалогом);
   - api `tests/api/station.test.ts` — GET-форма (2 новых поля) + 2 describe
     по 2 теста (on→200 эхо→off обратно; `{}`/`{on:'да'}` → 400, флаг не
     меняется). Моки `Station` синхронизированы во всех пяти api-файлах
     (station, station_stimulus, station_sas, station_outbound,
     registrations): 4 no-op метода + 2 поля `false` в статусе.
5. `doc/api.md` — карта 41 → 43 (строки 42–43 + примечание про флаги
   станции и SAS-область), поля в примере `GET /api/station`, разделы 42/43;
   `CLAUDE.md` — пункт «Сверх плана» (task_38).

ПРОВЕРКА КРИТЕРИЯ НЕ ВЫПОЛНЕНА: в этой сессии оболочка не работала вообще
(любая команда → exit 1 без вывода), `npm run build` / `test:unit` /
`test:api` запускались лишь формально и падали на оболочке, не доходя до
tsc/vitest. Требуется прогнать в следующей сессии:
`npm run build && npm run test:unit && npm run test:api` (ожидаем unit
145+5=150, api 105+4=109). Приёмка на живой АТС — за стендом
(как task_29…37).
