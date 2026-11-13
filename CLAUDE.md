# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Что это

Node+TS сервер SIP-автотестов с веб-интерфейсом (Express, rails-style API): SIP-протокол
перенесён 1-в-1 из `task2/` (машина sip.js поверх классического UDP/TCP), работает против
**живой АТС** `PBX_HOST:PBX_PORT` из `.env` (образец — `192.168.80.157:5060`). Asterisk для
сервера запрещён (тестовая АТС в `task2/pbx/` — только для разработки кода). **Медиа нет
никогда**: SDP-заглушка `m=audio 9` + `a=inactive`; кодек согласуется — иначе АТС отвечает `488`.

Стиль: `snake_case` (файлы, переменные, функции), комментарии/доки на русском (как в `task2/`).
`task2/` — только источник кода для переноса, не редактируется.

## Команды

| Команда | Действие |
|---|---|
| `npm start` | сервер: конфиг → express → мост → терминал (`server/main.ts`) |
| `npx tsx bridge_main.ts` | WS-мост отдельно (`BRIDGE_HOST:BRIDGE_PORT` из `.env`) |
| `npm run build` | `tsc --noEmit` (единственная проверка типов) |
| `npm run test:unit` | юнит-тесты vitest (`tests/unit/`) |
| `npm run test:api` | API-тесты supertest (`tests/api/`, без сети) |
| `npm run test:e2e` | E2E-кейсы против живой АТС (`tests/e2e/`) |
| `SIP_DEBUG=1 …` | отладочный лог SIP-транспорта |

## Где что находится

- `server/config.ts` — **единая точка чтения `.env`**: валидация, `AppConfig`, `SubscriberConfig`
  (абонент 3, 3203 — только цель вызова, НЕ регистрируется).
- `server/sip/` — перенесённый SIP-код (plan_2.md §2): `state.ts` (стейт-машина — лист),
  `transport.ts` (контракт), `sip_client.ts` (SipPhoneClient, не знает про sip.js),
  `sip_ua_transport.ts` (машина UserAgent sip.js + SDP-заглушка), `classic_transport.ts`
  (сборка UA поверх сокета), `sip_node_transport.ts` (UDP/TCP-сокет, rport),
  `session.ts`+`protocol.ts` (контракт моста v:1), `config.ts` (`PhoneConfig`), `sip_text.ts`, `debug.ts`.
- `server/journal.ts` — журнал SIP-событий и генерация отчётов `reports/<UTC-ts>_<case>.{json,md,html}`
  (наблюдатели: стейт-машина, транспорт, сырые сообщения сокета через `on_trace` у транспорта).
- `server/app.ts` — фабрика express-приложения `create_app({config, pool, ...})` (DI:
  api-тесты п.9 поднимают с моком пула без listen); `server/routes.ts` — карта
  всех `/api`-маршрутов (rails-style, п.5.4); `server/controllers/` — контроллеры
  по категориям (files/reports/subscribers/calls/health/test_runs — test_runs
  исполняет прогоны очередью через общий `run_case`, журнал прогона в `GET /:id`);
  `server/middleware/` — `request_logger`, `error_handler`
  (PoolError→HTTP по полю `status`, JSON `{error}`, 404, `async_handler`).
- `server/terminal.ts` — REPL-терминал сервера (п.7):
  `test <1..5|noanswer|caller|batch24reg|batch24unreg|t1..t8|all>`,
  `status`, `help`, `quit` (graceful через `shutdown()` в main.ts); поверх
  общего пула/журнала, процессом не владеет.
- `e2e_runner.ts` (корень) — общий раннер e2e-кейсов (п.7/п.8): кейс — функция
  `run(ctx{pool,journal,config,step}) → текст`, реестр `CASES` (case_1…case_5 +
  `noanswer` + `caller` (Calling party number у 52) + `batch24reg`/`batch24unreg`
  (пакетные регистрация и снятие 24..47 общим живущим теневым пулом; снятие —
  второстепенный, только в том же процессе), ассерты — по поведению
  станции из зонда `doc/.probe_e2e8.ts`);
  `run_case` пишет отчёт и при FAIL. Его же дёргают терминал и `POST /api/test_runs`.
- `server/sip_pool.ts` — пул виртуальных абонентов (п.4): DI-контракт `SipPool` +
  `SipSubscriberPool`; на абонента — стейт-машина + `SipPhoneClient` + транспорт
  (`PoolTransportFactory`, в бою `ClassicTransport`); реестр вызовов
  `call_id → CallRecord` (id — Call-ID из сырого INVITE, до него — `tmp:<номер>-<n>`);
  ошибки — `PoolError(message, sip_code)`.
