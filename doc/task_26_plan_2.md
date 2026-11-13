# Задача 26 — стимулы T1–T8 утечки памяти ВНУТРИ нашей станции

Сессия 2026-11-06 (сверх плана, запрос оператора). Постановка: «станция начала
отправлять OPTIONS — реализовать и проверить работоспособность тестов записи
doc/task_22_plan_2.md (T1–T8 генератора утечки `doc/los_mem/plan_test.md`),
причём тесты должны производиться ОТ нашей импровизированной телефонной
станции». Уточнения оператора (via вопросы): стимул — внутри `SipStation`
(сокет станции = источник трафика); keep-alive приходит на `.159:5060` (наш
эмулятор); приёмка — все t1..t8, короткие прогоны (~1 мин).

## Что сделано

1. **`server/los_mem/raw_sip.ts` — внешний UDP-сокет и «вкорм» извне:**
   - `RawSipClientOptions.udp_socket` — уже связанный сокет станции
     (:5060): `connect()` его усыновляет (без bind/своего слушателя),
     `close()` НЕ закрывает чужой сокет (`external`-флаг);
   - публичный `feed(raw, from)` — доставка datagram из чужого слушателя в
     диспетчер клиента (wait_response/on_message/answered); внутренний
     UDP-слушатель и `feed_tcp()` теперь тоже через него;
   - **дефект-фикс:** `send()` по UDP игнорировал аргументы `host`/`port`
     (200-й ответ на SUBSCRIBE станции ушёл бы на адрес АТС, а не на src-порт
     пира) — добавлены `?? opts.host/port`.
2. **`server/station/station.ts` — хук входящих + отдача сокета:**
   - `set_incoming_hook(IncomingHook)` — делегат ДО разбора/мимикрии:
     `true` — сообщение съедено (дефект-грабль: без делегата SUBSCRIBE
     станции получал бы и 200 от UAS стимула, и 405 от станции);
   - `udp_socket()` — станция отдаёт сокет движку стимула;
   - в журнале станции сообщения, съеденные делегатом, — строка с методом из
     request-line (у ответов — `''`) и `code: 0`.
3. **`server/los_mem/scenarios.ts` — DI транспорта:** `ScenarioCtx.make_client`
   (фабрика клиентов; у новых кейсов/CLI — обычный эфемерный `RawSipClient`,
   поведение прежнее); `LOS_QUICK_OPTS` экспортирован (перенесён из
   `e2e_runner.ts` — единый источник коротких дефолтов ~1 мин).
4. **`server/station/stimulus.ts` — движок `StationStimulus` (контракт
   `StationStimulusApi` {cases,status,start,stop}):** один прогон за раз;
   клиенты — поверх сокета станции (UDP), `via_host = station_host` →
   Via/Contact = `sip:номер@192.168.80.159:5060` (keep-alive пира возвращается
   на станцию — снятие грабля task_25 про эфемерные Contact); хук пьёт
   ответы на свои запросы и SUBSCRIBE станции (её закрывает пассивный UAS
   клиента), OPTIONS пропускает мимикрии; CSV фаз `reports/los_<t>_<UTC>.csv`
   (тот же формат, plan_test.md §2.2); ring-лог; досрочный `stop()` — флаг
   `stopped` (циклы замечают за ≤500 мс, graceful-зачистка). TCP-фолбэк —
   обычный клиент к АТС, честно помечен в логе.
5. **REST/DI (карта endpoints 23 → 26, doc/api.md):**
   `GET /api/station/stimulus` (status+cases), `POST /api/station/stimulus`
   `{id}` (202; 400 — битое тело/неизвестный id; 409 — движок занят/станция
   остановлена), `POST /api/station/stimulus/stop` (200/409);
   `POST /api/station/stop` при активном прогоне сначала ждёт его зачистки,
   потом снимает слушатель; в `main.ts` — тот же порядок в `shutdown()`;
   DI `stimulus?: StationStimulusApi` через `create_app`/`build_api_router`
   (без DI — 404 на /stimulus*).
6. **UI (вкладка «Станция»):** блок «Стимулы T1–T8» — select из `cases`,
   запуск/останов, статус прогона (pill/uptime/итог/ошибка/CSV) и 15 свежих
   фаз; опрос — тем же 2-с циклом вкладки; «запустить» активна только на
   работающей станции.
7. **Тесты:** unit +6 (`tests/unit/los_mem_raw.test.ts` — усыновление сокета/
   feed/src-порт; `tests/unit/station.test.ts` — хук SUBSCRIBE+OPTIONS,
   фолс-хук, shared-сокет), api +8 (`tests/api/station_stimulus.test.ts` —
   коды/форма/порядок стопов/404 без DI). **Критерий зелёный:** `npm run
   build`, `format:check`, `npm test` 148/148 (unit 81, api 67).

