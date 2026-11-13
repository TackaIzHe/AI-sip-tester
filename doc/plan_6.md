# План 6: SAS-режим — наш сервер как SAS/SSW-сервер станции (port REGISTER + SSW SUBSCRIBE + SSInfo NOTIFY)

## Context

Дамп `doc/los_mem/new_log/11.log` (2025-12-22, «момент передачи управления под
наш сервер») вскрыл точный контракт: станция `.157` при регистрации внутренней
линии с `SAS=192.168.80.159:5060` выступает UAC и обращается НАМ на :5060 за
чемоданом доп. услуг:

- `sub_delayed_start_timer_cb` → `SSW_SRVM sub 0001` → `Sending Request msg
  SUBSCRIBE/cseq=22542` → `ext_domain_resolver: target host
  192.168.80.159:5060` ← мы отвечаем **405** (штатная мимикрия plan_4) →
  `Subscription SENT→TERMINATED`, `subscribe-status … cause 405`;
- `PBXIPC-SIP. RX. port-register # cgpn <u00s00p00> expires 3600` →
  `R-URI <sip:u00s00p00@192.168.80.159:5060>`,
  `Contact <sip:u00s00p00@192.168.80.133:5060;extensions="answermode">` →
  `Sending REGISTER` ← **405** → `port-register-status NOK`;
- keep-alive OPTIONS приходит и отвечает 200 (наша мимикрия работает), у
  станции при этом `app.c New SAS mode: 1/0` — режим переключается по
  отзывчивости сервера;
- триггер обращений — регистрация/перерегистрация внутреннего телефона на
  линии (на стенде — аппарат `.133`); без неё станция к :5060 с SAS-запросами
  не приходит вовсе (объясняет тишину дампов task_26/27).

Эталон «правильной» реакции — `doc/los_mem/new_log/10.log` (2026-08-19):
принятая подписка → `dlg0x… .Received Request msg NOTIFY/cseq=2` →
`sub_on_rx_notify_uac: SSW_SRVM sub … rx notify` → `ss_info.c :
ss_on_rx_notify` с обратным каналом `bad property: … len 33, allowed 32` и
`TX. subscribe-notify # SSInfo: 'teleconference'/'ml'/…` — ровно кейс B
плана 5, доступный только из ПРИНЯТОЙ UAC-подписки самой станции
(вердикт H2 плана 5, `doc/task_27_plan_2.md`).

**Вывод:** ни один из наших существующих механизмов (стимулы T1–T8,
пассивный UAS подписок plan_5 п.4a) не замыкает цепочку — станция ждёт от
сервера ответов на ЕЁ исходящие REGISTER/SUBSCRIBE и инициативных SSInfo
NOTIFY. Нужна новая роль: SAS-сервер.

## Объём

- SAS-режим станции (включаемый, REST/вкладка): REGISTER → 200, SUBSCRIBE
  ЛЮБОГО Event → 200 (имя SAS-пакета на проводе неизвестно — принимаем всё,
  имя пишем в журнал); мимикрия OPTIONS/405 вне режима не меняется.
- Движок SAS: инициативные SSInfo NOTIFY в принятые подписки станции
  (первый + периодические) через её сокет; обратная инженеринг-подстройка
  формата тела по ответам станции.
- REST/UI/DI, тесты, приёмка на стенде (зависит от действий на телефоне
  `.133` и снятия бана fail2ban после дампа №2).
- Не объём: активная отписка подписок станции (SSW снимает свою подписку сам,
  SUBSCRIBE expires=0), BLF-403 (task_22), медиа.

## Реализация

### 1. Станция: SAS-режим (`server/station/station.ts`)

- Контракт `Station`: `sas_mode(): boolean` и `set_sas_mode(on: boolean)`
  (по умолчанию выключен; автозапуска нет — как у самой станции).
- Метод REGISTER в `handle_request`: в SAS-режиме → 200 OK — эхо `Contact:`
  запроса (с исходными параметрами, напр. `;extensions="answermode"`) и
  `Expires:` из запроса (нет — 3600); R-URI user (номер абонента `u00sXXpXX`)
  — в журнал. Вне режима — прежний 405. Digest не требуем: в 11.log REGISTER
  станции приходят без Authorization, Challenge только добавит 408-рисков.
- `accepts_event`: в SAS-режиме принимает ЛЮБОЙ Event (подписка SSW_SRVM
  приходит под именем пакета, которого нет в `SUBSCRIBE_EVENTS`; гадать —
  терять подписки). Механизм UAS-диалога (200+Contact+To-tag сразу, план 5
  п.4a) переиспользуется без правок.
- `StationEvent` — новое поле `event` (имя Event у SUBSCRIBE/NOTIFY, '' у
  прочих); конструктор строк журнала вкладки печатает его у SUBSCRIBE —
  иначе имя SAS-пакета на проводе не узнать.
- SAS-режим не трогает: OPTIONS-мимикрию, 405 прочих методов, делегат
  `set_incoming_hook` (движок стимулов), счётчики.

### 2. Движок SAS (`server/station/sas.ts`)

- DI-контракт `StationSasApi { status(): SasStatus; enable(): void;
  disable(): void }` по образцу `StationStimulusApi` (мокируется в api-тестах);
  ошибки — `Error` с русским текстом: уже включён / выключен / станция
  остановлена / стимул выполняется (общий сокет — честный 409).
- `enable()`: флаг + таймер-опрос (≈2 с) `station.subscriptions()`: новый
  `call_id` (не был на момент enable) → немедленный первый NOTIFY (до
  таймеров pjsip, грабль плана 5 п.4c), далее периодические NOTIFY с
  интервалом-константой (порядка SSW keep-alive ~30 с).