- `bridge_main.ts` — WS-мост (JSON v:1, heartbeat 30 с, 1 WS-клиент = 1 BridgeSession).
- `doc/plan_2.md` — актуальный план работ (пункты 1–10 с критериями); `doc/plan.md` — предыдущий;
  `doc/plan_4.md` — станция-эмулятор (выполнен); `doc/plan_5.md` — **в работе**:
  диагностика кейса B (`ss_info.c : ss_on_rx_notify()`, event-list/SSW_SRVM)
  по новому дампу `doc/los_mem/act_log.157.log` vs старые логи `doc/los_mem/traces*/`.
- `doc/sip_rfc.md` — протокольная справка (REGISTER §5.10, Digest §5.4, CANCEL §5.9, BYE §5.8,
  коды §7) — ссылаться в комментариях.
- `doc/.probe_pool.ts`, `doc/.probe_e2e8.ts` — прогон-зонды против живой АТС
  (`npx tsx doc/.probe_e2e8.ts`): поведение станции для ассертов п.8 (не-ответ
  = 502, цепочка через 3203, пароль REGISTER не проверяется); не проверяются
  tsc (каталог `doc/` вне `include`), по образцу `doc/.probe-call.py`.
- `doc/task_<n>_plan_2.md` — журналы сессий по пунктам плана (что сделано, отклонения,
  «симптом → причина → решение»): `task_1_plan_2.md` … `task_10_plan_2.md`.
- `doc/api.md` — REST-контракт: каждый маршрут `routes.ts` (метод, параметры/тела,
  коды, curl+пример ответа; п.10); `doc/arch.md` — архитектура as-is + инварианты;
  `README.md` — запуск, `.env`, команды, тесты.
- `task2/` — прежний проект (веб-телефон + мост): источник переноса, справочные тесты/тулзы.
- `tests/unit/` — стейт-машина, конфиг, журнал/отчёты, пул; `tests/e2e/` — по кейсу
  на файл поверх `run_case` (живая АТС, запуск последовательный); `tests/api/` — п.9.

## Ключевые инварианты

1. Слой `server/sip/` — лист без зависимостей от express/браузера; единственный
   источник состояния — `PhoneSnapshot` (UI/мост/журнал — чистые функции от него).
2. Один WS-клиент моста = один SIP-UA; один активный вызов, второй входящий → `486`.
3. Итог регистрации брать только из финального ответа станции (регресс BUG-1 из task2).
4. `npm run build` и `npm run test:unit`/`test:api` обязаны быть зелёными всегда;
   e2e требуют живой АТС.

## Грабли (проверены на стенде)

- Мост/UA должны быть достижимы из сети станции: реальный IP вида `192.168.80.159`,
  не `127.0.0.1` (через docker-АТС localhost не маршрутизируется).
- `rport` в Via обязателен (иначе REGISTER с эфемерного порта теряется) — дописан в `sip_node_transport.ts`.
- Via sent-by без порта (SanityCheck sip.js); эфемерный порт — только в Contact.
- Contact user = номер абонента, иначе классическая АТС отвечает 401/403 на INVITE.

## Порядок работы по плану

- **Перед реализацией новой функции (сверх плана или новый запрос пользователя)
  план работ — фиксировать: согласованный план записывать в
  `doc/task_<номер задачи>_plan_2.md`** (раздел «План»): топология/контракты/
  эндпоинты/файлы/тесты/критерии. Файл задачи — единый носитель и плана, и
  результата (см. ниже); в сессии план хранится в `~/.claude/plans/*.md`,
  но рабочая копия обязана быть в `doc/`.
- Пункты выполняются строго по `doc/plan_2.md` с проверкой критериев пункта.
- **После выполнения каждого пункта плана записывать результат в
  `doc/task_<номер задачи>_plan_<номер плана>.md`** в корне проекта: выполненный пункт,
  что сделано/изменено, результат проверки критериев, отклонения с обоснованием после каждого выполненого этапа плана.
- Туда-же записывается краткая документация по праделанной работе для будующий сессий
- Ход сессий и вскрытые дефекты — в `doc/task_2_plan_2.md` («симптом → причина → решение»).

## Текущий статус

