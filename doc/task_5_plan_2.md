# Отчёт: пункт 5 «Express: приложение, контроллеры, маршруты» (plan_2.md §5)

Дата выполнения: 2026-10-27. Статус: **выполнен, критерий приёмки зелёный**
(+ перепроверен через HTTP отложенный критерий п.4 — регистрация 9404 на живой АТС).

## Что сделано

### 5.1 Приложение — `server/app.ts` (`create_app`)

Фабрика express-приложения с DI `{config, pool, files_root?, reports_dir?, public_dir?}`:
`express.json()` → `request_logger` → `/api`-роутер → статика `/reports` →
каталог отчётов создаётся при старте (`mkdirSync`, иначе первый `express.static`
дал бы ENOENT до первого отчёта) → статика `/` → `public/` (появится в п.6) →
`not_found_handler` (404 тоже JSON `{error}`) → `error_handler` — последним.

Middleware (`server/middleware/`):
- `request_logger.ts` — строка `METHOD path → код (мс)` по событию `finish`
  (виден итоговый код и после error_handler);
- `error_handler.ts` — финальный обработчик: `PoolError` → `err.status`
  (+`sip_code` в теле, если станция ответила кодом), `SyntaxError` битого JSON
  от `express.json()` → 400, прочее → 500 `{error: message}` без стек-трейса;
  здесь же `async_handler` — обёртка async-хендлеров (express 4 не ловит reject);
  `not_found_handler` — 404 неизвестных маршрутов.

### 5.2 `controllers/files_controller.ts` — порт task2/vite.config.ts:18-70

- `build_tree`: **dotfiles не фильтруются** (убран `startsWith('.')`) — правка
  по плану; в игноре только `node_modules`, `.git` (список task2 урезан —
  `dist`/`certs` теперь легальны); сортировка «каталоги первыми, затем имя» 1-в-1;
- `GET /api/files/tree` — дерево `files_root` (в бою cwd);
- `GET /api/files/content?path=` — коды как в плане: 400 без `path`,
  403 traversal (`resolve`+префикс корня), 404 не-файл/нет, 413 > 1 МБ,
  415 бинарные (NUL в первых 8 КБ), иначе 200 `{content}`.

### 5.3 Контроллеры поверх пула/диска

- `reports_controller.ts` — по файлам `reports/`: `GET /` — список `*.json`
  (id, пути к json/md/html, размер; обратная лексика = хронология благодаря
  UTC-метке в имени), `GET /:id` — распарсенный JSON отчёта; id фильтруется regex
  `[A-Za-z0-9._-]` (в путь файла не попадают ни `../`, ни абсолют);
- `subscribers_controller.ts` — `GET /` = `pool.list_subscribers()`;
  `POST|DELETE /:number/register` = `register_subscriber`/`unregister`
  (идемпотентность — внутри пула);
- `calls_controller.ts` — `GET /` = `list_calls()`; `POST / {from,to}` → 201 +
  запись; `GET /:id`; `POST /:id/answer|reject|hangup`: REST адресует **id
  вызова** (Call-ID или tmp-id), а пул — **номер абонента**, контроллер
  раскрывает `id → запись → owner`; `reject` принимает `{code}` 400–699;
- `health_controller.ts` — `GET /api/health`: статус, uptime, адрес/протокол
  АТС, мост, абоненты; пула не трогает (health не должен зависать на SIP);
- `test_runs_controller.ts` — маршруты и контракт тела по п.5.4, исполнение —
  п.8 (см. отклонение 4).

### 5.4 `routes.ts` — карта маршрутов

`build_api_router({config, pool, files_root, reports_dir})` монтирует
контроллеры по категориям; список маршрутов дословно из плана (все 16),
заголовок файла — карточка карты для п.10 (`doc/api.md`).

### Wire-up `server/main.ts`

`конфиг → Journal → SipSubscriberPool → create_app → listen SERVER_PORT`;
SIGINT/SIGTERM: `pool.close()` (unregister всех) → `server.close()`.
REPL — TODO п.7 (подключится к этому же пулу). WS-мост остаётся отдельным
процессом `bridge_main.ts` (см. отклонение 5).

## Результат проверки критериев (п.5)

| Проверка | Результат |
|---|---|
| `npm run build` | ✅ без ошибок |
| `npm run test:unit` | ✅ 46/46 (было 45; +1 тест HTTP-статусов PoolError) |
| сервер стартует (`npm start`) | ✅ `[sip-atc] HTTP :3000; АТС 192.168.80.157:5060 (udp)` |
| `/api/files/tree` содержит `.claude/`, `.env` | ✅ оба в корневых именах дерева |
| `…/content?path=../../etc/passwd` → 403 | ✅ `403 {"error":"forbidden"}` |
| content: 400/404(не-файл)/404(нет) | ✅ curl |
| `/api/health`, `/api/subscribers`, `/api/calls`, `/api/reports` | ✅ 200, ожидаемые JSON |
| ошибки пула → HTTP: без регистрации 409, 3203 403, неизвестный 404 | ✅ curl |
| битый JSON → 400; неизвестный маршрут → 404 JSON | ✅ curl |
| **п.4 через HTTP**: `POST /api/subscribers/9404/register` | ✅ 200 за 25 мс (живая АТС) |
| повторный register идемпотентен | ✅ 200 за 0 мс, REGISTERED в `/api/subscribers` |
| `DELETE …/9404/register` | ✅ 200 (expires=0) |

