# Задача 27 — план 5: кейс B `ss_info.c : ss_on_rx_notify()` (event-list / SSW_SRVM)

Сессия 2026-11-09. План — `doc/plan_5.md` (п.1–5): диагностика «почему станция
не заходит в кейс B» по дампу `doc/los_mem/act_log.157.log` + новому
`doc/los_mem/act_log_2.157.log`, правки генератора/станции, приёмка по
маркерным строкам в свежей трассе.

## п.1. Сверка логов: таблица маркеров

Маркеры гонялись `grep -aI` (регистронезависимо там, где оговорено) по всем
`.log`/`messages` из `doc/los_mem/traces*/**` (500 МБ корпус) и обоим
act-дампам. Файлы без единого совпадения из таблицы опущены.

| файл | ss_on_rx_notify | bad property | ss_info | event-list | Request msg NOTIFY | SSW_SRVM | sub_create_uac |
|---|---|---|---|---|---|---|---|
| traces_max_load/traces/pbx_siperr.log | 9 | 11 | 11 | 0 | 0 | 16 | 102 |
| traces_max_load/traces/pbx_sip.1.log | 11 | 15 | 15 | 0 | 5848 | 173 | 625 |
| traces_max_load/traces/pbx_sip.2.log | 0 | 0 | 0 | 0 | 1728 | 101 | 282 |
| traces_max_load/traces/pbx_sip.3.log | 0 | 0 | 0 | 0 | 2002 | 95 | 375 |
| traces_normal_load/traces(6)/pbx_siperr.log | 4 | 8 | 8 | 0 | 0 | 19 | 19 |
| traces_normal_load/traces(6)/pbx_sip.1.log | 3 | 6 | 6 | 0 | 4398 | 255 | 945 |
| traces_normal_load/traces(6)/pbx_sip.2.log | 1 | 2 | 2 | 0 | 4096 | 265 | 824 |
| traces_normal_load/traces(6)/pbx_sip.3.log | 0 | 0 | 0 | 0 | 836 | 6 | 284 |
| act_log.157.log (дамп №1, 2026-11-06) | 0 | 0 | 0 | 0 | 0 | 136 | 10 |
| act_log_2.157.log (дамп №2, 2026-11-09) | 0 | 0 | 0 | 0 | 180 | 0 | 0 |

Замечания к таблице:

- строка `event-list` не встречается НИ В ОДНОМ логе (ни старом, ни новом) —
  имя пакета в трассы не печатается никогда; ориентир — `SSW_SRVM` (внутренний
  тип подписки SSW) и `Request msg NOTIFY`;
- `pbx_siperr.log` — поток ошибок: маркеры кейса B есть, сырых RX NOTIFY нет
  (в него они и не писались); RX-дайверы — в `pbx_sip.N.log`;
- дамп №2: 180 строк = 90 «Processing incoming message: Request msg NOTIFY»
  + 90 «request from trunk!» — т.е. 90 принятых NOTIFY (наша генерация);
  `ss_info`/`bad property`/`SSW_SRVM` — нули (обработчика на станции не было);
- `sub_create_uac` ×10 в дампе №1 — станции действительно создавала SSW_SRVM
  UAC-подписки (`sub_create_uac: SSW_SRVM sub 0000` и т.д., часы станций
  2025-12-19 18:19 — см. про разнос часов в plan_5).

## Ключевая находка п.1: точная цепочка кейса B (из старых логов)

`traces_max_load/traces/pbx_sip.1.log`, 2026-08-19 10:47:05.772 (за 1 мс до
маркеров):

```
tsx0x…  Incoming Request msg NOTIFY/cseq=2 (rdata0x…) in state Null
mod_pa_subscriptio  sub_on_rx_notify_uac: SSW_SRVM sub 073c rx notify
                    from 'u00s05p22' to 'u00s05p22' CID:InwhjlS7h1nxrMD3…
…PBXIPC-SIP. TX. subscribe-notify  # SUB type <SSW_SRVM> # subref 073c
ss_info.c  ss_on_rx_notify: SSW_SRVM sub 073c bad property list: value …
           (…, len 137, allowed 32)
```

