# REST API сервера SIP-автестов (plan_2.md п.10.1)

Источник истины по маршрутам — карта `server/routes.ts` (`build_api_router`),
реализация — `server/controllers/*`. Этот документ покрывает **каждый** маршрут
карты: задокументировано **41** endpoints == **41** маршрутов `routes.ts`
(критерий п.10; проверить: `grep -rE "router\.(get|post|delete)\(" server/controllers/ | wc -l`).

Базовый URL примеров: `http://<host>:<SERVER_PORT>` (стенд:
`http://192.168.80.159:3000`, в примерах — `localhost:3000`). Все ответы —
JSON (`Content-Type: application/json`), UTF-8.

## Соглашения об ошибках

Единый error-handler (`server/middleware/error_handler.ts`), тело в стиле rails:

```json
{ "error": "<текст причины>" }
```

- `PoolError` из пула (`server/sip_pool.ts`) → HTTP-код из поля `status`
  (просталвлен в месте броска): `403` запрет (3203), `404` неизвестный
  абонент/вызов/отчёт, `409` неправильное состояние, `502` отказ станции
  (SIP-код станции — дополнительно в `sip_code`):

  ```json
  { "error": "Станция отвергла REGISTER 9404", "sip_code": 403 }
  ```

- битый JSON в теле (`express.json()`) → `400 {"error":"Некорректный JSON в теле запроса"}`;
- неизвестный маршрут → `404 {"error":"Маршрут не найден: <METHOD> <url>"}`;
- прочее → `500 {"error":"<message>"}` (без стек-трейса).

## Карта endpoints (41)

| # | Метод | Путь | Контроллер |
|---|---|---|---|
| 1 | GET | `/api/files/tree` | files_controller |
| 2 | GET | `/api/files/content?path=` | files_controller |
| 3 | GET | `/api/reports` | reports_controller |
| 4 | GET | `/api/reports/:id` | reports_controller |
| 5 | DELETE | `/api/reports/:id` | reports_controller |
| 6 | DELETE | `/api/reports` | reports_controller |
| 7 | GET | `/api/subscribers` | subscribers_controller |
| 8 | POST | `/api/subscribers/:number/register` | subscribers_controller |
| 9 | DELETE | `/api/subscribers/:number/register` | subscribers_controller |
| 10 | GET | `/api/calls` | calls_controller |
| 11 | POST | `/api/calls` | calls_controller |
| 12 | GET | `/api/calls/:id` | calls_controller |
| 13 | POST | `/api/calls/:id/answer` | calls_controller |
| 14 | POST | `/api/calls/:id/reject` | calls_controller |
| 15 | POST | `/api/calls/:id/hangup` | calls_controller |
| 16 | GET | `/api/test_runs` | test_runs_controller |
| 17 | POST | `/api/test_runs` | test_runs_controller |
| 18 | GET | `/api/test_runs/:id` | test_runs_controller |
| 19 | GET | `/api/health` | health_controller |
| 20 | GET | `/api/station` | station_controller |
| 21 | POST | `/api/station/start` | station_controller |
| 22 | POST | `/api/station/stop` | station_controller |
| 23 | GET | `/api/station/events` | station_controller |
| 24 | GET | `/api/station/stimulus` | station_controller |
| 25 | POST | `/api/station/stimulus` | station_controller |
| 26 | POST | `/api/station/stimulus/stop` | station_controller |
| 27 | GET | `/api/station/sas` | station_controller |
| 28 | POST | `/api/station/sas/enable` | station_controller |
| 29 | POST | `/api/station/sas/disable` | station_controller |
| 30 | POST | `/api/station/silent_invite` | station_controller |
| 31 | GET | `/api/station/call` | station_controller |
| 32 | POST | `/api/station/call` | station_controller |
| 33 | POST | `/api/station/call/cancel` | station_controller |
| 34 | POST | `/api/station/call/hangup` | station_controller |
| 35 | POST | `/api/station/forward_invite` | station_controller |
| 36 | GET | `/api/station/registrations` | station_controller |
| 37 | POST | `/api/station/registrations` | station_controller |
| 38 | POST | `/api/station/registrations/:id/update` | station_controller |
| 39 | DELETE | `/api/station/registrations/:id` | station_controller |
| 40 | POST | `/api/station/ignore_provisional` | station_controller |
| 41 | POST | `/api/station/multiply_invite` | station_controller |

Маршруты 20–23 монтируются только при наличии станции в DI
(`deps.station` в `build_api_router`, plan_4.md п.3) — в api-тестах без
мока станции это честный `404`. Маршруты 24–26 (стимулы утечки,
doc/task_26) дополнительно требуют движка в DI (`deps.stimulus`): приложение
со станцией, но без движка — `404` на `/stimulus*`. Маршруты 27–29 (SAS-режим,
doc/plan_6.md) дополнительно требуют движок SAS (`deps.sas`): приложение
со станцией, но без движка — `404` на `/sas*`. Маршрут 30 (режим «не отвечать
на вызовы», doc/task_29) — флаг самой станции: монтируется вместе с `/api/station`
и переключается в любом состоянии слушателя (409 тут нет). Маршруты 31–34
(исходящий вызов на нижестоящую станцию, doc/task_30_plan_2.md) дополнительно
требуют движок вызова (`deps.outbound`): приложение со станцией, но без
движка — `404` на `/call*`. Маршрут 35 (перенаправление INVITE по таблице
регистраций, doc/task_34_plan_2.md) — флаг самой станции, монтируется вместе
с `/api/station` (409 тут нет); разбор INVITE и набор делает постоянный хук
движка вызова по таблице регистраций, т. е. флаг действует при
`deps.outbound` и `deps.registrations` (в бою есть всегда).
Маршруты 36–39 (таблица регистраций, doc/task_33_plan_2.md) дополнительно
требуют хранилище в DI (`deps.registrations`): приложение со станцией, но без
хранилища — честный `404` на `/registrations*`. Маршрут 40 (игнорирование
Trying/Ringing перенаправленного INVITE, doc/task_36_plan_2.md) — флаг самой
станции: монтируется вместе с `/api/station` (409 тут нет); 100/180 фильтрует
движок вызова, т. е. флаг действует при `deps.outbound` (в бою есть всегда).

