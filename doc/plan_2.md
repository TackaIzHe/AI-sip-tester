# План работ: task3 — сервер SIP-автотестов с веб-интерфейсом (Express, rails-style API)

## Context

Задача (`doc/treb.md`): Node+TS сервер, реализующий SIP-протокол **как в `task2/`** (мост
`bridge/*` на sip.js поверх классического UDP/TCP), против **живой АТС**
`192.168.80.157:5060` (рабочий пример — `doc/.probe-call.py`: регистрация 9404, вызов на 52;
сервер доступен с `192.168.80.159`). Asterisk запрещён.

Подтверждено пользователем:
- **Страница** = дерево файлов сервера (вкл. скрытые, просмотр содержимого) + раздел отчётов.
  Браузерного телефона нет; звонки делает сам сервер (виртуальные абоненты).
- **Отчёты** генерируются сервером в `reports/` (HTML+MD+JSON) и отдаются статикой; в отчёте —
  все этапы: регистрация (401→200), INVITE, 100/180, 200+ACK, ответ, отклонение (486),
  сброс (BYE), не-ответ (480/таймаут), CANCEL.
- **Терминал сервера** — пользовательский ввод: запуск тест-кейсов (`test 1..4|all`), `help`, `quit`.
- Абонент **3203** — только цель вызова (цепочка прокси 9404→3203→52), **не регистрируется**;
  в тестах регистрируем 9404 и 52. Номера/пароли (образец: 123 и 321) — только из `.env`,
  правятся без правки кода.
- Стиль: `snake_case` (файлы, переменные, функции), комментарии/доки на русском
  (как `task2/CLAUDE.md`). API — Express, паттерн Rails (routes + контроллеры по категориям,
  REST-именование).

Новый проект — в корне `to/` (`package.json`, `server/`, `public/`, `tests/`, `doc/`;
`task2/` не трогаем — источник кода). Протокольная справка — `doc/sip_rfc.md`
(REGISTER §5.10, Digest 401/407 §5.4, CANCEL §5.9, BYE §5.8, коды ответов §7 — ссылаться в коде).

## Целевая структура

```
to/
  .env / .env.example   # SERVER_PORT, PBX_HOST, PBX_PORT, SIP_PROTOCOL(udp|tcp),
                        # BRIDGE_HOST, BRIDGE_PORT, SIP_NUMBER_1..3, SIP_PASS_1..3
  package.json          # deps: express, ws, sip.js, dotenv;
                        # dev: typescript, tsx, vitest, supertest, @types/*
  tsconfig.json         # модель task2 (ESM, strict)
  server/
    main.ts             # bootstrap: конфиг → express → WS-мост → REPL терминала
    config.ts           # загрузка/валидация .env (единая точка чтения env)
    journal.ts          # журнал SIP-событий → генерация отчётов (json+md+html) в reports/
    sip_pool.ts         # виртуальные абоненты: ClassicTransport+SipPhoneClient на абонента,
                        # реестр сессий/вызовов, публикация событий в journal
    terminal.ts         # readline-REPL: `test <1|2|3|4|all>`, `status`, `help`, `quit`
    routes.ts           # все маршруты (rails-style resources)
    controllers/
      files_controller.ts       # GET /api/files/tree, GET /api/files/content?path=
      reports_controller.ts     # GET /api/reports, GET /api/reports/:id
      subscribers_controller.ts # GET /api/subscribers, POST/DELETE …/register
      calls_controller.ts       # POST /api/calls, GET /api/calls/:id, POST …/answer|reject|hangup
    middleware/error_handler.ts, middleware/request_logger.ts
    sip/                # порт из task2 (snake_case имена файлов):
      protocol.ts, session.ts, classic_transport.ts, sip_node_transport.ts  ← task2/bridge/
      state.ts, sip_client.ts, transport.ts, sip_text.ts, config.ts         ← task2/src/
  bridge_main.ts        # WS-мост (JSON v:1) на BRIDGE_HOST:BRIDGE_PORT из .env
                        # (порт task2/bridge/main.ts: heartbeat 30 с, 1 WS = 1 BridgeSession)
  e2e_runner.ts         # раннер кейсов 1–5 (используется terminal.ts и POST /api/test_runs)
  public/index.html     # страница: дерево файлов + просмотр + отчёты (vanilla JS, без сборки)
  reports/              # генерируемые отчёты (express.static)
  tests/
    unit/  config.test.ts, state.test.ts, journal.test.ts
    api/   files.test.ts, reports.test.ts, subscribers.test.ts, calls.test.ts  # supertest
    e2e/   case_1_registration.test.ts … case_5_passwords.test.ts              # живая АТС
  doc/ (api.md — по каждому endpoint; arch.md), README.md
```