Выводы:

1. обработчик вход в кейс B — `sub_on_rx_notify_uac` (модуль
   `mod_pa_subscriptio`), т.е. NOTIFY arrives как **UAC-подписчику** станции
   (её собственная подписка SSW_SRVM), в её диалоге (Call-ID/теги её
   SUBSCRIBE); from/to одного пользователя (`u00s05p22`→`u00s05p22`) — на
   другом конце trunk-а должен быть notifier от того же абонента trunk-а;
2. триггерные значения — JSON с XML-экранированием кавычек:
   `{&quot;prefix&quot;:&quot;67805&quot;,&quot;media&quot;:&quot;system://sounds/ring/default.wav&quot;,&quot;ring&quot;:&quot;ring03&quot;}`
   — ровно **137 символов** (12×`&quot;` + 65 обычных) при лимите 32; имя
   свойства-триггера len 33 — `replace_category_from_redirection` (+ строка
   `bad property: value … (false, 5, 41)`);
3. в дампе №1 (`act_log.157.log`) SSW UAC-подписки станция создавала
   (`sub_create_uac` ×10), но принятых NOTIFY ноль; в дампе №2 SSW
   подписок нет, приняты только «чужие» NOTIFY → все 500 «Unknown method».

## Вердикты по гипотезам H1–H4 (итог п.1, см. также план 5)

- **H1 (адресат) — переформулирована:** доставка на .157 работает (дамп №2),
  но кейс B требует NOTIFY в Contact/диалоге подписки, созданной СТАНЦИЕЙ;
- **H2 (чужой диалог) — подтверждена как основная:** обработчик
  `ss_on_rx_notify` живёт только в принятой UAC-подписке станции
  (`sub_on_rx_notify_uac`); NOTIFY «мимо» неё → 500 Unknown method (дамп №2,
  90/90);
- **H3 (петля 500) — закрыта:** 500-ки в дампе №2 — реальные ответы станции
  (`Response msg 500/NOTIFY` created + fail2ban BAN suggest .159 ×90);
- **H4 (лог-фильтр) — закрыта:** level 0 пишет RX NOTIFY и обязательно
  печатал бы маркеры (в дампе №2 RX NOTIFY видны).

## п.2. Сырой журнал отправляемых NOTIFY + честные сводки

- `server/los_mem/scenarios.ts`: каждый отправленный NOTIFY — строка
  `notify_log_line` (`NOTIFY → host:port cid=… cseq=… tags=from/to event=…
  ct=… body=NB`); отправку централизует `send_notify` (t1/t2/t8): адресат
  берётся из R-URI самого NOTIFY (Contact принятой подписки, п.4b), НЕ из
  дефолтной цели клиента. Строка идёт в `ctx.log` (ring-лог движка — видно на
  вкладке «Станция») и в `ctx.log_raw` → CSV-журнал прогона (kind `notify`,
  `server/los_mem/csv_log.ts`);
- честность счётчика ответов (вскрытая часть H3 на НАШЕЙ стороне): хук движка
  раздаёт весь UDP-вход всем клиентам прогона, и один ответ станции попадал в
  сводку каждого (t8 суммировал три клиента — ×3). `RawSipClient` теперь
  помнит `out_call_ids` (Call-ID своих отправленных запросов, `send()`), а
  `feed()` засчитывает `answered` только «своему» Call-ID
  (`server/los_mem/raw_sip.ts`);
- сводки t1/t2/t8 — живые диалоги через `active_count()/active_events()`
  (внешний источник — счётчик станции), не внутреннюю копию клиента.

## п.4a/4c. Пассивный UAS подписок на уровне станции

Симптом → причина → решение:

- **Симптом:** SSW-подписка станции живёт только внутри прогона (хук движка),
  вне прогонов — 405 (`Subscription state TERMINATED`); три подписки из
  дампа №1 умерли с `cause 408` (ответ не дошёл за таймеры pjsip);
- **причина:** 200 на SUBSCRIBE выдавал только движок стимула через хук, а не
  сама станция; ответ запаздывал (клиент прогона должен был быть жив);