Вне карты — статика (не API, в счётчик не входит): `GET /` → `public/index.html`
(страница, п.6) и `GET /reports/<файл>` → каталог `reports/` (HTML/MD-представления
отчётов, п.3). Оба — `express.static` в `server/app.ts`.

---

## Файлы (п.5.2)

### 1. GET /api/files/tree

Дерево проекта от корня сервера (`process.cwd()`). Скрытые файлы/каталоги
(dotfiles) НЕ фильтруются — правка плана относительно task2; в игноре только
`node_modules` и `.git`. Узел: `{name, dir, children?}`; каталоги первыми,
затем по имени.

Параметры: нет.

Коды: `200`.

```bash
curl -s localhost:3000/api/files/tree
```

Ответ `200` (фрагмент):

```json
[
  { "name": ".claude", "dir": true, "children": [ { "name": "settings.json", "dir": false } ] },
  { "name": ".env", "dir": false },
  { "name": "doc", "dir": true, "children": [] },
  { "name": "package.json", "dir": false }
]
```

### 2. GET /api/files/content?path=

Содержимое текстового файла дерева. `path` — относительный путь от корня.

Параметры запроса: `path` (строка, обязателен).

Коды:

| Код | Когда |
|---|---|
| 200 | текстовый файл прочитан |
| 400 | `path` отсутствует/пуст |
| 403 | выход за корень (`..`-traversal, абсолютный путь вне корня) |
| 404 | нет файла / это каталог |
| 413 | файл > 1 МБ |
| 415 | бинарный (NUL-байт в первых 8 КБ) |

```bash
curl -s 'localhost:3000/api/files/content?path=.env'
curl -s 'localhost:3000/api/files/content?path=../../etc/passwd'
```

Ответ `200`:

```json
{ "content": "# Конфигурация сервера SIP-автестов\nSERVER_PORT=3000\n…" }
```

Ответ `403`: `{"error":"forbidden"}` · `413`: `{"error":"file too large"}` ·
`415`: `{"error":"binary file"}` · `404`: `{"error":"not a file"}`.

---

## Отчёты (п.5.3)

### 3. GET /api/reports

Список отчётов из каталога `reports/` (файлы `*.json`, новые сверху — UTC-метка
в имени даёт хронологию). Отчёты создаёт `Journal.render_report` (п.3) при
прогонах кейсов; переживают перезапуск сервера.

Параметры: нет.

Коды: `200`.

```bash
curl -s localhost:3000/api/reports
```

Ответ `200`:

```json
{
  "reports": [
    {
      "id": "20261027T111818Z_case_1",
      "json": "/api/reports/20261027T111818Z_case_1",
      "md": "/reports/20261027T111818Z_case_1.md",
      "html": "/reports/20261027T111818Z_case_1.html",
      "size": 3610
    }
  ]
}
```

### 4. GET /api/reports/:id

Машиночитаемый JSON отчёта: `{id, generated_at, meta, events[]}` — шапка стенда
(`meta`: кейс, вердикт PASS/FAIL + текст, АТС, номера) и полная цепочка этапов
(`events`: ts, session, direction in/out/internal, kind — метод SIP или веха,
sip_code?, detail, call_id). `id` — имя файла без расширения (только
`[A-Za-z0-9._-]`). HTML-представление того же отчёта — статика
`GET /reports/<id>.html`.

Параметры пути: `id` — идентификатор отчёта из GET /api/reports.

Коды:

| Код | Когда |
|---|---|
| 200 | отчёт найден и распарсен |
| 400 | `id` не прошёл фильтрацию (traversal/пустой/непечатаемые) |
| 404 | файла `<id>.json` нет в `reports/` |

```bash
curl -s localhost:3000/api/reports/20261027T111818Z_case_1
```

Ответ `200` (фрагмент, реальный прогон case_1 на стенде):

```json
{
  "id": "20261027T111818Z_case_1",
  "generated_at": "2026-10-27T11:18:18.975Z",
  "meta": {
    "case": "case_1",
    "verdict": "PASS",
    "verdict_text": "регистрация 9404 подтверждена: REGISTER → (без challenge) → 200",
    "pbx_host": "192.168.80.157",
    "pbx_port": 5060,
    "sip_protocol": "udp",
    "subscribers": ["9404", "52", "3203"]
  },
  "events": [
    { "ts": 1793099898934, "session": "9404", "direction": "out",
      "kind": "register", "detail": "REGISTER", "call_id": "g3rlskek21o5qhp9npjd" },
    { "ts": 1793099898950, "session": "9404", "direction": "in",
      "kind": "register", "detail": "200 OK для REGISTER",
      "call_id": "g3rlskek21o5qhp9npjd", "sip_code": 200 }
  ]
}
```

### 5. DELETE /api/reports/:id

Удаление одного отчёта: со каталога `reports/` снимаются **все три** файла
представления — `<id>.json`, `<id>.md`, `<id>.html` (иначе статика
`/reports/<id>.html` отдавала бы мёртвые ссылки). Кнопка «удалить выбранные»
на странице снимает этим маршрутом каждый отмеченный чекбоксом отчёт.

Параметры пути: `id` — идентификатор отчёта (фильтрация `safe_id`, как у GET).

Коды:

| Код | Когда |
|---|---|
| 200 | отчёт удалён (хотя бы один из трёх файлов был на диске) |
| 400 | `id` не прошёл фильтрацию |
| 404 | файлов отчёта нет на диске |

```bash
curl -sX DELETE localhost:3000/api/reports/20261027T111818Z_case_1
```

Ответ `200`:

```json
{ "deleted": "20261027T111818Z_case_1" }
```

### 6. DELETE /api/reports

Удаление **всех** отчётов: каталог `reports/` чистится целиком (триады
перечисленных отчётов + осиротевшие `.md`/`.html` без пары `.json`).
Кнопка «удалить все» на странице. Идемпотентен: пустой каталог → `200`,
`count: 0`.

