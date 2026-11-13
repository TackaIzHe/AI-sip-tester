# Архитектура сервера SIP-автестов (as-is, plan_2.md п.10.2)

Node+TS сервер: express REST API + терминал + отчёты против **живой АТС**
(`PBX_HOST:PBX_PORT` из `.env`). SIP-протокол перенесён 1-в-1 из `task2/`
(машина sip.js поверх классического UDP/TCP). Asterisk для сервера запрещён.
**Медиа нет никогда**: SDP-заглушка `m=audio 9` + `a=inactive`; кодек
согласуется — иначе АТС отвечает `488`.

## As-is: компоненты и поток данных

```
                    ┌────────────────────────── процесс сервера (npm start) ─────────────────────────┐
 браузер ──HTTP──▶  │  public/index.html (страница, п.6: дерево файлов + отчёты + статус)            │
                    │        ▲                                                                        │
 curl/CI ──HTTP──▶  │  app.ts ─ routes.ts ─ controllers/ (files, reports, subscribers,               │
                    │   (json+logger+static)             calls, test_runs, health)                   │
                    │        │                          │                                            │
                    │        │            middleware/: request_logger, error_handler (PoolError→HTTP)│
                    │        ▼                          ▼                                            │
                    │  journal.ts ◀── события   sip_pool.ts (SipPool: DI-контракт +                 │
                    │  (события → отчёты            SipSubscriberPool — боевой)                     │
                    │   reports/*.json|.md|.html)     │  на абонента: PhoneStateMachine +            │
                    │        ▲                        │  SipPhoneClient + Transport                  │
                    │        │ отчёт прогона          ▼                                              │
                    │  e2e_runner.ts  ◀── общий раннер (терминал / POST /api/test_runs / tests/e2e) │
                    │        │                                                                       │
 REPL `sip>` ──▶ terminal.ts┘    server/sip/ (ЛИСТ: state, sip_client, transport,                  │
                                  sip_ua_transport, classic_transport, sip_node_transport,          │
                                  session, protocol, config, sip_text, debug)                      │
                    └───────────────┬────────────────────────────────────────────────────────────────┘
                                    │ классический SIP UDP/TCP (rport в Via, Contact=номер)
                                    ▼
                            живая АТС PBX_HOST:PBX_PORT

 отдельный процесс: bridge_main.ts — WS-мост BRIDGE_HOST:BRIDGE_PORT (JSON v:1,
 heartbeat 30 с, 1 WS-клиент = 1 BridgeSession = 1 SIP-UA) — наследие task2,
 для внешних WS-клиентов; серверные автотесты ходят в АТС напрямую из sip_pool.
```

Слои и зависимости (строго однонаправленные):

- `server/config.ts` — **единая точка чтения `.env`**: валидация, `AppConfig`,
  `SubscriberConfig` (абонент 3, образец 3203 — только цель вызова, НЕ
  регистрируется: `can_register: false`).
- `server/sip/` — перенесённый из task2 SIP-код, **лист без зависимостей от
  express/браузера**: `state.ts` (стейт-машина — единственный источник
  состояния `PhoneSnapshot`), `sip_client.ts` (`SipPhoneClient`, не знает про
  sip.js), `sip_ua_transport.ts` (машина UserAgent sip.js + SDP-заглушка),
  `classic_transport.ts` (сборка UA поверх сокета), `sip_node_transport.ts`
  (UDP/TCP-сокет, rport), `session.ts`+`protocol.ts` (контракт моста v:1),
  `config.ts`, `sip_text.ts`, `debug.ts`.
- `server/sip_pool.ts` — виртуальные абоненты: DI-контракт `SipPool` + боевой
  `SipSubscriberPool`; на абонента — стейт-машина + клиент + транспорт
  (фабрика `PoolTransportFactory`, в тестах — мок без сети); реестр вызовов
  `call_id → CallRecord` (до выхода INVITE id — `tmp:<номер>-<n>`); ошибки —
  `PoolError(message, code, status)`.
- `server/journal.ts` — чистый наблюдатель: снапшоты стейт-машины
  (`attach_phone`), вехи транспорта (`attach_transport`), сырые сообщения
  сокета (`on_sip_message` через hook `on_trace`); `render_report()` — три
  файла `reports/<UTC-ts>_<case>.{json,md,html}`.
- `server/app.ts` + `routes.ts` + `controllers/` + `middleware/` — rails-style
  HTTP: фабрика `create_app({config, pool, journal, …})` (DI: api-тесты
  поднимают с моком пула без listen), карта всех `/api`-маршрутов в одном
  месте, контроллеры — тонкие обёртки (источник истины — пул), error-handler
  конвертирует `PoolError.status` → HTTP `{error}` (+`sip_code`).
- `server/terminal.ts` — REPL поверх общего пула/журнала (`test`, `status`,
  `help`, `quit`), процессом не владеет (graceful через `shutdown()` в `main.ts`).
- `e2e_runner.ts` (корень) — единый раннер кейсов 1–5 + `noanswer` (ассерты —
  по поведению станции из зонда `doc/.probe_e2e8.ts`); его же дёргают
  терминал, `POST /api/test_runs` и `tests/e2e/`.
- `public/index.html` — страница (vanilla JS, без сборки): дерево файлов со
  скрытыми + просмотр, панель отчётов (iframe `/reports/<id>.html`),
  статус-строка health+АТС.

## Инварианты (унаследованы из task2, соблюдены)

1. `server/sip/` — лист: не знает про express/браузер; единственное состояние —
   `PhoneSnapshot`; UI/мост/журнал — чистые функции от него.
2. **Один WS-клиент моста = один SIP-UA** (`bridge_main.ts`: 1 соединение →
   1 `BridgeSession`); **один активный вызов** на абонента, второй входящий →
   `486 Busy Here` (стейт-машина + логика task2-сессий).
3. Итог регистрации берётся **только из финального ответа станции**
   (регресс BUG-1 из task2 — без ложного REGISTERED; см. case_5).
4. Код `server/sip/` **Node-совместим** (работает в процессe сервера без
   браузерных API: транспорт — `node:net/dgram`, не WebSocket браузера).
5. Абонент 3 (3203) не регистрируется никогда — только цель вызова
   (прокси-цепочка 9404→3203→52).

## Грабли стенда (проверены, зафиксированы в коде)

- Мост/UA должны быть достижимы из сети станции: реальный IP вида
  `192.168.80.159`, не `127.0.0.1`.
- `rport` в Via обязателен (иначе REGISTER с эфемерного порта теряется) —
  дописан в `sip_node_transport.ts`.
- Via sent-by без порта (SanityCheck sip.js); эфемерный порт — только в Contact.
- Contact user = номер абонента, иначе АТС отвечает 401/403 на INVITE.
- Стенд REGISTER **не чалленджит** (REGISTER → 200 без Digest) и не-ответ
  даёт `100 → 502` без 180 — ассерты кейсов условны по этим веткам
  (`doc/.probe_e2e8.ts`, журналы `doc/task_7_plan_2.md`, `doc/task_8_plan_2.md`).

related: `doc/api.md` (REST-контракт), `doc/plan_2.md` (план), `README.md` (запуск),
`doc/task_*_plan_2.md` (журналы сессий), `task2/` (источник переноса).