## Детерминированные пункты работ

### 1. Каркас и конфиг
- 1.1 `package.json`: скрипты `start` (`tsx server/main.ts`), `build` (`tsc --noEmit`),
  `test:unit`, `test:api`, `test:e2e`. `npm i`.
- 1.2 `.env.example` + `.env` — заглушки по образцу doc: `PBX_HOST=192.168.80.157`,
  `PBX_PORT=5060`, `SIP_PROTOCOL=udp`, `SERVER_PORT=3000`, `BRIDGE_HOST=192.168.80.159`,
  `BRIDGE_PORT=8090`, `SIP_NUMBER_1=9404/SIP_PASS_1=123`, `SIP_NUMBER_2=52/SIP_PASS_2=321`,
  `SIP_NUMBER_3=3203/SIP_PASS_3=123` (реальные значения пользователь впишет сам).
- 1.3 `server/config.ts`: `dotenv` + валидация (порты 1–65535, протокол udp|tcp, номера — цифры),
  явная пометка «3203 — вызываемый, не регистрируется».
- 1.4 `tsconfig.json` (модель task2).
- **Критерий:** `npm run build` зелёный; юнит-тест config (подмена `process.env`) зелёный.

### 2. Перенос SIP-кода из task2 (механический: пути импортов + snake_case-имена файлов)
- 2.1 `server/sip/`: `state.ts`, `sip_client.ts`, `transport.ts`, `sip_text.ts` из `task2/src/`;
  в `transport.ts` — убрать ветки `ws/wss` (режим один — классический через мостовую фабрику);
  `config.ts` упростить до host/sip_port/number/password/transport.
- 2.2 `server/sip/`: `classic_transport.ts`, `sip_node_transport.ts`, `session.ts`, `protocol.ts`
  из `task2/bridge/` без смены логики (rport в Via, `m=9`+`a=inactive`, viaHost=адрес сокета,
  Digest — внутри sip.js). Сохранить русские шапки и добавить ссылки `doc/sip_rfc.md §…`.
- 2.3 `bridge_main.ts` — порт `task2/bridge/main.ts`: слушает `BRIDGE_HOST:BRIDGE_PORT` из `.env`.
- **Критерий:** `npm run build` зелёный; перенесённый `tests/unit/state.test.ts` зелёный.

### 3. Журнал и генерация отчётов
- 3.1 `journal.ts`: событие `{ts, session, direction, kind, sip_code?, detail, call_id}`;
  подписка на снапшоты стейт-машины и транспортные события (REGISTER, 401/407, 200, INVITE,
  100/180, 200+ACK, BYE, CANCEL, 480/486/487).
- 3.2 Рендер: `reports/<UTC-ts>_<case>.json|.md|.html` — шапка (адрес АТС, протокол, номера) +
  таблица этапов + вердикт PASS/FAIL; `express.static('/reports', 'reports/')`.
- **Критерий:** `tests/unit/journal.test.ts` — по синтетическому логу в temp-каталог
  создаются 3 файла; в HTML присутствуют все этапы цепочки.

### 4. Пул виртуальных абонентов (`sip_pool.ts`)
- 4.1 `sip_pool`: `register_subscriber(number)`, `unregister(number)`, `call(from,to)`,
  `answer(number)`, `reject(number, code?)`, `hangup(number)`; на абонента — один
  `SipPhoneClient`+`ClassicTransport` (параметры из `.env`); все события — в `journal`.