Параметры: нет.

Коды: `200`.

```bash
curl -sX DELETE localhost:3000/api/reports
```

Ответ `200`:

```json
{ "deleted": ["20261027T111818Z_case_1", "20261027T111500Z_case_2"], "count": 2 }
```

---

## Абоненты (п.5.3)

### 7. GET /api/subscribers

Состояния всех абонентов из `.env`. `state`: `UNREGISTERED | REGISTERED |
CALL_OUT | CALL_IN | IN_CALL | ABSENT` (`ABSENT` — абонент ещё не регистрировался,
записи пула нет). `can_register: false` у абонента 3 (3203 — только цель вызова).

Параметры: нет.

Коды: `200`.

```bash
curl -s localhost:3000/api/subscribers
```

Ответ `200`:

```json
{
  "subscribers": [
    { "number": "9404", "can_register": true, "state": "REGISTERED",
      "peer": "", "error": "", "registering": false },
    { "number": "52", "can_register": true, "state": "ABSENT",
      "peer": "", "error": "", "registering": false },
    { "number": "3203", "can_register": false, "state": "ABSENT",
      "peer": "", "error": "", "registering": false }
  ]
}
```

### 8. POST /api/subscribers/:number/register

REGISTER на станции (Digest — внутри sip.js, `doc/sip_rfc.md §5.10, §5.4`).
Идемпотенен: уже `REGISTERED` → `200 ok` без нового REGISTER; параллельные
вызовы ждут один REGISTER. Итог — строго из финального ответа станции
(инвариант BUG-1).

Параметры пути: `number` — номер абонента из `.env`.

Коды:

| Код | Когда |
|---|---|
| 200 | зарегистрирован (или уже был REGISTERED — идемпотентно) |
| 403 | абонент `3203` — регистрация запрещена планом |
| 404 | неизвестный номер (не из `.env`) |
| 502 | станция отвергла REGISTER (SIP-код — в `sip_code`) |

```bash
curl -sX POST localhost:3000/api/subscribers/9404/register
```

Ответ `200`:

```json
{ "number": "9404", "ok": true, "code": 0, "text": "" }
```

Ответ `502` (неверный пароль, если станция его проверяет):

```json
{ "error": "Станция отвергла REGISTER 9404", "sip_code": 403 }
```

### 9. DELETE /api/subscribers/:number/register

REGISTER `expires=0` + закрытие транспорта. Нет активной записи абонента —
no-op (успешный ответ, идемпотентность снятия).

Параметры пути: `number`.

Коды: `200` (в т.ч. для незарегистрированного абонента).

```bash
curl -sX DELETE localhost:3000/api/subscribers/9404/register
```

Ответ `200`:

```json
{ "number": "9404", "ok": true }
```

---

## Вызовы (п.5.3)

Запись реестра вызовов (`CallRecord`): `call_id` (Call-ID из сырого INVITE; до
его выхода — временный `tmp:<номер>-<n>`), `from`, `to`, `state`
(`PENDING | CALL_OUT | CALL_IN | IN_CALL | REGISTERED | UNREGISTERED`),
`direction` (`out` — наш исходящий, `in` — входящий на нашего абонента),
`owner` (номер нашего абонента — серверная нога), `ended_at` (мс, 0 — активен).

### 10. GET /api/calls

Все записи реестра (активные и завершённые — завершённые не удаляются).

Параметры: нет.

Коды: `200`.

```bash
curl -s localhost:3000/api/calls
```

Ответ `200`:

```json
{
  "calls": [
    { "call_id": "g3rlskek21o5qhp9npjd", "from": "9404", "to": "52",
      "state": "REGISTERED", "direction": "out", "owner": "9404",
      "ended_at": 1793099932411 }
  ]
}
```

### 11. POST /api/calls

INVITE `from → to` (для прокси-цепочки `to` может быть `3203` — станция
проксирует на 52). Требует `from` REGISTERED у пула; один абонент — один
активный вызов (инвариант стейт-машины).

Тело (JSON, обязательно): `{ "from": "<номер>", "to": "<номер>" }` — строки.

Коды:

| Код | Когда |
|---|---|
| 201 | INVITE отправлен, запись реестра создана |
| 400 | тело без `from`/`to` или не-строки; `from == to` |
| 403 | `from` не может звонить (3203 — не регистрируется) |
| 404 | неизвестный номер `from` (не из `.env`) |
| 409 | `from` не REGISTERED; уже в вызове |
| 502 | не удалось отправить INVITE (нет транспорта и т.п.) |

```bash
curl -sX POST localhost:3000/api/calls \
  -H 'content-type: application/json' -d '{"from":"9404","to":"52"}'
```

Ответ `201` (сразу после INVITE id может быть временным `tmp:…`):

```json
{
  "call": {
    "call_id": "g3rlskek21o5qhp9npjd",
    "from": "9404", "to": "52", "state": "CALL_OUT",
    "direction": "out", "owner": "9404", "ended_at": 0
  }
}
```

### 12. GET /api/calls/:id

Запись реестра по `id` (Call-ID или `tmp:`-id незавершённого вызова).

Параметры пути: `id`.

Коды: `200` / `404` (`{"error":"Вызов <id> не найден"}`).

```bash
curl -s localhost:3000/api/calls/g3rlskek21o5qhp9npjd
```

Ответ `200`: `{"call": { …CallRecord… }}` (форма — как в п.8).

### 13. POST /api/calls/:id/answer

200 OK + ACK на входящий вызов: действие идёт на `owner` записи (номер нашего
абонента), REST адресуется id вызова.

Параметры пути: `id` — вызов в состоянии `CALL_IN` у абонента `owner`.

Коды: `200` (ответ — перечитанная запись, `state: "IN_CALL"`) / `404` нет вызова /
`409` нет входящего вызова у абонента.

```bash
curl -sX POST localhost:3000/api/calls/g3rlskek21o5qhp9npjd/answer
```

Ответ `200`: `{"call": { …, "state": "IN_CALL", … }}`.

### 14. POST /api/calls/:id/reject

