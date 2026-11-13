# План 4: эмулятор телефонной станции — ответы на keep-alive (фаза 1)

## Context

Нужна собственная «телефонная станция», слушающая SIP на `192.168.80.159:5060`
(эта машина), которой можно управлять с веб-страницы проекта. Первое умение —
отвечать на keep-alive. Из логов `doc/los_mem` (Eltex SMG / адаптер `pa_sip`,
`mod_pa_pjsip.c`) поведение станции зафиксировано: keep-alive — это входящий
**SIP OPTIONS**, станция отвечает `200 OK` и добавляет заголовки `Allow` и
`Allow-Events` (`keep_alive_reply: cause = 200`); трасса UDP; у пира
(`traces (Prime)/pbx_pstn.1.log`) период ~21 с. Из трассы взято значение:
`Allow: INVITE, ACK, BYE, CANCEL, PRACK, REGISTER, INFO, REFER, NOTIFY, OPTIONS,
SUBSCRIBE, MESSAGE, UPDATE, PUBLISH`.

Принятые решения: станция **только UAS** (ничего сама не шлёт); прочие методы
→ **405 Method Not Allowed**; слушатель поднимается **только кнопкой** со
вкладки (без автозапуска).

## Объём

- SIP-UAS на UDP **и** TCP (адрес/порт из `.env`, по умолчанию
  `192.168.80.159:5060`): `OPTIONS` → `200` как у `pa_sip`; остальные методы →
  `405` (`Allow: OPTIONS`); мусор/не-SIP — игнор с счётчиком.
- Новая вкладка «Станция»: запуск/останов, статус, счётчики, журнал обращений.
- REST-ресурс `/api/station` (4 endpoint-а) по шаблонам проекта.
- Регистрация абонентов/вызовы — **вне объёма** (следующие фазы).

## Реализация

### 1. `server/station/station.ts` — сервис-листок (без express)

- DI-контракт `Station` (статус/счётчики/`start()`/`stop()`) + класс
  `SipStation implements Station` — по образцу `SipPool`/`SipSubscriberPool`
  (`server/sip_pool.ts`): api-тесты подставляют мок.
- Переиспользование `server/los_mem/raw_sip.ts` (в его комментариях парсер прямо
  готовился «для пассивного UAS»): `parse_sip_request_head()` — разбор запроса,
  `build_sip_response()` — 200/405 (копирует Via/From/Call-ID/CSeq, дописывает
  To-tag; передать свой `to_tag`, например `station`). UDP-ответ — на
  `rinfo` (src-порт пира, «rport»-семантика).
- UDP: `dgram`-сокет на `station_host:station_port` (по образцу
  `RawUdpResponder.listen()`, `raw_sip.ts:579`). TCP: `net.createServer`,
  фрейминг по `Content-Length` — тем же алгоритмом, что `feed_tcp()`
  (`raw_sip.ts:539`, его не экспортируют → ~20 строк локально, ссылка в
  комментарии), ответ в то же соединение.
- Ответ на OPTIONS — `extra_headers` в `build_sip_response`:
  `Allow:` — список из трассы (см. Context), `Allow-Events:` — точное значение
  зафиксировать при реализации grep'ом сырых дампов `Allow-Events:`/`Server:`
  по `doc/los_mem` (в summary-логах значение не видно; если не найдётся —
  `dialog, refer` с комментарием «значение-заглушка, уточнить по pcap»),
  `Server:`/`User-Agent:` — мимикрия под станцию (те же источники),
  `Content-Length: 0` (уже в билдере).
- Состояние сервиса: `stopped | running`, ошибки `start()` (EACCES/EADDRINUSE
  с сообщением по-русски), счётчики (`requests_in` по методам, `answered` по
  кодам, множество пиров, `last_keepalive_at`), ring-buffer журнала
  (последние ~200: ISO-ts, peer, proto, метод, R-URI, CSeq, Call-ID, код
  ответа). Обработчик не бросает: ошибка сокета → статус `stopped` + текст
  ошибки (сервер express не роняем).

### 2. Конфиг — `server/config.ts`, `.env.example`

Необязательные поля с дефолтами (существующие unit/api-тесты с синтетическим
env не ломаются): `station_host` (по умолчанию `192.168.80.159`, валидация
`HOST_RE`), `station_port` (`5060`, `as_port`), `station_proto`
(`udp|tcp|both`, по умолчанию `both`).