- 4.2 Реестр вызовов `call_id → {from, to, state}` для REST-эндпоинтов; DI-интерфейс пула
  (для мока в api-тестах).
- **Критерий:** `npm start` + `POST /api/subscribers/9404/register` → 9404 зарегистрирован
  на живой АТС; повторный register идемпотентен.

### 5. Express: приложение, контроллеры, маршруты (rails-паттерн)
- 5.1 `app`: `express.json()`, `request_logger`, `error_handler` (JSON `{error}`),
  статика `/` → `public/`, `/reports` → `reports/`.
- 5.2 `files_controller` — порт `buildTree`/content-middleware из `task2/vite.config.ts:18-70`
  **с одной правкой**: dotfiles НЕ фильтруются (убрать `startsWith('.')`); в игноре только
  `node_modules`, `.git`. Content: traversal-защита (`resolve`+префикс), 404 не-файл,
  413 >1 МБ, 415 бинарные (NUL в первых 8 КБ).
- 5.3 Контроллеры поверх пула: subscribers, calls, reports (по файлам `reports/`).
- 5.4 `routes.ts` (rails-style):
  ```
  GET    /api/files/tree                 GET    /api/files/content?path=
  GET    /api/reports                    GET    /api/reports/:id
  GET    /api/subscribers                POST   /api/subscribers/:number/register
                                          DELETE /api/subscribers/:number/register
  GET    /api/calls                      POST   /api/calls {from,to}
  GET    /api/calls/:id                  POST   /api/calls/:id/answer|reject|hangup
  POST   /api/test_runs {case:1..4|"all"} GET  /api/test_runs/:id
  GET    /api/health
  ```
- **Критерий:** сервер стартует; `/api/files/tree` содержит `.claude/`, `.env`;
  `/api/files/content?path=../../etc/passwd` → 403.

### 6. Страница (`public/index.html`, vanilla JS, без сборки)
- 6.1 Панель «Файлы»: дерево от `/api/files/tree` (клик по каталогу — сворачивание, по файлу —
  содержимое через content-API, скрытые подсвечены). Панель «Отчёты»: список от `/api/reports`,
  просмотр HTML-отчёта.
- 6.2 Статус-строка: health + адрес/протокол АТС из `/api/health`.
- **Критерий:** `http://<host>:3000/` — дерево со скрытыми; клик открывает содержимое;
  отчёт прогона открывается.

### 7. Терминал сервера (`terminal.ts`, readline)
- 7.1 Команды: `test 1|2|3|4|all` (тот же `e2e_runner`, что и `POST /api/test_runs`; шаги —
  в терминал, отчёт — в `reports/`), `status` (регистрации/активные вызовы), `help`,
  `quit` (graceful: unregister всех → закрыть WS/http).
- **Критерий:** `test 1` в терминале сервера даёт отчёт с этапами
  `REGISTER → 401 → REGISTER+Digest → 200`.

### 8. E2E тест-кейсы (`e2e_runner.ts` + `tests/e2e/`, против живой АТС)
- 8.1 `case_1` регистрация: 9404 (пароль из `.env`) → REGISTERED; unregister → UNREGISTERED.
- 8.2 `case_2` вызов+приём: 9404 и 52 зарегистрированы; 9404→52, 52 отвечает, IN_CALL у обоих,
  hangup → REGISTERED (в отчёте: INVITE/180/200/ACK/BYE).
- 8.3 `case_3` приём и отклонение: один вызов принят (200), второй отклонён (`reject` → 486);
  вызывающий возвращается в REGISTERED без зависших диалогов.
- 8.4 `case_4` прокси-цепочка 9404→3203→52: регистрируем **только** 9404 и 52; вызов уходит
  через 3203; ассерт — входящий arrives у **52** (не у 3203), принимается на ноге 52,
  established + BYE. Перед фиксацией assert-ов — ручной прогон-зонд по образцу
  `doc/.probe-call.py` (уточнить, на какой RURI слать INVITE и как станция форкает).