Отклонение входящего вызова (BYE-не-нужен: `486 Busy Here` и т.п.,
`doc/sip_rfc.md §7`).

Тело (JSON, необязательное): `{ "code": <число 400–699> }` — SIP-код
отклонения, по умолчанию `486`.

Параметры пути: `id` — вызов в состоянии `CALL_IN`.

Коды:

| Код | Когда |
|---|---|
| 200 | отклонение отправлено (запись завершится событием terminated) |
| 400 | `code` не целое или вне 400–699 |
| 404 | нет вызова с таким id |
| 409 | у абонента нет входящего вызова |

```bash
curl -sX POST localhost:3000/api/calls/g3rlskek21o5qhp9npjd/reject \
  -H 'content-type: application/json' -d '{"code":603}'
```

Ответ `200`: `{"call": { …CallRecord… }}`.

### 15. POST /api/calls/:id/hangup

Отбой активной ноги: `CANCEL` в `CALL_OUT`, `BYE` в `IN_CALL`,
отклонение в `CALL_IN` (выбор — за стейт-машиной).

Параметры пути: `id` — активный вызов.

Коды: `200` (перечитанная запись) / `404` / `409` нет активного вызова у абонента.

```bash
curl -sX POST localhost:3000/api/calls/g3rlskek21o5qhp9npjd/hangup
```

Ответ `200`: `{"call": { …, "state": "REGISTERED", "ended_at": 1793099932411 }}`.

---

## Прогоны кейсов (п.8)

### 16. GET /api/test_runs

Индекс ресурса: список реализованных тест-кейсов (реестр `CASES` из
`e2e_runner.ts` — единый источник истины для страницы, терминала и API).
Используется вкладкой «Тесты» страницы для отрисовки списка.

Параметров нет. Коды: `200`.

```bash
curl -s localhost:3000/api/test_runs
```

Ответ `200`:

```json
{
  "cases": [
    { "id": "1", "name": "case_1" },
    { "id": "2", "name": "case_2" },
    { "id": "3", "name": "case_3" },
    { "id": "4", "name": "case_4" },
    { "id": "5", "name": "case_5" },
    { "id": "noanswer", "name": "case_6_noanswer" },
    { "id": "caller", "name": "case_7_caller_number" },
    { "id": "batch24reg", "name": "case_8a_batch_reg_24_47" },
    { "id": "batch24unreg", "name": "case_8b_batch_unreg_24_47" },
    { "id": "t1", "name": "los_t1_dialog_info" },
    { "id": "t2", "name": "los_t2_event_list" },
    { "id": "t3", "name": "los_t3_dup_subscribes" },
    { "id": "t4", "name": "los_t4_provider_401" },
    { "id": "t5", "name": "los_t5_flood" },
    { "id": "t6", "name": "los_t6_ipc_frames" },
    { "id": "t7", "name": "los_t7_resolver" },
    { "id": "t8", "name": "los_t8_soak" }
  ]
}
```

Кейсы `t1`–`t8` — короткие (~1 мин) версии сценариев генератора стимулов
los_mem (doc/task_22_plan_2.md, интеграция — doc/task_23_plan_2.md); полная
длительность и флаги — только standalone-CLI `npx tsx los_mem_main.ts <t>`.

### 17. POST /api/test_runs

Ставит прогон e2e-кейса в очередь (очередь обязательна — пул абонентов общий)
и сразу отвечает `202`. Исполнение — общий `e2e_runner.run_case` (тот же, что у
терминала `test <…>`); по завершении — вердикты + события журнала + отчёт в
`reports/`. `case: "all"` — все основные кейсы последовательно; стимулы
`t1`–`t8` вне `all` (`CaseDef.in_all: false`, `e2e_runner.cases_for_all`) —
они долгие и агрессивные, включаются только поимённо.

Тело (JSON, обязательно): `{ "case": 1 | 2 | 3 | 4 | 5 | "1"…"5" | "noanswer" | "caller" | "batch24reg" | "batch24unreg" | "t1"…"t8" | "all" }`.

Коды:

| Код | Когда |
|---|---|
| 202 | прогон принят в очередь, `id` создан |
| 400 | нет `case` / нечисловой кейс / неизвестный id |

```bash
curl -sX POST localhost:3000/api/test_runs \
  -H 'content-type: application/json' -d '{"case":1}'
```

Ответ `202` (`id`: `run_<UTC-ts>_case<N>`, `run_<UTC-ts>_all`):

```json
{ "id": "run_20261027T115000Z_case1", "status": "running" }
```

Ответ `400`:

```json
{ "error": "Тело {case: 1|2|3|4|5|noanswer|caller|batch24reg|batch24unreg|t1|t2|t3|t4|t5|t6|t7|t8 | "all"} обязательно" }
```

### 18. GET /api/test_runs/:id

Статус прогона, вердикты и журнал. До завершения: `status: "running"` без
`verdicts/events`; после — `done`, вердикты по каждому кейсу (`case: "all"` —
по одному на кейс), события журнала за прогон и `report` (id/пути отчёта в
вердикте, HTML — `/reports/<id>.html`). `error` — только если прогон бросил
непредусмотренное исключение.

Параметры пути: `id` — из ответа POST /api/test_runs.

Коды: `200` / `404` (`{"error":"Прогон <id> не найден"}`).

```bash
curl -s localhost:3000/api/test_runs/run_20261027T115000Z_case1
```

Ответ `200` (фрагмент):

```json
{
  "id": "run_20261027T115000Z_case1",
  "case": "1",
  "status": "done",
  "started_at": "2026-10-27T11:50:00.123Z",
  "finished_at": "2026-10-27T11:50:02.456Z",
  "verdicts": [
    {
      "case": "case_1",
      "verdict": "PASS",
      "verdict_text": "регистрация 9404 подтверждена: REGISTER → (без challenge) → 200",
      "report": {
        "id": "20261027T115002Z_case_1",
        "dir": "/srv/sip-to/reports",
        "json_path": "/srv/sip-to/reports/20261027T115002Z_case_1.json",
        "md_path": "/srv/sip-to/reports/20261027T115002Z_case_1.md",
        "html_path": "/srv/sip-to/reports/20261027T115002Z_case_1.html"
      }
    }
  ],
  "events": [
    { "ts": 1793100600200, "session": "9404", "direction": "out",
      "kind": "register", "detail": "REGISTER", "call_id": "abc123…" }
  ]
}
```