## Приёмка на живой АТС (2026-11-06, стенд 192.168.80.157:5060)

Порядок: `npm start` → `POST /api/station/start` (UDP+TCP :5060) → t1..t8
последовательно `POST /api/station/stimulus {"id":"tN"}` + опрос статуса.
Все 8 прогонов — HTTP 202, фазы `stim_start…stim_stop`, сводка, CSV без
ошибок. Сводки (сокращённо, целиком в `reports/los_t*_20261106T11*.csv`):

- **t1** — NOTIFY 90 (variant=all, 1 мин @1.5/с); ответы: `REGISTER 200`,
  `SUBSCRIBE 401→403`, `NOTIFY 500×90`;
- **t2** — NOTIFY 60 (hybrid, 100 props, тело 23224 Б); `SUBSCRIBE 489`,
  `NOTIFY 500×60`;
- **t3** — 1 цикл, SUBSCRIBE×4 (дубли); `REGISTER 200×2`,
  `SUBSCRIBE 401→403 ×2, 489×2`;
- **t4** — OPTIONS 120 → `403×120`; «провайдер-401» (:5061) — 0 входящих
  (транк АТС на нас не настроен);
- **t5** — 360 сообщений «не от транка» (REGISTER/SUBSCRIBE/INVITE с чужих
  портов); `REGISTER 403×342 + 401×18`, `INVITE 403/401/100`,
  `SUBSCRIBE 489×360`;
- **t6** — 1000 IPC-кадров subscribe (type 54), дамп
  `reports/los_t6_ipc_…hex` (IPC-разъём недоступен с этой машины — как в CLI);
- **t7** — шторм доменных RURI 2032 @35/с; `OPTIONS 404×1016`,
  `SUBSCRIBE 404×1016`, `INVITE 403×207`;
- **t8** — soak 1 мин (dialog-info/event-list NOTIFY + чужие REGISTER);
  `NOTIFY 500×273`, `REGISTER 403×165 + 401×15 + 200×3`, подписки
  `401→403/489`.

Живой keep-alive на станции: OPTIONS от пира **192.168.80.133:5060** (телефон
`u00s29p00`) — мимикрия отвечает 200 (`OPTIONS_ANSWER_HEADERS`), после прогонов
счётчик OPTIONS 200-х продолжил расти — хук снят корректно. Пир `.157` тоже
фигурирует в журнале (ответы по delegate-пути `code 0` — их пили клиенты
движка).

## Вскрытое / отклонения

- **Стенд отвечает активно** (в отличие от молчания станции времён task_22):
  REGISTER принимается (200), SUBSCRIBE — `401→Digest→403` (BLF на номера
  генератора 9404/52 в конфиге АТС не настроен — та же граница, что в
  task_22: `blf_on_rx_notify`/`ss_on_rx_notify` достижимы только как ответ на
  её SUBSCRIBE), `dialog-info`/`event-list` → `489`, NOTIFY в чужие диалоги →
  `500/404`. Пути генератора от станции работают, достижение deep-обработчиков
  станции по-прежнему требует BLF/SSW на её стороне (зонд
  `doc/.probe_losmem_events.ts`).
- **Попутно:** вне прогонов SUBSCRIBE от живых пиров станция
  отвечает 405 (штатная мимикрия plan_4), во время прогона их забирает
  движок (UAS клиента отвечает 200) — задокументированное поведение делегата,
  не дефект.
- Двойных ответов на SUBSCRIBE не возникает (делегат раньше мимикрии,
  единственный обработчик); `stop()` станции/`shutdown()` сервера гасят
  прогон раньше снятия слушателя.
- `LOS_QUICK_OPTS` переехал в `scenarios.ts` — `e2e_runner.ts` теперь только
  импортирует (дефолты кейсов `t1..t8` реестра `CASES` не изменились).

## Как пользоваться

`npm start` → вкладка «Станция»: запустить станцию → выбрать стимул →
«запустить» (или `curl -X POST localhost:<SERVER_PORT>/api/station/stimulus
-d '{"id":"t6"}' -H 'Content-Type: application/json'`); полная длительность и
флаги — по-прежнему standalone-CLI `npx tsx los_mem_main.ts t1..t8 [флаги]`.

related: doc/task_22_plan_2.md (генератор), doc/task_23_plan_2.md (CLI/веб
интеграция), doc/task_24_plan_2.md (станция), doc/task_25_plan_2.md (грабли
keep-alive/Contact), doc/api.md (маршруты 24–26).