## Отклонения от плана (обоснованные)

1. **`server/app.ts` вне списка целевой структуры**: приложение вынесено в
   фабрику `create_app` с DI. Причина: api-тесты п.9 (supertest) обязаны
   поднимать приложение с моком `SipPool` без `listen` и без сети — синглтон
   в `main.ts` это запретил бы. `main.ts` остался бутстрапом (wire-up).
2. **`PoolError` расширен полем `status` (HTTP)** и он проставлен в 11 местах
   броска `server/sip_pool.ts` (403/404/409/502/400; `code` остался SIP-кодом).
   Альтернатива «разбор текста сообщения в error_handler» отброшена — хрупко.
   Юнит-тест фиксирует статусы; contract `SipPool` не менялся, тесты п.4 зелёные.
3. **Content: несуществующий файл → 404** (в task2 `statSync` падал в 500).
   План формулирует «404 не-файл»; различимый код нужен и странице (п.6),
   и api-тестам (п.9). Остальные коды 1-в-1 task2.
4. **`POST /api/test_runs` отвечает 501**: маршрут и валидация `{case}` — из
   п.5.4, но исполнение требует `e2e_runner.ts` (п.8). Честная заглушка вместо
   фиктивного «успеха»; `GET /api/test_runs/:id` — 404. П.8 наполнит их,
   не меняя контракт.
5. **Мост не поднимается из `main.ts`**: plan_2.md §структура держит
   `bridge_main.ts` отдельным процессом (`npx tsx bridge_main.ts`); бутстрап
   п.5 — только express+пул. Фраза CLAUDE.md «npm start: … → мост → терминал»
   будет приведена в соответствие в п.7 (терминал) — либо мост станет частью
   пайплайна осознанным решением.
6. **Добавлен JSON-404 для неизвестных маршрутов** (`not_found_handler`) —
   в плане не назван, но без него `/api/опечатка` возвращал бы html-страницу
   express, ломая контракт «ответ API — JSON».

## Созданные/изменённые файлы

```
to/
  server/app.ts                          (новый: фабрика create_app)
  server/routes.ts                       (новый: карта /api-маршрутов)
  server/middleware/request_logger.ts    (новый)
  server/middleware/error_handler.ts     (новый: PoolError→HTTP, 404, async_handler)
  server/controllers/files_controller.ts (новый: порт buildTree/content, dotfiles вкл.)
  server/controllers/reports_controller.ts
  server/controllers/subscribers_controller.ts
  server/controllers/calls_controller.ts
  server/controllers/health_controller.ts
  server/controllers/test_runs_controller.ts (заглушка до п.8)
  server/sip_pool.ts                     (PoolError.status + простановка по броскам)
  server/main.ts                         (wire-up: конфиг→журнал→пул→express+graceful)
  tests/unit/sip_pool.test.ts            (+1 кейс статусов PoolError)
  doc/task_5_plan_2.md                   (этот отчёт)
  CLAUDE.md                              (статус)
```

## Краткая справка для следующих сессий (п.6–10)

- П.6: страница работает с `/api/files/tree|content`, `/api/reports`
  (`html` из списка — прямая ссылка `/reports/<id>.html`), `/api/health`.
  `public/` ещё нет — статика уже смонтирована, положите `index.html`.
- П.7: брать `pool` из `main.ts` (wire-up готов); `status` =
  `pool.list_subscribers()` + `list_calls().filter(ended_at===0)`;
  `quit` = `await pool.close()` (graceful в main.ts уже есть — REPL-`quit`
  может дёргать тот же путь).
- П.8: `POST /api/test_runs` — заменить 501 на создание прогона
  (хранилище id→{verdict, report_id}), раннер общий с терминалом;
  отчёты уже лежат в `reports/` — контроллер их подхватит без правок.
- П.9: мок — объект `SipPool` + `create_app({config: фейковый, pool: мок,
  files_root: temp, reports_dir: temp})`; коды 400/403/404/409/413/415 зафиксированы.
- П.10: карта маршрутов — шапка `server/routes.ts`;endpoint-ы 16 шт.

## Симптом → причина → решение (вскрыто на этом этапе)

- *`pkill -f 'tsx server/main.ts'` убивал саму команду проверки* — шаблон
  попадал в argv оболочки-носителя; останавливать `SIGTERM` по pid или по
  внешнему скрипту.
- *Запись вызова в ответе POST /api/calls ещё в `PENDING`* — это ожидаемо:
  страница/тесты
  долистывают `GET /api/calls/:id` (Call-ID приходит из сырого INVITE
  асинхронно, п.4.2).

## Следующий шаг

Пункт 6 плана — страница `public/index.html`: дерево файлов со скрытыми,
просмотр содержимого, вкладка отчётов, статус-строка из `/api/health`.