`report.dir`/`*_path` — пути файловой системы процесса (абсолютные:
`path.resolve('reports')` в `server/journal.ts`), не URL. Ссылка для браузера
строится из `report.id`: `/reports/<id>.html` (статика `server/app.ts`).

---

## Станция (plan_4.md п.3)

Собственная станция-эмулятор (SIP-UAS, ответы на keep-alive). Слушатели
поднимаются только кнопкой/`POST /start` — автозапуска нет. Статус/журнал
безопасны в любом состоянии.

### 20. GET /api/station

Снимок состояния сервиса: состояние, адрес слушателя, счётчики.

Параметры: нет.

Коды: `200`.

```bash
curl -s localhost:3000/api/station
```

Ответ `200`:

```json
{
  "state": "running",
  "host": "192.168.80.159",
  "port": 5060,
  "proto": "both",
  "uptime_s": 42,
  "counters": {
    "requests_in": { "OPTIONS": 3, "REGISTER": 1 },
    "answered": { "200": 3, "405": 1 },
    "ignored": 1,
    "peers": ["192.168.80.157:5060"]
  },
  "last_keepalive_at": "2026-11-05T10:00:21.000Z",
  "error": "",
  "silent_invite": false,
  "forward_invite": false,
  "ignore_provisional": false,
  "multiply_invite": false,
  "last_downstream": "192.168.80.157:5060"
}
```

`port` — фактически занятый номер (при `STATION_PORT=0` — эфемерный); в
`stopped` — из конфига. `error` — текст последней ошибки сокета, `''` чисто.
`silent_invite` — флаг режима «не отвечать на вызовы» (п.30).
`forward_invite` — флаг режима «перенаправлять INVITE по таблице
регистраций» (п.35). `ignore_provisional` — флаг режима «игнорировать
Trying/Ringing после перенаправленного INVITE» (п.40). `multiply_invite` —
флаг режима «умножать перенаправляемый INVITE ×10» (п.41).
`last_downstream` — адрес (`host:port`), с которого нижестоящая станция
последний раз обращалась (REGISTER/OPTIONS/SUBSCRIBE); адресат вызова по
умолчанию в п.32, `''` — пир ещё не обращался.

### 21. POST /api/station/start

Поднять UDP/TCP-слушатели по `station_proto`. Тело не передаётся.

Коды: `200` — запущена (тело — статус, как в 20); `409` — уже запущена;
`502` — bind не удался (EACCES/EADDRINUSE), текст несёт подсказку про
привилегии порта (`root` или `setcap cap_net_bind_service=+ep`).

```bash
curl -s -X POST localhost:3000/api/station/start
```

Ответ `502`:

```json
{ "error": "Не поднять станцию 192.168.80.159:5060 (ошибка слушателя): EACCES — порт привилегированный (<1024): нужен root или `sudo setcap cap_net_bind_service=+ep $(which node)`" }
```

### 22. POST /api/station/stop

Снять слушатели и разорвать TCP-соединения; счётчики и журнал сохраняются.
Тело не передаётся.

Коды: `200` — остановлена (тело — статус); `409` — уже остановлена.

```bash
curl -s -X POST localhost:3000/api/station/stop
```

### 23. GET /api/station/events

Журнал последних ~200 обращений к станции, newest first. Мусор/не-SIP —
строка с `method: "?"` и `code: 0` (ответ не отправлялся).

| Параметр | Тип | По умолчанию |
|---|---|---|
| `limit` | целое `>= 1` | вся ёмкость буфера (200) |

Коды: `200`; `400` — `limit` не целое или `< 1`.

```bash
curl -s "localhost:3000/api/station/events?limit=2"
```

Ответ `200`:

```json
{
  "events": [
    {
      "ts": "2026-11-05T10:00:21.000Z",
      "peer": "192.168.80.157:5060",
      "proto": "udp",
      "method": "OPTIONS",
      "ruri": "sip:192.168.80.159:5060",
      "cseq": "16570 OPTIONS",
      "call_id": "ka-1",
      "code": 200
    }
  ]
}
```

---

### 30. POST /api/station/silent_invite

Режим «не отвечать на вызовы (INVITE)» — галочка вкладки «Станция»
(doc/task_29). Во включённом режиме INVITE от пира (вызов от нижестоящей
станции) остаётся совсем без ответа — ни 405, ни 180/486 (в журнале обращений
такой запрос с `code: 0`); ретрансляции молчат тоже. OPTIONS/REGISTER/прочее
отвечаются как обычно. Флаг — настройка станции: живёт между `stop`/`start`,
переключается в любом состоянии слушателя.

Тело: `{"on": true|false}` (обязательно, boolean).

Коды: `200` (ответ — полный статус, как `GET /api/station`); `400` — `on`
отсутствует или не boolean.

```bash
curl -s -X POST localhost:3000/api/station/silent_invite \
  -H 'Content-Type: application/json' -d '{"on":true}'
```

Ответ `200`: тот же JSON, что `GET /api/station`, с `"silent_invite": true`.

---

### 35. POST /api/station/forward_invite