- п.1 (каркас, конфиг), п.2 (перенос SIP-кода), п.3 (журнал и отчёты),
  п.4 (пул абонентов `server/sip_pool.ts` + реестр вызовов, критерий проверен
  на живой АТС: регистрация 9404 + идемпотентность),
  п.5 (express: `app.ts`+`routes.ts`+контроллеры+middleware, wire-up пула в
  `main.ts`; критерий зелёный: tree со скрытыми, traversal 403, регистрация
  9404 через HTTP на живой АТС + идемпотентность),
  п.6 (страница `public/index.html` — vanilla JS: дерево файлов со скрытыми +
  просмотр содержимого, панель отчётов (iframe `/reports/<id>.html`),
  статус-строка health+АТС; критерий зелёный: `GET /` отдаёт страницу, дерево
  содержит `.claude`/`.env`, content dotfile 200, отчёт открывается),
  п.7 (терминал `server/terminal.ts` + общий раннер `e2e_runner.ts` с кейсом_1;
  критерий зелёный на живой АТС: `test 1` → PASS-отчёт REGISTER → 200
  (станция не-challenge, см. отклонение в журнале), `quit` graceful),
  п.8 (кейсы case_1…case_5+`noanswer` в `CASES` по поведению станции из
  зонда `doc/.probe_e2e8.ts`; `tests/e2e/` — 6/6 зелёные на живой АТС;
  `POST /api/test_runs` 202+очередь, `GET /api/test_runs/:id` — вердикты+журнал;
  отчёты на странице; не-ответ на стенде = 502 без 180, пароль REGISTER
  станцией не проверяется — условная ветка case_5) — выполнены
  (см. `doc/task_2_plan_2.md`, `doc/task_3_plan_2.md`, `doc/task_4_plan_2.md`,
  `doc/task_5_plan_2.md`, `doc/task_6_plan_2.md`, `doc/task_7_plan_2.md`,
  `doc/task_8_plan_2.md`).
- п.9 (api-тесты supertest `tests/api/` — файл на категорию + `helpers.ts`
  с моком `SipPool` через DI и temp-каталогами; критерий зелёный без АТС:
  `npm run test:api` 44/44, `npm test` 90/90; коды 200/201/202/400/403/404/
  409/413/415/502 зафиксированы тестами) — выполнен
  (см. `doc/task_9_plan_2.md`).
- п.10 (документация: `doc/api.md` — 16 endpoints 1:1 с картой `routes.ts`
  (метод/тела/коды/curl+примеры ответов), `README.md` (запуск, `.env`,
  команды, тесты), `doc/arch.md` (as-is + инварианты task2); критерий
  зелёный: 16 == 16 задокументированных маршрутов, `npm run build` и
  `npm test` 90/90 без изменений кода) — выполнен
  (см. `doc/task_10_plan_2.md`). План `doc/plan_2.md` (п.1–10) выполнен
  полностью.
- Сверх плана (запрос пользователя, см. `doc/task_11_plan_2.md`): удаление
  отчётов — `DELETE /api/reports/:id` (снимает триаду .json/.md/.html) и
  `DELETE /api/reports` (очистка каталога); на странице чекбоксы выбора +
  кнопки «удалить выбранные (N)» / «удалить все» с confirm. Карта
  endpoints — 18 (см. `doc/api.md`).
- Сверх плана (запрос пользователя, см. `doc/task_12_plan_2.md`): исправление
  ошибок код-стиля во всём проекте по `.claude/rules/ts_code_style.md` —
  перенесённый слой `server/sip/` переведён на snake_case (крюк транспорта
  переименован в `on_trace`), именованные стрелочные → объявления функций,
  runtime-проверки вместо `!`-утверждений; внешние контракты (JSON v:1 моста,
  опции/колбэки sip.js) не переименованы.
- Сверх плана (запрос пользователя, см. `doc/task_13_plan_2.md`): дополнение
  свода стиля `.claude/rules/ts_code_style.md` — новый раздел
  «Форматирование блоков кода» по образцу `doc/primer.md`: лимит строки 90
  символов, отступ 4 пробела, `{`/`}` составного блока с новых строк, `else`
  с новой строки, перенос параметров по одному с выравниванием по первому,
  однооператорное тело допустимо без `{ }` (прежняя всегда-скобочная норма
  смягчена по образцу); разделы свода перенумерованы (Политики → §9); код
  проекта под новый формат пока не переформатирован.
- Сверх плана (запрос пользователя, см. `doc/task_14_plan_2.md`):
  переформатирование всего кода проекта под §2 свода — Prettier
  (`prettier` + `prettier-plugin-brace-style`, конфиг `.prettierrc.json`:
  allman/90/4/single) + ручные переносы комментариев и длинных литералов;
  скрипты `npm run format` / `format:check`; отступ-хвосты и строки >90
  устранены, сборка и тесты зелёные. Расхождение: перенос параметров —
  висячим отступом Prettier, не выравниванием по первому (см. журнал).
- Сверх плана (запрос пользователя, см. `doc/task_16_plan_2.md`): вкладка
  «Тесты» на странице — список кейсов из нового `GET /api/test_runs` (реестр
  CASES, единый источник истины) + запуск `POST /api/test_runs` с опросом
  `GET /:id` (вердикты PASS/FAIL, журнал прогона, ссылки на отчёты;
  «запустить все» — кейс `all`). Карта endpoints — 19 (см. `doc/api.md`).
