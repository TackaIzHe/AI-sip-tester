# Отчёт: пункт 4 «Пул виртуальных абонентов» (plan_2.md §4)

Дата выполнения: 2026-10-27. Статус: **выполнен, критерий приёмки зелёный (живая АТС)**.

## Что сделано

### 4.1 `server/sip_pool.ts` — пул абонентов

DI-контракт `SipPool` (мок в api-тестах, п.9) + боевая реализация
`SipSubscriberPool`. Методы ровно по плану:

- `register_subscriber(number)` — REGISTER с Digest (внутри sip.js);
  **идемпотентен**: REGISTERED → сразу `ok` без нового транспорта и REGISTER;
  параллельные вызовы ждут один общий `inflight` (без гонок); при отказе
  станции — `PoolError` с финальным кодом (инвариант №3/BUG-1);
- `unregister(number)` — REGISTER expires=0 + graceful закрытие; нет записи — no-op;
- `call(from, to)` — INVITE (для цепочки п.8 `to=3203`); возвращает запись реестра;
- `answer(number)` — 200 OK на входящий (состояние CALL_IN);
- `reject(number, code?)` — отклонение входящего, код в handle транспорта
  (по умолчанию 486; любой — например 603, для кейсов п.8);
- `hangup(number)` — отбой по состоянию: CANCEL/BYE/reject (логика `SipPhoneClient.hangup`);
- служебное для п.5/п.7: `list_subscribers()`, `list_calls()`, `get_call(id)`,
  `close()` (graceful unregister всех — терминал `quit`).

Устройство:

- запись абонента (`PoolEntry`) заводится **лениво** при первом обращении;
  на абонента — один `PhoneStateMachine` + `SipPhoneClient` (перенос 1-в-1);
- транспорт — через `PoolTransportFactory` (DI-точка): в бою
  `default_transport_factory` → `ClassicTransport(cfg, onTrace)`, в тестах — мок;
  фабрика вызывается внутри `client.register()`, пул навешивает наблюдения
  до `connect()` (`ClassicTransport` буферизует on()/onTrace);
- **все события в `journal`** (схема справки из task_3_plan_2.md):
  `journal.attach_phone(number, sm)` + `journal.attach_transport(number, t)`
  + сырые сообщения `journal.on_sip_message(number, dir, raw)` через onTrace;
- абонент 3 (3203, `can_register: false`) не регистрируется и не звонит —
  `PoolError` **до** создания записи (в `list_subscribers` остаётся ABSENT);
- ошибки — `PoolError(message, code)`; контроллеры п.5 конвертируют в HTTP-коды.

### 4.2 Реестр вызовов `call_id → {from, to, state}`

- `CallRecord = { call_id, from, to, state, direction, owner, ended_at }`;
  завершённые записи остаются в реестре (для отчётов/ассертов «без зависших
  диалогов» кейса 3);
- **Call-ID захватывается из сырого INVITE** (onTrace + `parse_sip_message`):
  до выхода INVITE в сокет запись живёт под временным id `tmp:<номер>-<n>`,
  при первом INVITE переключается на реальный Call-ID. `get_call` ищет по
  обоим видам id;
- `state` записи синхронизирован со стейт-машиной серверной ноги:
  `CALL_OUT/CALL_IN/IN_CALL` — активность, `REGISTERED/UNREGISTERED` +
  `ended_at` — завершение; сверка также в момент захвата Call-ID (стейт
  меняется до/в том же прогоне событий, что и создание записи).

## Результат проверки критериев (п.4)

| Проверка | Результат |
|---|---|
| `npm run build` | ✅ без ошибок |
| `npm run test:unit` | ✅ 45/45 (было 33; +12 sip_pool) |
| регистрация 9404 на живой АТС | ✅ зонд `doc/.probe_pool.ts`: register → `200 OK` → REGISTERED за 37 мс |
| повторный register идемпотентен | ✅ ok за 0 мс, без нового транспорта/REGISTER (в журнале — ни одного лишнего сообщения) |
| unregister | ✅ expires=0 → 200, состояние ABSENT |