### 3. API — `server/controllers/station_controller.ts`, `server/routes.ts`, `server/app.ts`, `server/main.ts`

- `GET  /api/station` — `{state, host, port, proto, uptime_s, counters,
  last_keepalive_at, error}`;
- `POST /api/station/start` — 200 `{state:'running', ...}`; 409 — уже
  запущена; 502 + текст — bind не удался (порт 5060 привилегированный:
  нужен root или `setcap cap_net_bind_service`; в сообщении — подсказка);
- `POST /api/station/stop` — 200; 409 — остановлена;
- `GET  /api/station/events?limit=` — журнал обращений (newest first).
- `AppDeps`/`RouteDeps` — опциональный `station?: Station`; router
  монтируется только при его наличии (паттерн `build_api_router`).
  `main.ts`: `new SipStation(config)` в wire-up (не стартует), `stop()` в
  `shutdown()`; кодирование 200/409/502 — в контроллере (по образцу
  `test_runs_controller.ts`, `error_handler` не расширяем).
- `health_controller.ts` — опциональный аргумент `station`: блок `station:
  {state, host, port}` в `/api/health` (плюс пилюля на статус-строке).

### 4. Вкладка «Станция» — `public/index.html`

- `nav` — кнопка `data-pane="station"`; `section.pane.station`: слева
  `side-head` с кнопками «запустить»/«остановить» + блок статуса (пилюля
  state, адрес:порт/протокол, uptime, счётчики OPTIONS, последний keep-alive),
  справа viewer — журнал (`pre.events`, формат строк как `render_events`).
- JS-панель по образцу «Тесты»: `load_station()` (GET статуса + событий),
  опрос раз в 2 с, пока вкладка активна (останов таймера при уходе с pane —
  в обработчике `nav button`, там же обновление при входе); `confirm` на
  останов работающей станции; кнопки блокируются по `state`.
- Заголовок-комментарий страницы и README — обновить описание панелей.

### 5. Стиль и документация (конвенции проекта)

- Всё по `.claude/rules/ts_code_style.md` §2 (Allman, 4 пробела, 90 симв.) и
  `.claude/rules/comment_style.md` (`//`-заголовок файла с `related:`, JSDoc
  экспортов, русские комментарии-«почему», `it(...)` по-русски).
- `doc/api.md` — 4 новых endpoint-а (карта: 19 → 23), `README.md` — про станцию
  и привилегии порта; журнал сессии `doc/task_24_plan_2.md` (что сделано,
  «симптом → причина → решение», критерий) — по «Порядку работы по плану».

### 6. Тесты

- `tests/unit/station.test.ts` (без внешней сети, loopback, порт 0):
  OPTIONS → `200` c `Allow`/`Allow-Events`, To-tag, копия Via/CSeq; REGISTER →
  `405 Allow: OPTIONS`; мусор → игнор + счётчик; TCP-фрейминг (два сообщения в
  одном чанке); идемпотентность start/stop.
- `tests/api/station.test.ts` (supertest, мок `Station` через DI): коды
  200/409/502/404-путей, форма JSON статуса и событий.
- Зонд `doc/.probe_station_ka.ts` (вне tsc, по образцу `doc/.probe_e2e8.ts`):
  `RawSipClient` → OPTIONS на станцию, печать полного ответа (приёмка формата
  против логов станции).

## Verification

1. `npm run build`, `npm run test:unit`, `npm run test:api` — зелёные.
2. `npm start` → вкладка «Станция»: «запустить» → статус `running`
   (`192.168.80.159:5060`, udp+tcp); `npx tsx doc/.probe_station_ka.ts` —
   `200 OK` с `Allow`/`Allow-Events`; в журнале вкладки — строка OPTIONS;
   REGISTER из зонда → 405 в журнале; «остановить» → OPTIONS больше не
   отвечают, `state: stopped`.
3. Порт: сначала `STATION_PORT=5560` (без привилегий), затем `5060` — с
   `sudo npm start` или `sudo setcap cap_net_bind_service=+ep $(which node)`;
   EADDRINUSE/EACCES наблюдаются честным 502/статусом, сервер жив.
4. (Опционально, на стенде) направить keep-alive реального пира на
   `192.168.80.159:5060` — периодические 200 в журнале, как `keep-alive-rsp`
   в логах `doc/los_mem`.