- Сверх плана (запрос пользователя, см. `doc/task_15_plan_2.md`): правило
  комментирования `.claude/rules/comment_style.md` — свод фактических
  конвенций проекта (заголовок файла `//`-блоком с `related:` вместо
  `@fileoverview`, JSDoc экспортов, `@param` только значимым, «грабли» с
  «иначе …», «стенд», маркеры `BUG-N`, баннеры секций, русские `it(...)`/
  `ctx.step`); дополняет §8 `ts_code_style.md`, код не изменялся.
- Сверх плана (запрос пользователя, см. `doc/task_17_plan_2.md`): подсветка
  синтаксиса в просмотре файлов страницы — мини-лексер в `public/index.html`
  (vanilla JS, без CDN): `.ts` (комментарии/строки/ключевые/числа/вызовы),
  `.json` (ключи/строки/числа/literals), `.md` (заголовки/жирный/курсив/код/
  ссылки/списки/цитаты/fences); токены — span'ы через DOM-API (без innerHTML),
  остальные расширения — plain text; сервер не менялся.
- Сверх плана (запрос пользователя, см. `doc/task_18_plan_2.md`): e2e-файл
  `tests/e2e/batch_24_47_reg_unreg.test.ts` — два зависимых теста на общем пуле
  (синтетический AppConfig, абоненты 24..47, пароль SIP_PASS_1): первый
  регистрирует весь диапазон (REGISTER → 200 у каждого, регистрации остаются
  живыми), второй снимает их (REGISTER expires=0 → 200; снятие обязано идти
  тем же пулом — binding станции привязана к Contact транспорта); вердикт+отчёт
  по образцу `run_case`, `afterAll` снимает «вислое» при FAIL; критерий зелёный
  на живой АТС (2/2, отчёты `batch_reg_24_47`/`batch_unreg_24_47`).
- Сверх плана (запрос пользователя, см. `doc/task_19_plan_2.md`): обработка
  ошибок слушателя в `server/main.ts` — `server.on('error')`: EADDRINUSE
  (порт занят прежним запуском) больше не роняет процесс необработанным
  трейсом (лог `error.md`), а печатает сообщение по-русски и выходит с кодом 1
  после `repl.close()`; прочие коды — тем же путём.
- Сверх плана (запрос пользователя, см. `doc/task_20_plan_2.md`): CLI-пункт
  `test batch24` — кейс `case_8_batch_24_47` в реестре `CASES`
  (`e2e_runner.ts`): регистрация абонентов 24..47 и их снятие одним прогоном
  на теневом пуле (снятие expires=0 обязано идти тем же пулом — binding
  станции привязана к Contact), ассерты REGISTER → 200 / 200 на expires=0 у
  каждого; `CASES` теперь с именованным `CaseDef` и опц. `report_subscribers`
  (шапка отчёта — диапазон). Через `implemented_cases()` пункт доступен и в
  `POST /api/test_runs`, и на вкладке «Тесты»; критерий зелёный на живой АТС
  (PASS, отчёт `20261103T090922Z_case_8_batch_24_47`).
- Сверх плана (запрос пользователя, см. `doc/task_22_plan_2.md`): генератор
  стимулов тестов локализации утечки памяти `pa_sip` (`doc/los_mem/plan_test.md`
  T1–T8) — `npx tsx los_mem_main.ts t1..t8 [флаги]` (сырой SIP поверх dgram/net
  в `server/los_mem/`: SUBSCRIBE/NOTIFY с Digest, битые XML-тела, flood «не от
  транка»; sip.js не используется). Вердикта нет (решение оператора): фазовые
  метки в stdout/CSV `reports/los_<t>_…csv` для сшивки с внешним мониторингом,
  завершение всегда 0 (кроме ошибок сокета/конфига), Ctrl-C — graceful.
  Вскрытое на стенде: станция-As-UAS отклоняет подписки (dialog-info/event-list
  → 489, dialog → 401→Digest→403 без BLF), blf/ss_on_rx_notify достижимы
  только как ответ на её SUBSCRIBE (Register+StationSubscriptions готовы;
  нужен BLF/SSW на номера генератора в конфиге АТС), зонд
  `doc/.probe_losmem_events.ts`.
