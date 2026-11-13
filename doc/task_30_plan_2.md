# task_30 — исходящий INVITE на нижестоящую станцию + вкладка «Вызов» (сверх плана, запрос пользователя)

## Запрос

Добавить функционал отправки INVITE на нижестоящую станцию с номером из
формы ввода; для удобства — отдельная вкладка на веб-интерфейсе.

Согласовано с пользователем:
- топология — «со станции на адрес пира»: наша станция-эмулятор выступает
  вышестоящей, INVITE уходит с её UDP-сокета :5060 на адрес нижестоящей
  станции (пира, обращающегося к нам: keep-alive OPTIONS, port-register
  REGISTER в SAS-режиме, SUBSCRIBE); адрес — откуда пир последний раз
  обращался, с переопределением `host:port` в форме;
- полный цикл вызова: INVITE → ответы (1xx/2xx/4xx-6xx), ACK на 200, отбой
  кнопкой (CANCEL до финального ответа / BYE после 200).

## План

### 1. `server/station/outbound.ts` (новый движок)

`StationOutbound implements StationOutboundApi` (DI-контракт по образцу
`StationSasApi`): `status()`, `dial({callee, caller?, target?})`, `cancel()`,
`hangup()`, `abort()`; ошибки — `Error` с русским текстом → контроллер в 409.
Конструктор `(config, station: SipStation)` — как у StationSas.

- Состояния: `idle | calling | ringing | answered | cancelling | terminating`;
  ring-лог (newest first) + `sent`/`answered{code}`/`last_code`/`last_reason`/
  `error`; статус отдаёт `callee/caller/target/call_id`.
- Диалог UAC: свой `from_tag`; `to_tag` и remote-target из 2xx
  (`parse_sip_response.to_tag`/`contact_uri`, фолбэк — src target); `branch`
  INVITE генерить и передавать явно — CANCEL обязан тем же branch и тем же
  номером CSeq (`1 CANCEL`); ACK — `1 ACK` с To-tag; BYE — `2 BYE`.
- INVITE: `build_sip_request('INVITE', …)` — R-URI `sip:<callee>@<target>`,
  From `sip:<caller>@<station_host>`, Contact `sip:<caller>@<host>:<port>`
  (user=номер — грабля классической АТС, CLAUDE.md), Via `via_host`, тело
  `NO_MEDIA_SDP` (импорт из `server/sip/sip_ua_transport.ts`, медиа никогда),
  User-Agent отдельный (не мимикрия). Отправка — только через
  `station.udp_socket()` (UDP-only, как NOTIFY SAS); нет сокета/не running →
  ошибка (409). caller по умолчанию — `config.subscribers[0].number`.
- Транзакционные таймеры (иначе вызов держит хук вечно): retransmit INVITE
  T1=500 мс удвоением до 64·T1 → `timeout`/idle; CANCEL/BYE — свои T1-таймеры;
  повтор 200 → повтор ACK. Таймеры `unref()`; для юнит-теста таймаута —
  необязательный параметр конструктора (уменьшение T1), prod-значения
  констант не меняются.
- `cancel()` — из calling/ringing шлёт CANCEL, ждёт финал (обычно 487)+ACK;
  гонка с 200 → немедленный BYE. `hangup()` — только из answered (BYE, 200 →
  idle). `abort()` — синхронный сброс для stop/shutdown (таймеры гасятся,
  хук снимается, BYE/CANCEL best-effort).
- Хук входящих на время активного вызова (`set_incoming_hook`, ест: ВСЕ
  ответы — иначе `ignored++`; BYE/ACK активного Call-ID — на BYE отвечает 200
  и рвёт вызов). Запросы (OPTIONS/REGISTER/SUBSCRIBE) → false — мимикрия
  станции живёт во время вызова. Снятие хука — при уходе в idle.

### 2. `server/station/station.ts`

Запись адреса нижестоящей станции: в `handle_request` (штатный путь после
хука, при `parse_sip_request_head`) на методах REGISTER/OPTIONS/SUBSCRIBE
писать `last_downstream = {host, port}` (src rinfo/remote); геттер
`last_downstream_peer()`; поле `last_downstream: string` в `StationStatus`
(плейсхолдер формы). Шапка файла — пункт про новый движок.