- **решение (`server/station/station.ts`):** обработчик SUBSCRIBE пакетов
  `event-list/dialog-info/dialog/presence/blf` — в мимикрии станции: 200
  СРАЗУ из `handle_request` (до движка, вне прогонов тоже) с `Contact:`
  станции, эхом `Event`, согласованным `Expires` и стабильным To-тегом
  `stasub-N` (не меняется при refresh); диалог пишется в `subscriptions()`
  (зеркало From/To, `remote` — из Contact запроса, протухание по Expires,
  снятие expires=0), CSeq наших NOTIFY — `take_notify_cseq()` (монотонен);
  прочие события/методы — как раньше (405). Хук движка (`stimulus.ts`)
  SUBSCRIBE больше не перехватывает (двойных 200 нет): наши клиенты в
  внешнем режиме (`StationSubscriptions` с `ctx.station_subs`) своих 200 не
  шлют.

## п.4b. event-list NOTIFY строго в диалоге принятой подписки

- `StationSubscriptions` принимает внешний источник диалогов
  (`StationSubSource` — в бою `station.subscriptions()/take_notify_cseq()`
  через DI `ctx.station_subs`, wiring в `server/station/stimulus.ts`);
  `next_notify` строит NOTIFY из записи станции: R-URI = `Contact:` её
  SUBSCRIBE (в дампе №1 это `.133:5060`, в дампе №2 Contact trunk 34 —
  `.157:5060` — берётся фактический), From/To-теги — зеркало диалога
  (наш To-тег → From-tag, её From-tag → To-tag), CSeq монотонный от
  станции, `Event` — её пакет;
- тело-триггер побайтово сверен с логом станции: `padded_value` в
  `server/los_mem/bodies.ts` — та же JSON-строка с `&quot;` (12×`&quot;` +
  65 обычных = ровно 137 символов при лимите 32), имя
  `replace_category_from_redirection` (33) — тесты фиксируют длины.

## п.3/п.4d. Стендовый зонд и тесты

- `doc/.probe_case_b.ts` (вне tsc): `--self` — вся цепочка на loopback без
  АТС (SUBSCRIBE→200+Contact+To-tag → запись диалога → NOTIFY в её Contact с
  триггером 137/33 → снятие expires=0); без флага — боевой режим: станция на
  :5060 ждёт реальную SSW-подписку .157 (`--wait=`, по умолчанию 1800 с) и на
  каждой новой event-list шлёт ОДИН NOTIFY в её Contact, печатая код ответа.
  Прогон `--self` зелёный (200/stasub-1/зеркало тегов/CSeq 1→2/355B на месте/
  снятие в 0);
- юниты (`tests/unit/station.test.ts`, `tests/unit/los_mem_raw.test.ts`):
  UAS подписок (200+Contact/Event/Expires, запись, стабильный тег на
  refresh, expires=0, неизвестный Event→405, протухание, монотонный CSeq),
  gating `answered` по своим Call-ID, `notify_log_line`, `next_notify` из
  внешнего диалога (R-URI=Contact, теги, фильтр events, fallback remote);
- критерий п.4d: `npm run build` зелёный, `test:unit` 89/89, `test:api`
  67/67, `format:check` чистый.

## п.5. Статус приёмки (что осталось на стенде)

Кодовая часть плана 5 закрыта; критерий «маркерные строки в СВЕЖЕМ дампе»
требует операторских действий на .157 (чел checklist в сессии): снять/ослабить
fail2ban-бан на 192.168.80.159:5060, SSW на номера trunk-а генератора в
конфиге АТС, перезапуск trunk (его SUBSCRIBE придёт на `u00sXXpXX@.159:5060`
и будет принят нашим UAS сразу), затем `npx tsx doc/.probe_case_b.ts`
(или короткий t2 через веб) и снятие свежего дампа с грепом
`ss_on_rx_notify … bad property`. До появления живой event-list подписки
станции стимул честно пишется в сводках («диалогов станции: 0») — маркеры
кейса B при этом появиться не могут (H2).

related: doc/plan_5.md, doc/los_mem/res.md (кейс B), doc/task_22_plan_2.md,
doc/task_25_plan_2.md, doc/task_26_plan_2.md.