- Сверх плана (запрос пользователя, см. `doc/task_21_plan_2.md`): разделение
  `batch24` на два кейса: `batch24reg` (основной, `case_8a_batch_reg_24_47` —
  регистрирует 24..47 и оставляет регистрации живыми) и `batch24unreg`
  (второстепенный, `case_8b_batch_unreg_24_47` — снимает их REGISTER
  expires=0). Общий теневой пул живёт между прогонами в модуле раннера
  (`batch_pool`): снятие возможно только тем же транспортом (binding по
  Contact) — снять регистрации прежнего процесса из нового нереализуемо,
  без живого пула кейс честно FAIL с этой причиной (заметка в журнале);
  `quit`/сигналы закрывают пул через `close_batch_pool()` в main.ts.
  Критерий зелёный на живой АТС (`test batch24reg` → PASS, `test
  batch24unreg` → PASS).
- Сверх плана (запрос пользователя, см. `doc/task_23_plan_2.md`): стимулы
  T1–T8 генератора los_mem интегрированы в CLI и веб — короткие версии
  (~1 мин, дефолты «быстрого прогона» без флагов) как кейсы `t1..t8` общего
  реестра `CASES`: терминал `test t1..t8`, вкладка «Тесты»,
  `POST /api/test_runs {"case":"t1".."t8"}`; полная длительность и флаги —
  по-прежнему standalone-CLI `los_mem_main.ts`. Общие модули: CSV-журнал
  фаз вынесен в `server/los_mem/csv_log.ts`, дефолты флагов —
  `BASE_SCENARIO_OPTS` в `server/los_mem/scenarios.ts`. Стимулы вне `all`
  (`CaseDef.in_all: false`, `cases_for_all()` в терминале и контроллере):
  долгие, t5 — flood станции. Вердикта стимулу нет (то же решение оператора,
  что в task_22): PASS = «стимул сгенерирован», сводка+CSV
  `reports/los_<t>_….csv` в вердикте, фазы — событиями `los-*` в журнале
  отчёта. Критерий зелёный: build, unit 65 / api 51, `t6` зелёным прошёл
  через веб (POST/вердикт/отчёт) и терминал, `t1` — через веб на живой АТС
  (90 NOTIFY; станция молчит со времён task_22 — честно в сводке).
- План `doc/plan_4.md` п.1–6 (см. `doc/task_24_plan_2.md`): эмулятор
  телефонной станции — SIP-UAS `server/station/station.ts` (DI-контракт
  `Station` + `SipStation`, UDP/TCP из `STATION_HOST/PORT/PROTO` в `.env`):
  OPTIONS (keep-alive) → 200 с Allow/Allow-Events/User-Agent из дампов
  pa_sip, прочее → 405 Allow: OPTIONS, мусор — игнор со счётчиком; ничего
  не отправляет сама. API `GET /api/station`, `POST /start|/stop`
  (409 по состоянию, 502 bind с подсказкой setcap), `GET /events?limit=`
  (newest first, ring-buffer ~200); монтируется только при станции в DI;
  блок `station` в `/api/health`; вкладка «Станция» на странице (кнопки,
  статус/счётчики, журнал, опрос 2 с). Автозапуска нет, `stop()` в
  `shutdown()`. Карта endpoints — 23 (см. `doc/api.md`); критерий зелёный:
  build, unit 75 / api 59 (всего 134), зонд `doc/.probe_station_ka.ts`
  (200/405/игнор на UDP+TCP).
- Сверх плана (диагностика, см. `doc/task_25_plan_2.md`): почему от станции
  `.157` не доходят сообщения на `.159:5060` — keep-alive станции шлётся на
  Contact последней регистрации каждого абонента транка (эфемерные порты,
  burst в `doc/res_term.md`), а не на 5060; осиротевшие binding-и батча
  24..47 после смерти процессов остановили опрос (штатный интервал ~21 с).
  Путь `.157→.159:5060/tcp` проверен открытым (nc с станции + наш LISTEN).
  Зонды: `doc/.probe_station_ka_live.ts`, `doc/.probe_keepalive_capture.ts`.
- Сверх плана (запрос пользователя, см. `doc/task_26_plan_2.md`): стимулы
  T1–T8 утечки памяти (запись `doc/task_22_plan_2.md`) прогоном ВНУТРИ нашей
  станции — `server/station/stimulus.ts` (`StationStimulus`/
  `StationStimulusApi`): UDP-клиенты поверх сокета станции (:5060,
  `RawSipClient` + внешний `udp_socket` + `feed()`), Via/Contact =
  `station_host` (keep-alive пира возвращается на станцию и отвечается
  мимикрией; SUBSCRIBE пира забирает пассивный UAS движка через
  `set_incoming_hook`, двойных ответов нет), короткий прогон ~1 мин
  (`LOS_QUICK_OPTS` вынесены в `scenarios.ts`), CSV `reports/los_<t>_….csv`.
  REST 24–26: `GET/POST /api/station/stimulus`, `POST …/stimulus/stop`
  (202/400/409; `POST /api/station/stop` и `shutdown()` гасят прогон раньше
  снятия слушателя); вкладка «Станция» — блок «Стимулы T1–T8». Карта
  endpoints — 26 (см. `doc/api.md`); критерий зелёный: build, unit 81 / api
  67 (всего 148); приёмка t1..t8 на живой АТС через веб (стенд .157 отвечает
  активно: REGISTER 200, SUBSCRIBE 401→403/489 — BLF-пути по-прежнему
  требуют BLF/SSW на номера генератора в конфиге АТС, task_22).