Режим «перенаправлять INVITE по таблице регистраций» — галочка вкладки
«Станция» (doc/task_34_plan_2.md, переопределяет doc/task_32_plan_2.md).
Во включённом режиме входящий `INVITE sip:<номер>@…` от пира не получает
ответа мимикрии (в журнале обращений — `code: 0`), а ретранслируется
движком исходящего вызова (п.31–34) по строке таблицы регистраций (36–39):
UDP-адресат — `address` строки с `phone` = номер из R-URI, R-URI —
`sip:<identifier>@<наш_ip:порт станции>`, `From: sip:<номер>@<наш_ip>`
(номер звонящего — из той же таблицы по identifier из Contact входящего,
fallback — From), `To`/`Contact` — наш IP (`STATION_HOST`), src-адрес
отправителя — вторым Via. Маршрут не найден (нет строки / пуст `address` /
таблица не подключена) — INVITE не съедается: прежний `405` мимикрии.
Retransmit того же INVITE (тот же Call-ID) новый набор не поднимает; при
занятом движке и адресате-петле (адрес самой станции) съедается без набора —
причины в журнале вкладки «Вызов». Совместно с `silent_invite` приоритетнее
перенаправление. Флаг — настройка станции: живёт между `stop`/`start`,
переключается в любом состоянии слушателя; без движка вызова и таблицы
регистраций в DI ни на что не влияет.

Тело: `{"on": true|false}` (обязательно, boolean).

Коды: `200` (ответ — полный статус, как `GET /api/station`); `400` — `on`
отсутствует или не boolean.

```bash
curl -s -X POST localhost:3000/api/station/forward_invite \
  -H 'Content-Type: application/json' -d '{"on":true}'
```

Ответ `200`: тот же JSON, что `GET /api/station`, с `"forward_invite": true`.

---

## Стимулы утечки памяти (doc/task_26)

T1–T8 генератора `doc/los_mem/plan_test.md` прогоном ВНУТРИ станции: трафик
уходит через UDP-сокет станции (:5060) с её идентичностью (Via/Contact =
`STATION_HOST`) — keep-alive пира возвращается на станцию, её SUBSCRIBE
закрывает наш пассивный UAS. Короткие дефолты (~1 мин, `LOS_QUICK_OPTS`).
Вердикта нет (решение оператора, doc/task_22_plan_2.md): успех = «стимул
сгенерирован, сводка получена»; фазы пишутся в `reports/los_<t>_<UTC>.csv`.

### 24. GET /api/station/stimulus

Снимок прогона + список стимулов реестра.

Параметры: нет.

Коды: `200`.

```bash
curl -s localhost:3000/api/station/stimulus
```

Ответ `200`:

```json
{
  "status": {
    "state": "running",
    "id": "t6",
    "started_at": "2026-11-06T10:00:00.000Z",
    "uptime_s": 7,
    "log": ["[2026-11-06T10:00:00.120Z] стимул t6: цель 192.168.80.157:5060, от адреса станции 192.168.80.159:5060"],
    "summary": "",
    "error": "",
    "csv": "reports/los_t6_20261106T100000Z.csv"
  },
  "cases": [
    { "id": "t1", "title": "T1: BLF-подписки + NOTIFY с битым XML" },
    { "id": "t8", "title": "T8: ..." }
  ]
}
```

`state`: `idle` (сводка/ошибка/`csv` — от последнего прогона) | `running` |
`stopping` (досрочная остановка, идёт зачистка). `log` — последние строки
движка (фазы/старт/итог), newest first, ≤80.

### 25. POST /api/station/stimulus

Запустить короткий прогон стимула `id` фоном (движок в процессе сервера).

| Поле тела | Тип | Обязательное |
|---|---|---|
| `id` | строка `t1`…`t8` | да |

Коды: `202` — прогон начат (тело — статус, как в 24); `400` — тело без
`id`/не строка/неизвестный id; `409` — движок занят другим прогоном или
станция остановлена (стимул идёт через её сокет).

```bash
curl -s -X POST localhost:3000/api/station/stimulus -H 'Content-Type: application/json' -d '{"id":"t6"}'
```

### 26. POST /api/station/stimulus/stop

Досрочная остановка прогона: сценарий замечает флаг за ≤500 мс и делает
graceful-зачистку (unsubscribe/unreg). Тело не передаётся.

Коды: `200` — прогон завершён (тело — статус с `summary`/`error`); `409` —
прогон не выполняется. `POST /api/station/stop` при активном прогоне сначала
дожидается его зачистки, потом снимает слушатель.

```bash
curl -s -X POST localhost:3000/api/station/stimulus/stop
```

---

## SAS-режим (doc/plan_6.md)

Роль SAS/SSW-сервера для станции-пира (дампы `doc/los_mem/new_log/11.log`,
`12.log`): станция с `SAS=<наш адрес>` шлёт на :5060 port-register REGISTER и
SUBSCRIBE SSW-пакета — в SAS-режиме станция принимает их `200` (вне — 405), а
движок шлёт инициативные SSInfo NOTIFY (`application/ss-info+xml`, обязательный
`Subscription-State`) строго в диалог принятой подписки. SAS и стимул делят
сокет станции и хук входящих — одновременная работа запрещена (`409`).

### 27. GET /api/station/sas

Снимок SAS-режима: состояние, подписки станции-SAS, учёт NOTIFY.

Параметры: нет.

Коды: `200`.

```bash
curl -s localhost:3000/api/station/sas
```

Ответ `200`:

```json
{
  "state": "on",
  "enabled_at": "2026-11-09T14:10:00.000Z",
  "subs": [
    {
      "call_id": "0001abcd...",
      "event": "ssw-srvm",
      "number": "u00s30p07",
      "remote": { "host": "192.168.80.133", "port": 5060 },
      "expires_at": "2026-11-09T16:10:00.000Z",
      "sent": 3,
      "last_notify_at": "2026-11-09T14:12:00.000Z",
      "last_response": "200"
    }
  ],
  "sent": 3,
  "answered": { "200": 3 },
  "log": ["[2026-11-09T14:12:00.000Z] NOTIFY → 192.168.80.133:5060 cseq=3 CID=0001abcd... ..."]
}
```

`event` — имя SAS-пакета на проводе (из её SUBSCRIBE), `number` — абонент из
R-URI (`u00sXXpXX`), `remote` — Contact подписки (адресат NOTIFY); `log` —
raw-журнал отправленных NOTIFY, newest first, ≤80.

### 28. POST /api/station/sas/enable

Включить SAS-режим (SAS-флаг станции + приём её REGISTER/SUBSCRIBE +
периодические NOTIFY). Тело не передаётся. С активным исходящим вызовом
совместим (doc/task_31_plan_2.md): хуки входящих станции мультикастятся,
NOTIFY и ножка вызова живут параллельно.