- Построение NOTIFY — механизм `StationSubscriptions.build_notify`
  (`scenarios.ts`, план 5 п.4b): R-URI/адресат = `contact_uri`/`remote` из
  принятой подписки (на стенде — Contact `.133:5060`, НЕ .157), From =
  `from_uri`+`our_tag`, To = `to_uri`+`peer_tag`, CSeq = `take_cseq`
  (монотонен), Via/Contact = станция; транспорт — `station.udp_socket()`
  (своего bind нет; close клиентов не трогает сокет).
- Тело SSInfo — набор услуг из 10.log: `cnip/clip/cfnr` ACTIVE,
  `teleconference` {count}, `ml` {line_count, line_count_out} плюс служебные
  `timeout/use_external_number/use_redirection_counter/
  replace_category_from_redirection`. Формат и Content-Type — константы
  модуля (первое приближение: XML с property name/value по образцу
  разборов станции), правятся без рефакторинга; ограничение — имя и значение
  свойства ≤ 32 символов (иначе `bad property` — но именно это и есть
  обратная связь, п.5).
- `SasStatus`: mode, подписки-SAS (event, call_id, номер из R-URI, Contact,
  expires), отправлено NOTIFY / ответы по кодам, ring-лог сырых отправленных
  NOTIFY (те же поля, что `log_raw` плана 5 п.2).
- `disable()`: остановить таймер; диалоги станции НЕ трогаем (SSW снимает
  подписку сам); CSV не ведём (длительный режим, не прогон) — журнал
  кольцевой + события станции.

### 3. REST + DI + вкладка «Станция»

- `server/main.ts`: `new StationSas(config, station)` → `deps.sas`;
  `shutdown()` — `sas.disable()` до `station.stop()`;
- `server/routes.ts` (внутри `if (deps.station)`, при `deps.sas`):
  `GET  /api/station/sas` — статус;
  `POST /api/station/sas/enable` | `/disable` — 200/400/409 (коды по образцу
  stimulus); блок `sas` в `/api/health`;
- `public/index.html`: блок «SAS-режим (SSW)» на вкладке «Станция» — кнопки
  вкл/выкл, статус, список SAS-подписок (event/номер/Contact), журнал NOTIFY
  (опрос 2 с, как остальная вкладка);
- `doc/api.md` — эндпоинты 27–29 (карта 29).

### 4. Тесты

- unit (`tests/unit/`): SAS in — REGISTER → 200 (эхо Contact, Expires),
  SUBSCRIBE произвольного Event → 200 + `event` в журнале; SAS off —
  регрессия 405 на оба; построитель SAS NOTIFY — диалог/теги/монотонный
  CSeq; тело SSInfo — состав услуг из 10.log и лимит 32;
- api (`tests/api/`): моки `StationSasApi` — 200 статус, 409 (уже включён /
  станция остановлена / стимул идёт), корректный 404 без deps.sas;
- критерий: `npm run build`, `npm run test:unit`, `npm run test:api` зелёные.

### 5. Приёмка на стенде и реверс формата тела

- Порядок: убедиться, что ban на .159 после дампа №2 снят → запустить
  станцию → включить SAS → оператор перерегистрирует телефон линии с
  `SAS=.159` (аппарат `.133`; обращения приходят только на её
  регистрации/протухании подписки 7200 с).
- Наблюдаем в журнале станции: `port-register` (u00sXXpXX, Contact .133) и
  SUBSCRIBE с именем SAS-пакета → оба отвечены 200; в статусе SAS — живая
  подписка; первый NOTIFY — по адресу Contact её SUBSCRIBE.
- Целевой маркер в свежем дампе станции: `sub_on_rx_notify_uac: SSW_SRVM sub
  … rx notify` + строки `ss_info.c : ss_on_rx_notify` (кейс B); НЕТ
  `500 Unknown method: NOTIFY` и `fail2ban: BAN suggest` (иначе NOTIFY ушёл
  мимо диалога — дефект, правим).
- Реверс формата тела: канал обратной связи — ответы станции `bad property:
  name/value … len N, allowed 32` и `TX. subscribe-notify # SSInfo: …`
  (10.log); итеративно правим константы sas.ts до «чистого» разбора, затем
  — намеренные >32 (value 137–139, name `replace_category_from_redirection`
  33) — кандидаты утечки T2.
- Итог — в `doc/task_28_plan_2.md` (симптом → причина → решение; имя SAS-
  пакета на проводе, финальный формат SSInfo, склейка наших логов с дампом
  станции); строка статуса в `CLAUDE.md`.

## Verification

1. `npm run build`, unit, api — зелёные; SAS-200 на REGISTER/любой Event и
   регрессия 405 вне режима покрыты unit.
2. На стенде при включённом SAS у станции: `port-register-status OK` и
   `subscribe-status … OK` (нет `NOK cause 405`), `New SAS mode: 1` не мигает.
3. SAS-подписка видна в `GET /api/station/sas`; адресат/теги отправленных
   NOTIFY (сырой журнал) совпадают с Contact/диалогом её SUBSCRIBE.
4. Кейс B: в свежем дампе станции есть `ss_on_rx_notify` (хотя бы с
   `bad property`), либо зафиксирован внешний блокер (перерегистрация
   телефона/конфиг SAS на АТС) с собранными фактами (имя пакета, формат).

related: doc/los_mem/new_log/11.log (контракт SAS: port REGISTER + SSW
SUBSCRIBE + 405-исходы), doc/los_mem/new_log/10.log (эталон реакции — кейс B),
doc/plan_5.md (H2: только принятая UAC-подписка станции),
doc/task_27_plan_2.md (пассивный UAS, take_notify_cseq), doc/task_26_plan_2.md
(станция-движок, udp_socket/feed), server/station/station.ts,
server/los_mem/scenarios.ts (StationSubscriptions.build_notify).