- План `doc/plan_5.md` п.1–4 выполнен, п.5 (приёмка) ждёт стенда
  (см. `doc/task_27_plan_2.md`): вскрыта точная цепочка кейса B — вход в
  `ss_info.c : ss_on_rx_notify()` только как в ПРИНЯТУЮ UAC-подписку станции
  (`sub_on_rx_notify_uac`, дамп №2: 90/90 NOTIFY → 500 «Unknown method» +
  fail2ban на .159); правки — пассивный UAS подписок в самой станции
  (`SipStation`: SUBSCRIBE event-list/dialog-info/dialog/presence/blf → 200
  с Contact/To-tag сразу и вне прогонов, диалоги в `subscriptions()`,
  монотонный `take_notify_cseq`), event-list NOTIFY строго в R-URI=Contact
  принятой подписки (`send_notify`/`StationSubscriptions`+DI
  `ctx.station_subs`), сырой журнал NOTIFY (ring-лог вкладки + CSV kind
  `notify`), честный `answered` только по своим Call-ID (`out_call_ids`,
  t8 не суммирует ×3); зонд `doc/.probe_case_b.ts` (`--self` зелёный;
  боевой ждёт живую SSW-подписку .157 — внешний блокер: SSW на номера
  генератора в конфиге АТС + снятие бана); критерий п.4d: build/unit 89/
  api 67 зелёные.
- План `doc/plan_6.md` п.1–4 выполнен, п.5 (приёмка) ждёт свежего дампа
  (см. `doc/task_28_plan_2.md`): SAS-режим — наш сервер как SAS/SSW-сервер
  станции (контракт `11.log`): SAS-флаг `SipStation` (её port-register
  REGISTER → 200 с эхом Contact/Expires, SUBSCRIBE ЛЮБОГО Event → 200, имя
  пакета — в журнал; вне режима регрессия 405), движок `server/station/sas.ts`
  (первый NOTIFY немедленно + периодические 30 с строго в диалог принятой
  подписки через сокет станции, хук только для ответов на свои NOTIFY, тело
  SSInfo = услуги 10.log + триггеры кейса B 33/137); дамп приёмки `12.log`:
  NOTIFY → 400 (нет `Subscription-State` — pjsip-evsub отсекает до
  `ss_on_rx_notify`, «подтверждение» = корректный NOTIFY в окне
  UAC_WAIT_NOTIFY 5 с) → хелпер `subscription_state_value` (raw_sip.ts) +
  заголовок во все построители NOTIFY, `expires_at` в диалоге подписки;
  Content-Type SSInfo — `application/ss-info+xml` (`SSINFO_CONTENT_TYPE`,
  указание стороны АТС); REST 27–29 `GET/POST /api/station/sas*` +
  `…/enable|/disable` (409: станция стоит / стимул идёт / уже вкл-выкл),
  вкладка «Станция» — блок «SAS-режим (SSW)», карта endpoints — 29
  (см. `doc/api.md`); критерий: build/unit 97/api 74 зелёные.
- Сверх плана (запрос пользователя, см. `doc/task_29_plan_2.md`): режим
  станции «не отвечать на вызовы (INVITE)» — переключаемый флаг
  `SipStation` (`silent_invite_mode`/`set_silent_invite`, живёт между
  stop/start): INVITE от нижестоящей станции остаётся без ответа вовсе
  (тишина вместо 405, в журнале `code: 0`), OPTIONS/REGISTER и прочее
  отвечаются как раньше. REST 30: `POST /api/station/silent_invite {"on"}`
  (200 с полным статусом, 400 — `on` не boolean, 409 нет), на вкладке
  «Станция» — галочка «не отвечать на вызовы (INVITE)». Карта endpoints — 30
  (см. `doc/api.md`); критерий: build/unit 99/api 76 зелёные.
