# task_31 — вызовы в SAS-режиме «от другого адреса» (ретрансляция на нижестоящую станцию)

## Запрос

Добавить возможность делать вызовы в режиме SAS: «типа они идут от другого
адреса и мы их ретранслируем на ниже стоящую станцию»; для адреса, откуда
пришёл вызов, — поле ввода на странице.

Согласовано с пользователем:
- **ретрансляция на уровне SIP-заголовков** (реальный IP-источник пакетов
  не меняется: у машины один адрес `192.168.80.159` в сети стенда, raw-
  спуфинг без root и без возврата ответов бесполезен). INVITE на
  нижестоящую станцию собирается так, «будто станция получила его» с
  введённого адреса и ретранслирует: `From: <sip:номер@введённый-адрес>`,
  ВТОРАЯ строка Via = введённый адрес; верхний Via и Contact — наша станция
  (ответы 1xx/2xx и диалог возвращаются к нам, полный цикл ACK/CANCEL/BYE
  работает);
- **SAS и вызов совместимы в обе стороны**: звонок при включённом SAS и
  включение SAS при активном вызове (снять 409 в обоих направлениях);
  стимулы T1–T8 остаются взаимоисключающими с обоими (flood ломает
  транзакции).

## План

### 1. `server/station/station.ts` — хук-мультиплексор

SAS-хук (`sas.ts` ест ВСЕ ответы) и хук вызова (`outbound.ts` тоже ест все
ответы) при одном слоте `set_incoming_hook` голодали бы друг друга в
зависимости от порядка навешивания. Один слот → мультикаст:

- поле `incoming_hook` → `incoming_hooks: IncomingHook[]`;
- `set_incoming_hook` → `add_incoming_hook(hook): () => void` (дизпоузер
  снимает только свой хук; `remove_incoming_hook(hook)` не нужен — ссылка
  уже есть у добавляющего, замыкание надёжнее);
- диспетч `handle_request`: вызывать ВСЕ хуки (снимок массива — хук вправе
  отписаться во время вызова, BYE-ветка outbound именно так и делает),
  «съедено» = хоть один вернул true; `push_event(code 0)` — один раз;
- contract `IncomingHook` не меняется (синхронный, не бросает).

### 2. `server/los_mem/raw_sip.ts` — `via_extra`

`SipRequestOptions.via_extra?: string[]` — дополнительные строки `Via: …`
(ПОЛНЫЕ строки заголовка, как `extra_headers`), вставляются в
`build_sip_request` сразу после основного Via, до `Max-Forwards`. Полная
строка обязательна: `build_sip_response` копирует эхом строки по `^via:` —
значение без имени заголовка в эхо не попадёт.

### 3. `server/station/outbound.ts` — `origin`

- `StationOutboundApi.dial` и `dial`: необязательное `init.origin` —
  `'host[:порт]'` (порт по умолчанию 5060, парсинг `uri_host_port`);
- `OutCall`: `origin?: {host, port}` + единый `from_uri`
  (`sip:номер@origin_host[:порт]` при origin — переиспользуется всеми
  запросами диалога);
- INVITE при origin: From = origin-домен; `via_extra` — Via введённого
  адреса (порт явный, branch `z9hG4bK-ob-relay-…`); домен Call-ID =
  origin.host; Contact и верхний Via — станция;
- CANCEL и ACK на не-2xx — ЗЕРКАЛО Via-стека INVITE и тот же верхний branch
  (RFC 3261 §9.1/§17.1.1); ACK на 2xx и BYE (в диалоге) — ОДИН Via (наш),
  From из origin-домена (matching диалога: Request-URI/To/From);
- `OutboundStatus.origin: string` (`'host:port'`, '' — прямой вызов);
- без origin сообщения байт-в-байт прежние.

### 4. `server/controllers/station_controller.ts`

- `POST /api/station/call` — необязательное тело `origin` (валидация
  `TARGET_RE` → 400 «origin — «host» или «host:порт»»), проброс в `dial`;
- снять 409 «SAS-режим включён» на `/call` и 409 «Исходящий вызов активен»
  на `/sas/enable` (мультикаст-хук снял общий ресурс); конфликты со
  стимулом — как были;
- порядок `POST /stop` (вызов → стимул → SAS) не меняется.

### 5. `public/index.html` — поле ввода

Вкладка «Вызов»: инпут `call-origin` («адрес, откуда „пришёл“ вызов,
host:port») рядом с `call-caller`/`call-target`; `call_dial()` шлёт `origin`
при непустом поле; `render_call_status` показывает origin; в SAS-блоке
вкладки «Станция» — подсказка, что вызов теперь доступен и в режиме SAS.

### 6. Тесты

- `tests/unit/los_mem_raw.test.ts` — порядок `via_extra` (после основного
  Via), регрессия «без поля — один Via»;
- `tests/unit/station.test.ts` — перевод хук-кейсов на `add_incoming_hook`
  + кейс мультикаста (оба хука вызываются, consumed=любой true, code 0 в
  журнале один раз, дизпоузер снимает только свой);
- `tests/unit/station_outbound.test.ts` — origin: INVITE (From-домен, два
  Via по порядку), CANCEL/не-2xx-ACK (зеркало стека, верхний branch),
  2xx-ACK/BYE (один Via, From origin), `status().origin`; SAS+вызов бок о
  бок (хук SAS не глушит ответы INVITE и наоборот);
- `tests/api/station_outbound.test.ts` — мок `origin` в `status()`/
  `dial_calls`; origin 202/400; снятые 409 (SAS on → `/call` 202; `/sas/
  enable` при активном вызове 200; стимул по-прежнему 409 с обоими).

### 7. Документация