### 3. `server/controllers/station_controller.ts` — endpoints 31–34

- `GET  /api/station/call` — статус движка;
- `POST /api/station/call` `{callee, caller?, target?}` → 202+статус;
  400 — callee не `^\+?\d{1,24}$` / bad target; 409 — вызов активен, станция
  stopped, SAS включён, стимул идёт, target не задан и `last_downstream` пуст;
- `POST /api/station/call/cancel` — 200+статус; 409 — не в calling/ringing;
- `POST /api/station/call/hangup` — 200+статус; 409 — не в answered.

Встречные 409: в `POST /stimulus` и `POST /sas/enable` —
`outbound.status().state !== 'idle'`; `POST /stop` — `outbound.abort()` ПЕРВЫМ
(до stimulus/sas). Монтаж при DI `outbound` (404 без него). Счётчик endpoints
30 → 34 (сверить grep'ом).

### 4. Wire-up: `server/routes.ts`, `server/app.ts`, `server/main.ts`

`RouteDeps.outbound?`/`AppDeps.outbound?` (+ строки карты 31–34 в шапке
routes), `station_controller(..., deps.outbound)`; в `main.ts` —
`new StationOutbound(config, station)` в DI и `abort()` в `shutdown()` до
останова станции.

### 5. `public/index.html` — вкладка «Вызов»

`nav`-кнопка `data-pane="call"` + `<section class="pane call">`: слева форма
(номер вызываемого, вызывающий (необяз.), адрес `host:port` с плейсхолдером
из `status.last_downstream`), кнопки «позвонить» / «отбой» (CANCEL/BYE по
state), блок статуса (state, пары callee→target, call-id, последний код) и
`<pre>`-лог. Опрос 2 с только на активной вкладке (по образцу
`set_station_polling`); ошибки POST — в статус-бокс.

### 6. Тесты

- `tests/unit/station_outbound.test.ts` (реальная `SipStation` на :0 +
  пир-сокет dgram, образец `station_sas.test.ts`): INVITE (R-URI/Contact
  user=caller/SDP/CSeq/branch) → 180 → 200(+To-tag/Contact) → ACK → BYE →
  idle и снятие хука (ответ-мусор снова в `ignored`); CANCEL → 487 → ACK;
  486 без отбоя → idle+last_code; OPTIONS пира во время вызова отвечается;
  `last_downstream` пишется REGISTER/OPTIONS; dial без target и без
  last_downstream / на остановленной — ошибка; таймаут retransmit
  (урезанный T1) → timeout+хук снят.
- `tests/api/station_outbound.test.ts` (по образцу `station_sas.test.ts`:
  `MockOutbound implements StationOutboundApi` + мок станции; в
  `tests/api/helpers.ts` в `make_api_app` добавить `outbound?`): 404 без DI;
  400 на мусорное тело; все 409-пересечения; 202/200 успех.

### 7. Документация

- `doc/api.md` — endpoints 31–34 в секции «Станция», поле `last_downstream`
  в примере статуса;
- `CLAUDE.md` — буллет «Сверх плана … task_30» со статусом и картой 34.

### Риски/отклонения (заранее)

- Вызов ↔ SAS ↔ стимул взаимоисключающи (общие UDP-сокет и хук) — 409 в обе
  стороны;
- TCP-транспорт INVITE не поддерживается (UDP-only, как NOTIFY);
- Challenge (401/407) на INVITE не обрабатываем: фиксируем код, завершаем
  вызов — доводка по обратной связи стенда;
- `silent_invite` (входящие) на движок не влияет.

## Ход работы

### п.1 `server/station/outbound.ts` — выполнен

- `StationOutbound implements StationOutboundApi` (status/dial/cancel/hangup/
  abort), конструктор `(config, station, t1_ms = 500)` — третий параметр для
  юнит-теста таймаута; состояния, ring-лог и счётчики — по плану.
- Реализовано по плану: явный branch INVITE (`z9hG4bK-ob-…`, переиспользуется
  CANCEL и ACK на не-2xx), To-tag/Contact-адресат из 2xx (фолбэк — target),
  `NO_MEDIA_SDP`, Contact user = caller, UDP-only через `station.udp_socket()`,
  таймеры с `unref()`, хук входящих на время вызова (ест ответы и BYE/ACK
  своего диалога, запросы — мимо).
- Отклонения от плана (оба — уточнения при реализации):
  - порог retransmit/таймаута сделан геттером `t1_max_ms = 64·t1_ms` вместо
    модульной константы: при урезанном тестовом T1 транзакция обязана
    укладываться пропорционально (в бою T1=500 → те же 32 с); иначе тест
    таймаута шёл бы десятки секунд;
  - ACK на финальный не-2xx отправляется ВСЕГДА (RFC 3261 §17.1.1), а не
    только после CANCEL: без ACK станция ретранслирует финал (486/487) до
    64·T1, а дубли без хука падали бы в `ignored`.

### п.2 `server/station/station.ts` — выполнен

`last_downstream` пишется в `handle_request` на REGISTER/OPTIONS/SUBSCRIBE
(INVITE — нет: src INVITE не адрес сигнализации пира), геттер
`last_downstream_peer()`, поле `last_downstream: 'host:port'` в
`StationStatus` (обновили три api-мока станции).

### п.3 Контроллер, endpoints 31–34 — выполнены

`station_controller(station, stimulus?, sas?, outbound?)`; 30 — статус, 31–34 —
`GET/POST /call`, `POST /call/cancel|hangup` (202/200, 400 — форма
номера/адреса, 409 — состояния движка/станции и пересечения). Встречные 409 в
`POST /stimulus` и `POST /sas/enable`; `POST /stop` — `outbound.abort()` ПЕРВЫМ.
Grep `router.(get|post|delete)` — 34 == карта `doc/api.md` (критерий).

### п.4 Wire-up — выполнен

`RouteDeps.outbound?`/`AppDeps.outbound?` (+ карта 31–34 в шапке routes),
`main.ts` — `new StationOutbound(config, station)` в DI, `abort()` в
`shutdown()` перед стимулом/SAS/станцией; `make_api_app` — `outbound?`.

### п.5 Вкладка «Вызов» — выполнена

`nav`-кнопка `data-pane="call"` + `section.pane.call`: форма (номер/
вызывающий/адрес — placeholder поля «адрес» обновляется из
`status.last_downstream` при опросе), «позвонить»/«отбой» (отбой выбирает
CANCEL/BYE по текущему state), статус-бокс движка, `<pre>`-лог + журнал
полностью в правой панели; опрос 2 с только на активной вкладке
(`set_call_polling`), ошибки POST — alert с текстом сервера.

### п.6 Тесты — выполнены

- `tests/unit/station_outbound.test.ts` — 7 тестов на реальной `SipStation`
  :0 + dgram-пиры (Contact 200 — на ОТДЕЛЬНЫЙ сокет: ACK/BYE уходят в него,
  это проверяет разбор remote из Contact): полный цикл с проверкой тегов/
  CSeq/branch/SDP и снятием хука (мусор снова в `ignored`), CANCEL (branch/
  CSeq, ACK 487 той же веткой), 486 без отбоя (idle+last_code, ACK есть),
  OPTIONS пира во время вызова — 200 мимикрией, BYE от пира → 200+idle,
  last_downstream из REGISTER — адресат dial, таймаут на T1=10 мс
  (`нет ответа`, хук снят).
- `tests/api/station_outbound.test.ts` — 11 тестов на `MockOutbound`: форма
  статуса, 202 успех (trim caller/target), 400 (битые номер/адрес/тело),
  409-пересечения (станция/стимул/SAS — и обратно: стимул/SAS против
  активного вызова), текст ошибок движка в 409, `abort()` в `/stop` первым,
  404 без DI.

### п.7 Документация — выполнена

`doc/api.md`: карта 34, раздел «Исходящий вызов» (31–34, curl+примеры),
`last_downstream` в примере статуса станции; `CLAUDE.md` — буллет статуса.

### Критерии

`npm run build` — зелёный; `npm run format:check` — зелёный;
`npm run test:unit` — 106/106 (было 99, +7); `npm run test:api` — 87/87
(было 76, +11); endpoints grep 34 == задокументированных. Приёмка на живой
АТС (ввод номера → INVITE на адрес пира, отбой) — за стендом.