- Сверх плана (запрос пользователя, см. `doc/task_30_plan_2.md`): исходящий
  вызов со станции на нижестоящую станцию — движок
  `server/station/outbound.ts` (`StationOutbound`/`StationOutboundApi`):
  полный цикл UAC без sip.js поверх UDP-сокета станции (INVITE c
  `NO_MEDIA_SDP`, Contact user=номер, адресат — `last_downstream_peer()`
  станции [src последнего REGISTER/OPTIONS/SUBSCRIBE пира, поле
  `last_downstream` статуса] или `host:port` из формы; CANCEL тем же
  branch/CSeq, ACK на каждый финал — RFC 3261 §17.1.1, BYE CSeq 2 в Contact
  из 200; транзакционные таймеры T1-пропорциональные, хук входящих на время
  вызова — вызов/стимул/SAS делят сокет и разведены 409, `POST /stop` и
  `shutdown()` гасят вызов `abort()` первым). REST 31–34: `GET/POST
  /api/station/call`, `POST …/call/cancel|hangup` (202/400/409); вкладка
  «Вызов» (форма номера, «позвонить»/«отбой», статус+журнал, опрос 2 с).
  Карта endpoints — 34 (см. `doc/api.md`); критерий: build/unit 106/api 87
  зелёные; приёмка на живой АТС — за стендом.
- Сверх плана (запрос пользователя, см. `doc/task_31_plan_2.md`): вызовы в
  SAS-режиме «от другого адреса» — ретрансляция на нижестоящую станцию.
  Хук входящих `SipStation` — мультикаст (`add_incoming_hook` → дизпоузер,
  «съедено» = любой true): SAS и вызов совместимы в обе стороны (409-
  пересечения сняты, со стимулом — как были). `via_extra` в
  `build_sip_request` (полные строки Via после основного) + `origin` в
  `StationOutbound.dial`: From/домен Call-ID = введённый адрес, второй Via =
  он же, верхний Via/Contact — станция (ответы возвращаются к нам); CANCEL и
  ACK на не-2xx зеркалят Via-стек и branch INVITE, in-dialog ACK/BYE — один
  Via, From origin-домена; без origin байты прежние. `POST
  /api/station/call` — необязательное тело `origin` (400 по `TARGET_RE`),
  `OutboundStatus.origin`; на вкладке «Вызов» — поле «откуда пришёл».
  Карта endpoints — те же 34 (см. `doc/api.md`); критерий: build/unit 111/
  api 89 зелёные; приёмка на живой АТС — за стендом.
- Сверх плана (запрос пользователя, см. `doc/task_32_plan_2.md`): режим
  «перенаправлять INVITE на адрес из INVITE» — переключаемый флаг
  `SipStation` (`forward_invite_mode`/`set_forward_invite`, живёт между
  stop/start, как silent_invite): при включённом постоянный хук движка
  вызова (`StationOutbound.on_invite_forward`) забирает входящий INVITE у
  мимикрии (пиру не уходит ничего, в журнале `code: 0`) и ретранслирует
  dial()'ом на `host:port` из R-URI этого INVITE: callee — user из R-URI,
  caller — user из From, origin — src отправителя (From/второй Via от
  него, контракт task_31). Дедуп retransmit по Call-ID, на занятом движке
  — без набора, адресат = сама станция — без набора (петля), приоритет над
  молчанием на INVITE. REST 35: `POST /api/station/forward_invite {"on"}`
  (200 с полным статусом, 400 — `on` не boolean), на вкладке «Станция» —
  галочка «перенаправлять INVITE на адрес из INVITE». Карта endpoints — 35
  (см. `doc/api.md`); критерий: build/unit 117/api 91 зелёные; приёмка на
  живой АТС — за стендом.
- Сверх плана (запрос пользователя, см. `doc/task_33_plan_2.md`): таблица
  регистраций нижестоящей станции — справочник линий для будущей маршрутизации
  вызовов в SAS-режиме: хранилище в памяти `server/station/registrations.ts`
  (`StationRegistrations`/`RegistrationsApi`; строка = стабильный `id`,
  `identifier` `u00sXXpXX` (уникальный естественный ключ, регистр значим),
  `phone` оператора, `address` host:port прихода REGISTER, `last_seen_at`).
  Автозахват — REGISTER станции в SAS-режиме (`station.attach_registrations` +
  идемпотентный `record()` в REGISTER-ветке: re-REGISTER обновляет адрес/время,
  телефон оператора сохраняет; `expires=0` строку НЕ снимает) и ручные строки.
  REST 36–39 `GET/POST /api/station/registrations`, `POST …/:id/update`,
  `DELETE …/:id` (201/400/404/409; доп. DI `deps.registrations` — без него
  честный 404), на странице новая вкладка «Регистрации» (номер/identifier —
  input'ы с применением по 'change', адрес прихода — текст; опрос 2 с не
  затирает ввод: skip по неизменному JSON + activeElement-guard). Карта
  endpoints — 39 (см. `doc/api.md`); критерий: build/unit 129/api 101
  зелёные; приёмка на живой АТС — за стендом.