Коды: `200` — включён (тело — статус, как в 27); `409` — станция остановлена,
стимул выполняется или режим уже включён (текст `{"error": …}` по-русски).

```bash
curl -s -X POST localhost:3000/api/station/sas/enable
```

### 29. POST /api/station/sas/disable

Выключить SAS-режим: таймер и хук ответов снимаются, мимикрия 405
восстанавливается; диалоги подписок станции не трогаются (SSW снимает свою
подписку сам). Тело не передаётся.

Коды: `200` — выключен (тело — статус с `state: "off"`); `409` — уже выключен.
`POST /api/station/stop` при включённом режиме сначала гасит его, потом снимает
слушатель.

```bash
curl -s -X POST localhost:3000/api/station/sas/disable
```

---

## Исходящий вызов (doc/task_30_plan_2.md)

Станция играет вышестоящую: INVITE на нижестоящую станцию (пир, обращающийся
keep-alive/REGISTER/SUBSCRIBE) с полным циклом UAC — ответы, ACK на 200,
отбой CANCEL/BYE. Запросы идут UDP-сокетом станции; вызов и SAS совместимы
(мультикаст-хук входящих, doc/task_31_plan_2.md), стимул T1–T8 с ними
разведён 409 в обе стороны.

### 31. GET /api/station/call

Снимок движка вызова: состояние текущего (или последнего) вызова.

Параметры: нет.

Коды: `200`.

```bash
curl -s localhost:3000/api/station/call
```

Ответ `200`:

```json
{
  "state": "ringing",
  "callee": "52",
  "caller": "9404",
  "target": "192.168.80.157:5060",
  "origin": "192.168.80.200:5070",
  "call_id": "a1b2c3…@192.168.80.200",
  "last_code": 180,
  "last_reason": "Ringing",
  "error": "",
  "sent": 1,
  "answered": { "180": 1 },
  "log": ["[2026-11-13T12:00:01.000Z] ← 180 Ringing (INVITE)"],
  "multiplied_active": 0
}
```

`state`: `idle | calling | ringing | answered | cancelling | terminating`;
`target` — адресат ACK/BYE (после 200 — из Contact); `origin` — адрес
«откуда пришёл вызов» (ретрансляция, см. 32; `""` — вызов от станции);
`answered` — ответы по кодам; `log` — newest first; `multiplied_active` —
число живых теневых копий фан-аута ×10 (п.41, режим `multiply_invite`;
`0` — вне умножения).

### 32. POST /api/station/call

Отправить INVITE: `{"callee": "<номер>", "caller": "<номер>", "target":
"<host[:порт]>", "origin": "<host[:порт]>"}` — `callee` обязателен (цифры,
опционально «+», 1–24); `caller` — From-номер (пусто — первый абонент
конфига); `target` — куда слать (пусто — `last_downstream` из п.20, при его
пустоте — 409); `origin` — необязательный адрес «откуда пришёл вызов»
(ретрансляция, doc/task_31_plan_2.md): From и Call-ID несут его домен, в
INVITE добавляется второй Via с ним (верхний Via и Contact остаются
станцией — ответы возвращаются к нам, CANCEL/ACK на не-2xx зеркалят стек,
in-dialog ACK/BYE идут с одним Via, но From-домен остаётся origin). Тело
INVITE — SDP-заглушка (медиа нет никогда).

Коды: `202` — INVITE отправлен (тело — статус, как в 31); `400` — битая
форма номера/адреса/origin; `409` — вызов уже активен, станция остановлена,
стимул выполняется или адресат неизвестен (текст `{"error": …}`). С
SAS-режимом совместим.

```bash
curl -s -X POST localhost:3000/api/station/call \
  -H 'Content-Type: application/json' \
  -d '{"callee":"52","origin":"192.168.80.200:5070"}'
```

### 33. POST /api/station/call/cancel

Отбой до финального ответа: CANCEL тем же branch/CSeq, что INVITE (RFC 3261
§9.1); движок сам ждёт финал (обычно 487) и ACK'ает его. Тело не передаётся.

Коды: `200` — CANCEL отправлен (тело — статус с `state: "cancelling"`);
`409` — вызова нет, уже отправлен или вызов соединён (тогда нужен hangup).

```bash
curl -s -X POST localhost:3000/api/station/call/cancel
```

### 34. POST /api/station/call/hangup

Отбой после соединения: BYE (CSeq 2) в диалог (адресат — Contact из 200).
Тело не передаётся.

Коды: `200` — BYE отправлен (тело — статус с `state: "terminating"`);
`409` — вызов не в состоянии `answered`.

```bash
curl -s -X POST localhost:3000/api/station/call/hangup
```

`POST /api/station/stop` и `shutdown()` гасят активный вызов `abort()`
первым (CANCEL/BYE best-effort) — раньше снятия слушателя и стимула/SAS.

---

## Регистрации (doc/task_33_plan_2.md)

Справочник линий нижестоящей станции (будущая маршрутизация вызовов в
SAS-режиме): строка = `identifier` линии (`u00s00p00` — user из R-URI её
REGISTER), `phone` (вводит оператор), `address` (host:port, с которого пришёл
последний REGISTER) и `last_seen_at` (ISO времени последнего REGISTER).
Хранилище — память процесса (`server/station/registrations.ts`): REGISTER
станции в SAS-режиме добавляет/обновляет строку сам (re-REGISTER — адрес и
время обновляются, телефон оператора сохраняется; `expires=0` строку НЕ
удаляет), ручные строки — POST. Требуется хранилище в DI
(`deps.registrations`) — иначе честный `404` на `/registrations*`.

### 36. GET /api/station/registrations

Таблица регистраций целиком (порядок вставки строк).

Параметры: нет.

Коды: `200`.

```bash
curl -s localhost:3000/api/station/registrations
```

Ответ `200`:

```json
{
  "registrations": [
    {
      "id": 1,
      "identifier": "u00s00p00",
      "phone": "100",
      "address": "192.168.80.133:5060",
      "last_seen_at": "2026-11-13T12:00:01.000Z"
    }
  ]
}
```