`doc/api.md` — §28/§32 (тексты 409, поле `origin`, пример); `CLAUDE.md` —
буллет «Сверх плана … task_31». Маршрутов не добавляется — карта 34.

### Риски/доводка (заранее)

- нижестоящая станция может не принять INVITE с двумя Via (strict-routing) —
  доводка по обратной связи стенда, как с challenge в шапке outbound.ts;
  запасной вариант — only-From (решение пользователя зафиксировано на
  «ретрансляцию», менять только по факту отказа);
- SAS-NOTIFY во время вызова идут тем же сокетом — нагрузки нет (интервал
  30 с), ответы разводит диспетч-мультикаст.

## Ход работы

### 1. Хук-мультиплексор (`server/station/station.ts`) — выполнено

`incoming_hook` → `incoming_hooks: IncomingHook[]`; `set_incoming_hook` →
`add_incoming_hook(hook): () => void` (дизпоузер снимает хук по идентичности,
повторный вызов идемпотентен). Диспетч `handle_request` вызывает все хуки по
снимку массива (`[...this.incoming_hooks]` — BYE-ветка outbound отписывается
прямо во время итерации), `eaten` — хоть один true, `push_event(code 0)` один
раз. Потребители переведены: `sas.ts` (поле `off_hook`, enable/disable),
`outbound.ts` (dial/finish), `stimulus.ts` (start/cleanup); логика «что ем» в
движках не менялась. Зонд `doc/.probe_case_b.ts` — на дизпоузер.

### 2. `via_extra` (`server/los_mem/raw_sip.ts`) — выполнено

`SipRequestOptions.via_extra?: string[]` — полные строки `Via: …`,
вставляются в `build_sip_request` после основного Via, до `Max-Forwards`
(строка без имени заголовка не вернулась бы эхом в `build_sip_response`).

### 3. `origin` в движке вызова (`server/station/outbound.ts`) — выполнено

`dial` принимает `init.origin` (`uri_host_port`, порт по умолчанию 5060;
битый порт — Error, хост без порта проходит — форма за контроллером).
`OutCall.origin` + единый `from_uri`; INVITE: From/домен Call-ID — origin,
`via_extra` — Via origin-адреса (`branch=z9hG4bK-ob-relay-…`), Contact и
верхний Via — станция. CANCEL/ACK на не-2xx — то же `via_extra` и верхний
branch (зеркало стека); ACK на 2xx и BYE — один Via, From origin-домена;
retransmit INVITE — байт-в-байт из `call.raw`. `OutboundStatus.origin`.
Без origin байты сообщений прежние (тест-регрессия в los_mem_raw).

### 4. Контроллер — выполнено

`POST /api/station/call` — поле тела `origin` (тот же `TARGET_RE` → 400),
проброс в `dial`. Сняты 409 «SAS-режим включён» на `/call` и «Исходящий
вызов активен» на `/sas/enable`; конфликты со стимулом сохранены; порядок
`POST /stop` не менялся.

### 5. Страница — выполнено

Вкладка «Вызов»: инпут `call-origin` («откуда пришёл», host:порт),
`call_dial()` шлёт непустой `origin`, `render_call_status` показывает
`номер@origin` в строке вызова; в SAS-блоке вкладки «Станция» — подсказка о
доступности вызова в режиме SAS.

### 6. Тесты — выполнено

- `los_mem_raw.test.ts`: `via_extra` — порядок строк Via до Max-Forwards +
  байт-регрессия без поля (branch фиксируется — он рандомный в сборке);
- `station.test.ts`: хук-кейсы на `add_incoming_hook`/дизпоузер + кейс
  мультикаста (оба хука видят запрос и ответ, code 0 в журнале один раз,
  частичная отписка);
- `station_outbound.test.ts`: origin-describe — INVITE (From/Call-ID от
  origin, два Via по порядку, статус origin; битый порт — throw), не-2xx ACK
  (2 Via, branch INVITE), 2xx-ACK/BYE (1 Via, From origin) с включённым ДО
  звонка SAS (state `answered`, SAS `on` пережил цикл);
- `tests/api/station_outbound.test.ts`: мок `origin`, кейсы 202/400, SAS on
  → `/call` 202, `/sas/enable` при активном вызове 200, стимул — 409 как
  был.

Критерий: `npm run build` зелёный, `test:unit` 111/111, `test:api` 89/89,
`format:check` чистый.

### 7. Документация — выполнено

`doc/api.md` — §28 (совместимость с вызовом), §31 (`origin` в примере и
расшифровке), §32 (тело/семантика ретрансляции, 409 без SAS); шапка
раздела «Исходящий вызов»; карта маршрутов — те же 34. `CLAUDE.md` —
буллет «Текущий статус».

### Замечания (симптом → причина → решение)

- `expect(() => dial({origin:'bad host!'})).toThrow` не срабатывал →
  `uri_host_port` принимает любой хост без двоеточия («bad host!» — хост),
  бросает только битый порт; валидация формы — забота контроллера
  (`TARGET_RE`), в юните бросок проверяется на `h:abc`;
- байт-регрессия `build_sip_request` падала → branch генерируется случайно
  на каждый вызов, в сравнении двух сборок его фиксируют опцией `branch`.

### Приёмка (за стендом)

Стенд: старт станции → SAS on (пир шлёт SUBSCRIBE, NOTIFY идут) → вкладка
«Вызов»: номер + origin-адрес → «позвонить»: в `GET /api/station/events` —
INVITE с From/вторым Via введённого адреса, SAS-NOTIFY продолжаются во
время вызова, отбой CANCEL/BYE штатный. Риск из плана (INVITE с двумя Via у
нижестоящей станции) — доводится по факту отказа.