- Сверх плана (запрос пользователя, см. `doc/task_34_plan_2.md`):
  перенаправление INVITE по таблице регистраций — переопределён режим
  галочки task_32 (`forward_invite`, endpoint 35 без изменений): входящий
  `INVITE sip:<номер>@…` ищется в таблице регистраций по phone — адресат
  UDP — `address` строки, R-URI — `sip:<identifier>@<наш_ip:порт>`,
  To/Contact — наш IP (From — номер звонящего из таблицы по identifier из
  Contact входящего, fallback — From), src входящего — только второй Via
  (в отличие от task_31 From не становится origin; новые поля dial —
  `ruri`/`to_uri`/`ruri_user`/`origin_via_only`, байты task_30/31 по
  умолчанию не меняются; `StationOutbound.attach_registrations`). Маршрут
  не найден (нет строки / пуст address / таблица не подключена) — INVITE
  не съедается, прежний 405 мимикрии; retransmit/занятый/петля — съедаются
  без набора. Галочка переименована «перенаправлять INVITE по таблице
  регистраций»; карта endpoints — те же 39 (см. `doc/api.md`); критерий:
  build/unit 130/api 101 зелёные; приёмка на живой АТС — за стендом.
- Сверх плана (запрос пользователя, см. `doc/task_35_plan_2.md`): INVITE
  перенаправления (режим forward_invite) собирается байт-в-байт по образцу
  `pimer.md` (адрес .186 → наш): `R-URI = sip:<identifier>@<адресат:порт>`
  (не на наш IP, как в task_34), ОДИН Via с портом в sent-by (src на проводе
  не виден, в статусе остаётся), `Max-Forwards: 69`, `;user=phone` в From,
  Contact после To, `Allow` образца; тело — полный SDP-образец (PCMA/PCMU/101,
  sendrecv, RTP-порт формальный); User-Agent Coral и P-Coral-Info не
  мимикрируются, display-name опускается. Прямой dial (вкладка «Вызов») —
  байты task_30/31 без изменений (`DialInit.coral_style` ставит только
  on_invite_forward); критерий: build/unit 130/api 101 зелёные; приёмка на
  живой АТС — за стендом.
- Сверх плана (запрос пользователя, см. `doc/task_36_plan_2.md`): режим
  станции «игнорировать Trying/Ringing после перенаправленного INVITE» —
  переключаемый флаг `SipStation` (`ignore_provisional`/
  `set_ignore_provisional`, живёт между stop/start, как silent/forward): при
  включённом движок вызова не замечает 100/180 на INVITE, поднятый
  перенаправлением (`DialInit.forwarded`/`OutCall.forwarded`) — без перехода
  в `ringing`, без счётчиков `answered`/`last_code`; ответ лишь потребляется
  хуком (в `ignored` не попадает) и помечается в журнале «игнорирован».
  Прямой набор и финалы (2xx/3xx+, прочие 1xx) не затронуты. REST 40: `POST
  /api/station/ignore_provisional {"on"}` (200 с полным статусом, 400 — `on`
  не boolean), на вкладке «Станция» — галочка «игнорировать Trying/Ringing
  после перенаправленного INVITE». Карта endpoints — 40 (см. `doc/api.md`);
  критерий: build/unit 134/api 103 зелёные; приёмка на живой АТС — за
  стендом.
- Сверх плана (запрос пользователя, см. `doc/task_37_plan_2.md`): режим
  станции «умножать перенаправляемый INVITE ×10» — переключаемый флаг
  `SipStation` (`multiply_invite`/`set_multiply_invite`, живёт между
  stop/start, как silent/forward/ignore): при включённом перенаправление
  (task_34/35) ретранслирует входящий INVITE десятью копиями разом — в один
  synchronous-проход хука: главный dial + девять «теневых» диалогов
  (пересобраны `build_call`: свои Call-ID/branch/From-tag, байты — образец
  pimer.md, адресат один — из таблицы регистраций). Копии самозаверша-
  ются: не-2xx финал → ACK той же веткой + снятие, 2xx → ACK + немедлен-
  ный BYE (линию не держат), retransmit с удвоением как у главного;
  «отбой»/abort накрывают копии; хук движка держится, пока жива хоть одна
  копия (`maybe_release_hook`); отправки копий не раздувают `sent`
  главного (`multiplied_active` — живые копии в статусе вызова);
  `ignore_provisional` действует и на копии. REST 41: `POST
  /api/station/multiply_invite {"on"}` (200 с полным статусом, 400 — `on`
  не boolean), на вкладке «Станция» — галочка «умножать перенаправляемый
  INVITE ×10». Карта endpoints — 41 (см. `doc/api.md`); критерий: build/
  unit 145/api 105 зелёные; приёмка на живой АТС — за стендом.


файл doc/plan_3.md не трогать(не читать, не писать, не изменять)