`id` — стабильный номер строки (адресация правки/удаления); у ручной строки
без пришедшего REGISTER `address`/`last_seen_at` — `""`.

### 37. POST /api/station/registrations

Добавить строку вручную: `{"identifier": "<линия>", "phone": "<номер>"}` —
`identifier` обязателен (`[A-Za-z0-9._-]`, 1–64, регистр значим — точное
сравнение), `phone` необязателен (цифры, опционально «+», 1–24). Строка
создаётся с пустыми `address`/`last_seen_at`.

Коды: `201` — строка добавлена (тело — `{"registration": {…}}`, как в 36);
`400` — поля не по форме; `409` — identifier уже есть в таблице (ручная или
авто-строка).

```bash
curl -s -X POST localhost:3000/api/station/registrations \
  -H 'Content-Type: application/json' \
  -d '{"identifier":"u00s00p00","phone":"100"}'
```

### 38. POST /api/station/registrations/:id/update

Правка строки по стабильному `id`: `{"phone": "<номер>"}` и/или
`{"identifier": "<линия>"}` (минимум одно поле). Пустой `phone` очищает
номер; `identifier` обязан остаться уникальным.

Коды: `200` — правка применена (тело — `{"registration": {…}}`);
`400` — `:id` не целое >= 1, пустое тело или поля не по форме; `404` — нет
такой строки; `409` — новый identifier занят другой строкой.

```bash
curl -s -X POST localhost:3000/api/station/registrations/1/update \
  -H 'Content-Type: application/json' \
  -d '{"phone":"101"}'
```

### 39. DELETE /api/station/registrations/:id

Снять строку из таблицы (единственный способ снятия: REGISTER `expires=0`
строку не удаляет — это справочник линий).

Коды: `200` — `{"ok": true}`; `400` — `:id` не целое >= 1; `404` — нет
такой строки (повторный DELETE).

```bash
curl -s -X DELETE localhost:3000/api/station/registrations/1
```

---

### 40. POST /api/station/ignore_provisional

Режим «игнорировать Trying/Ringing после перенаправленного INVITE» —
галочка вкладки «Станция» (doc/task_36_plan_2.md). Во включённом режиме
движок исходящего вызова (п.31–34) не замечает `100 Trying` и `180 Ringing`
на INVITE, поднятый перенаправлением (п.35): вызов не переходит в
`ringing`, счётчики `answered`/`last_code` не двигаются — ответ лишь
потребляется (в `ignored` станции не попадает) и помечается в журнале
вкладки «Вызов» строкой «игнорирован». Прямой вызов из формы (п.32) и
финальные ответы (2xx/3xx+, прочие 1xx) флагом не затронуты. Флаг —
настройка станции: живёт между `stop`/`start`, переключается в любом
состоянии слушателя; без движка вызова в DI ни на что не влияет.

Тело: `{"on": true|false}` (обязательно, boolean).

Коды: `200` (ответ — полный статус, как `GET /api/station`); `400` — `on`
отсутствует или не boolean.

```bash
curl -s -X POST localhost:3000/api/station/ignore_provisional \
  -H 'Content-Type: application/json' -d '{"on":true}'
```

Ответ `200`: тот же JSON, что `GET /api/station`, с
`"ignore_provisional": true`.

### 41. POST /api/station/multiply_invite

Режим «умножать перенаправляемый INVITE ×10» — галочка вкладки «Станция»
(doc/task_37_plan_2.md). Во включённом режиме перенаправление (п.35)
ретранслирует входящий INVITE десятью копиями разом — в один synchronous-
проход хука: главный диалог владеет состоянием и счётчиками вызова (п.31),
остальные девять — теневые диалоги со своими Call-ID/branch/From-tag
(байты — тот же образец pimer.md, адресат один — из таблицы регистраций).
Копии самозавершающиеся: не-2xx финал → ACK той же веткой и снятие, 2xx →
ACK в диалог + немедленный BYE (линию копия не держит); «отбой» (п.33) и
останов станции накрывают копии; `ignore_provisional` (п.40) действует на
копии как на главный. Число живых копий — `multiplied_active` в п.31.
Флаг — настройка станции: живёт между `stop`/`start`, без перенаправления
ни на что не влияет.

Тело: `{"on": true|false}` (обязательно, boolean).

Коды: `200` (ответ — полный статус, как `GET /api/station`); `400` — `on`
отсутствует или не boolean.

```bash
curl -s -X POST localhost:3000/api/station/multiply_invite \
  -H 'Content-Type: application/json' -d '{"on":true}'
```

Ответ `200`: тот же JSON, что `GET /api/station`, с
`"multiply_invite": true`.

---

## Здоровье (п.5.4)

### 19. GET /api/health

Статус-строка страницы: адрес/протокол АТС, адрес моста, абоненты. Только
чтение конфига — пул не опрашивается, health не зависит от SIP-операций.

Параметры: нет.

Коды: `200`.

```bash
curl -s localhost:3000/api/health
```

Ответ `200`:

```json
{
  "status": "ok",
  "uptime_s": 412,
  "pbx_host": "192.168.80.157",
  "pbx_port": 5060,
  "sip_protocol": "udp",
  "bridge": "192.168.80.159:8090",
  "subscribers": [
    { "number": "9404", "can_register": true },
    { "number": "52", "can_register": true },
    { "number": "3203", "can_register": false }
  ],
  "station": { "state": "stopped", "host": "192.168.80.159", "port": 5060 },
  "sas": { "state": "off" }
}
```

Блок `station` присутствует только при станции в DI (plan_4.md п.3) —
пилюля статус-строки страницы рисуется по нему; без станции ключа нет.
Блок `sas` (план 6 п.3) — только при движке SAS в DI: лишь флаг `state`
(`off`/`on`), счётчики — в `GET /api/station/sas`.

related: `server/routes.ts` (карта), `server/controllers/` (реализация),
`doc/task_9_plan_2.md` (тесты, фиксирующие коды), `README.md` (запуск).