- 8.5 `case_5` пароли: корректные (123/321) → успех; заведомо неверный → 401/403 и
  остаёмся UNREGISTERED (регресс BUG-1 из task2 — без ложного REGISTERED).
- 8.6 Кейс «не-ответ»: вызов на незарегистрированный номер → фиксация 180 и финального
  480/408/таймаута в отчёте.
- Каждый кейс — функция `(pool, journal) → verdict`; один и тот же раннер у терминала, API и vitest.
- **Критерий:** `npm run test:e2e` — все кейсы зелёные на живой АТС; отчёты видны на странице.

### 9. Тесты API endpoints (треб. 10–11: кейс на каждый endpoint, файл на категорию)
- 9.1 `tests/api/files.test.ts` — tree содержит dotfiles и игнорит `node_modules`;
  content: 200/400/403/404/413/415.
- 9.2 `subscribers.test.ts`, `calls.test.ts` (мок `sip_pool` через DI — без сети),
  `reports.test.ts` (temp-каталог отчётов), `health/test_runs` — в своих файлах.
- **Критерий:** `npm run test:api` зелёный без доступа к АТС.

### 10. Документация (треб. 12)
- 10.1 `doc/api.md` (или `doc/api/<category>.md` на категорию): на каждый endpoint — метод, путь,
  параметры/тела, коды ответов, пример `curl` + пример ответа.
- 10.2 `README.md` (запуск, `.env`, команды терминала, тесты), `doc/arch.md` (as-is +
  инварианты task2: один WS-клиент = один SIP-UA, один активный вызов, код `server/sip/`
  Node-совместим).
- **Критерий:** число задокументированных endpoints == число маршрутов `routes.ts`.

## Ключевые переиспользуемые куски

| Откуда | Что | Правки |
|---|---|---|
| `task2/bridge/*` | SIP UDP/TCP поверх sip.js, Digest, rport, viaHost=адрес сокета | только пути/имена (snake_case) |
| `task2/src/{state,sipClient,transport,sipText}.ts` | стейт-машина, клиент, контракт Transport | убрать ws/wss-ветки |
| `task2/vite.config.ts:18-70` | buildTree + file-content middleware | dotfiles включить, остальное 1-в-1 |
| `task2/bridge/main.ts` | WS-сервер моста + heartbeat | адрес/порт из `.env` |
| `task2/tools/{smoke.ts,live-atc.mjs}` | паттерн e2e-раннера (until/sleep, PASS/FAIL/SKIP) | креды/номера из `.env` |
| `doc/.probe-call.py` | эталон взаимодействия с живой АТС (180→CANCEL, 200→ACK+BYE) | основа прогона case_4 |

## Verification (сквозная приёмка)

1. `npm run build` — типы без ошибок.
2. `npm run test:unit` и `npm run test:api` — зелёные без сети.
3. `cp .env.example .env` (реальные номера/пароли) → `npm start`; в терминале сервера:
   `help`, `status`, `test 1` — отчёт открывается на `http://<host>:3000/reports/…`.
4. `npm run test:e2e` на живой АТС: кейсы 1–5 + «не-ответ» зелёные; в HTML-отчёте case_2 —
   полные цепочки этапов (регистрация, INVITE, 180, 200, ACK, BYE).
5. Браузер: страница показывает дерево со `.claude/`, `.env` и прочими скрытыми; клик по файлу —
   содержимое; вкладка отчётов открывает прогоны.
6. `curl -sX POST localhost:3000/api/test_runs -d '{"case":1}' -H 'content-type: application/json'`
   → id прогона; `GET /api/test_runs/:id` → результат+журнал в JSON.

## Риски / оговорки

- Поведение станции (challenge без nonce-quirks, форкинг цепочки 9404→3203→52) выясняется
  прогоном-зондом по образцу `doc/.probe-call.py` **до** фиксации assert-ов case_4.
- Мост и UA сервера должны быть достижимы из сети станции (реальный IP вида
  192.168.80.159, не 127.0.0.1 — грабля из `task2/CLAUDE.md`); проверяется первой регистрацией.
- Реальные номера/пароли пользователь впишет в `.env` (в коде — только чтение конфига).