Журнал зонда на АТС: `register → 200 (REGISTERED) → register(expires=0) → 200 →
UNREGISTERED` — **401 не было**: станция приняла REGISTER без Digest-challenge
(видимо, nonce закэширован по IP стенда; повторить challenge стенд не обязан —
на сценарии п.4 это не сказывается, Digest-ветка закрыта юнит-тестом отказа 401).

## Отклонения от плана (обоснованные)

1. **Критерий «`POST /api/subscribers/9404/register`» проверен зондом, а не
   HTTP**: express-приложение и маршруты — предмет п.5 (plan_2.md §5.1/§5.4);
   эндпоинт — тонкая обёртка над `register_subscriber`, критериальный смысл
   (регистрация пулом на живой АТС + идемпотентность) подтверждён напрямую.
   В п.5 критерий перепроверяется через curl.
2. **`reject(number, code?)`** использует handle транспорта из события
   `incoming`, а не `SipPhoneClient.rejectIncoming()` (там код жёстко 486) —
   перенесённый `sip_client.ts` не тронут; завершение вызова по-прежнему
   идёт через `terminated` стейт-машины (BUG-6 не затронут).
3. **Временный id записей** (`tmp:<номер>-<n>`) вместо пустого `call_id`:
   реестр — Map по id, запись обязана быть адресуема с момента создания;
   после INVITE адресуется по Call-ID (план: «call_id → {from,to,state}»).
4. **Прогон-зонд** добавлен как `doc/.probe_pool.ts` (скрытый, по образцу
   `doc/.probe-call.py`) — переиспользуется для отладки транспорта до п.8.

## Созданные/изменённые файлы

```
to/
  server/sip_pool.ts          (новый: пул + реестр + DI-контракт)
  tests/unit/sip_pool.test.ts (новый, 12 кейсов, без сети)
  doc/.probe_pool.ts          (зонд живой АТС, не в бандле tsc)
  doc/task_4_plan_2.md        (этот отчёт)
  CLAUDE.md                   (статус)
```

`server/sip/` не менялся; `main.ts` пока не поднимает пул — выраз-апп и
wire-up (конфиг → journal → pool → express → REPL) подключаются в п.5/п.7.

## Краткая справка для следующих сессий (п.5, п.7–9)

- П.5: в bootstrap — `const journal = new Journal(); const pool = new SipSubscriberPool(config, journal);`
  и передача `pool` в контроллеры через DI (параметр приложения, не глобальный
  синглтон) — тогда `tests/api/*` подставляют мок `SipPool`.
  Ошибки: `PoolError.code` (SIP) → 4xx/5xx; «Неизвестный абонент»/`can_register` → 404/403;
  «не зарегистрирован»/«нет вызова» → 409.
- П.7: терминальный `status` = `pool.list_subscribers()` + активные
  (`list_calls()` с `ended_at === 0`); `quit` = `await pool.close()`.
- П.8: кейсы — функции `(pool, journal) => verdict`; цепочка case_2:
  `register 9404/52 → call('9404','52') → [входящий у 52] → answer → hangup`;
  у пула нет ожидания состояний — раннеру свойственен until/sleep (паттерн
  task2/tools/live-atc.mjs).
- П.9: мок — объект, удовлетворяющий `SipPool` (интерфейс узкий, сеть не нужен).

## Симптом → причина → решение (вскрыто на стенде/в тестах)

- *`tsc TS2367: '"REGISTERED"' и '"CALL_OUT"' no overlap`* — TS сохраняет
  сужение type-guard'а по цепочке `entry.sm.snapshot.state` даже после
  мутирующего вызова; состояние после `client.call()` перечитывается через функцию-доступ.
- *Запись вызова не получала Call-ID* — `capture_call_id` считал «пустой» тот
  id, которым запись уже была зарегистрирована как `tmp:...`; признак
  незаполненности — префикс `tmp:`.
- *Запись висела в `PENDING` после INVITE* — стейт-машина меняет состояние до
  создания записи (исходящий) или в том же прогоне `fire` (входящий);
  добавлена сверка `rec.state` по снапшоту в момент захвата Call-ID.

## Следующий шаг

Пункт 5 плана — express-приложение, middleware, контроллеры
(files/reports/subscribers/calls), `routes.ts` (rails-style) + wire-up пула
в `server/main.ts`.
