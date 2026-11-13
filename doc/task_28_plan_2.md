# Задача 28 — план 6: SAS-режим — наш сервер как SAS/SSW-сервер станции

Сессия 2026-11-09. План — `doc/plan_6.md` (п.1–5): роль SAS-сервера для
станции-пира (её port-register REGISTER + SUBSCRIBE SSW-пакета на наш :5060,
наши инициативные SSInfo NOTIFY в принятую подписку), REST/UI/DI, тесты,
приёмка на стенде и реверс формата тела. Контракт — дамп
`doc/los_mem/new_log/11.log`, эталон реакции (кейс B) — `10.log`.

## п.1. Станция: SAS-режим (`server/station/station.ts`)

- Контракт `Station`: `sas_mode(): boolean` / `set_sas_mode(on)`; по умолчанию
  выключен, автозапуска нет (как у самой станции).
- `handle_request`: в режиме REGISTER → `200` — эхо `Contact:` запроса с
  исходными параметрами (`;extensions="answermode"` — как в 11.log) и
  `Expires:` из запроса (нет — 3600); user из R-URI (`u00sXXpXX`) — в журнал
  (`StationEvent.event` — новое поле, печатается у SUBSCRIBE: имя SAS-пакета
  на проводе иначе не узнать). Digest не требуем: REGISTER станции приходят
  без Authorization (11.log), Challenge — только лишние 408-риски.
- `accepts_event`: в режиме принимает ЛЮБОЙ Event (SSW_SRVM приходит под
  именем, которого нет в `SUBSCRIBE_EVENTS`); UAS-механизм плана 5 п.4a
  (200+Contact+To-tag сразу, диалог в `subscriptions()`, `take_notify_cseq`)
  переиспользован без правок.
- Вне режима — регрессия прежняя: REGISTER/SUBSCRIBE → 405; OPTIONS-мимикрия,
  405 прочих методов, делегат `set_incoming_hook`, счётчики — не тронуты.

## п.2. Движок SAS (`server/station/sas.ts`)

- `StationSasApi { status/enable/disable }` по образцу `StationStimulusApi`
  (мокируется в api-тестах); ошибки — `Error` с русским текстом (уже включён /
  уже выключен / станция остановлена), контроллер кодирует в 409.
- `enable()` только на работающей станции (NOTIFY идут через её UDP-сокет,
  своего bind нет); baseline: подписки, принятые до включения, NOTIFY не
  ждут; опрос `subscriptions()` раз в 2 с — новый `call_id` → немедленный
  первый NOTIFY (до таймеров pjsip), далее периодические каждые 30 с.
- Построение NOTIFY — тот же диалог, что у принятой подписки: R-URI =
  `contact_uri` пира (на стенде — Contact `.133:5060`, НЕ .157), From = её
  To + наш To-тег, To = её From + её тег, CSeq монотонен (`take_notify_cseq`);
  транспорт — `station.udp_socket()`.
- Хук входящих (`set_incoming_hook`) ест только SIP-ответы на наши NOTIFY
  (учёт в `answered`/`last_response`); запросы возвращаются станции —
  SAS-приём REGISTER/SUBSCRIBE живёт в ней.
- Тело SSInfo — первое приближение: «хорошие» услуги из 10.log
  (`teleconference.count`, `ml.line_count`, `ml.line_count_out`) + три
  триггера кейса B (name 33 / value 137, `padded_name`/`padded_value` из
  `bodies.ts`) — маркер входа в `ss_on_rx_notify` и цель прогона.
- `disable()`: таймер и хук снимаются, SAS-флаг гаснет (мимикрия 405
  восстанавливается), диалоги станции не трогаются (SSW снимает подписку сам).

## п.3. REST + DI + вкладка «Станция»

- `server/main.ts`: `new StationSas(config, station)` → `deps.sas`,
  `shutdown()` гасит SAS до `station.stop()`;
- маршруты 27–29 (`station_controller` при `deps.sas`): `GET /api/station/sas`
  — статус; `POST /api/station/sas/enable|/disable` — `200` (тело — статус) /
  `409` (станция остановлена, стимул выполняется — общий сокет и хук,
  гонка enable, уже выключен); `POST /api/station/stop` гасит SAS раньше
  снятия слушателя; блок `sas: { state }` в `/api/health`;
- вкладка «Станция» — блок «SAS-режим (SSW)»: кнопки вкл/выкл, статус,
  SAS-подписки (event/номер/Contact/отправлено/ответ), журнал NOTIFY, опрос 2 с;
- `doc/api.md` — эндпоинты 27–29, карта 29, блок `sas` в health-примере
  (дописано в этой сессии: прежняя остановилась на коде без журнала docs).

## п.4. Тесты

- unit (`tests/unit/station.test.ts`): SAS in — REGISTER → 200 (эхо
  Contact/Expires), SUBSCRIBE произвольного Event → 200 + `event` в журнале;
  SAS off — регрессия 405 на оба; флаг `sas_mode` ставится/снимается движком;
- unit (`tests/unit/station_sas.test.ts`): ошибки enable/disable, хук ответов
  (после disable ответы снова «мусор» в счётчиках станции), loopback-e2e:
  «станция-пир» шлёт SUBSCRIBE с Contact на свой порт → первый NOTIFY — в
  Contact, теги/CSeq/`Event`/`Subscription-State`/`Content-Type` по образцу
  10.log, тело — триггеры кейса B, ответ пира учитывается и не становится
  мусором;
- unit (`tests/unit/los_mem_raw.test.ts`): `subscription_state_value` (остаток
  секунд, дефолт 600) + `Subscription-State` в `SubDialog.notify_message`;
- api (`tests/api/station_sas.test.ts`): моки `StationSasApi` — 200 статус,
  enable/disable, 409 (уже включён / станция остановлена / стимул идёт /
  уже выключен), 404 без `deps.sas`;
- критерий зелёный: `npm run build`, unit 97/97, api 74/74, `format:check`.

## п.5. Приёмка и реверс формата тела — «станция ждёт подтверждения»

Дамп №3 `doc/los_mem/new_log/12.log` (2026-11-09 17:10, первый прогон SAS на
стенде): подписка принята, NOTIFY отвергнут станцией.

- **Симптом:** SSW_SRVM `sub 0001` к `sip:u00s30p07@192.168.80.159:5060` —
  на нашей стороне `200` («Will refresh in 7188 seconds»), затем наш
  `NOTIFY/cseq=1` получает `400` → `UAC_WAIT_NOTIFY` (таймер 5 с на
  «subsequent NOTIFY») → `Unsubscribing..`. Маркеров `sub_on_rx_notify_uac` /
  `ss_info.c : ss_on_rx_notify` в дампе нет — сообщение не дошло до
  обработчиков.
- **Причина:** в наших NOTIFY отсутствовал обязательный заголовок
  `Subscription-State` — pjsip-evsub валидирует его ДО диспетчера
  (`sub_on_rx_notify_uac`), для active/pending нужен и параметр `expires`
  (RFC 3265 §4.1.4); «подтверждение, которого станция ждёт» — повторный
  корректный NOTIFY в 5-секундном окне UAC_WAIT_NOTIFY.
- **Решение:** `subscription_state_value(expires_at)` (`raw_sip.ts`) —
  `active;expires=<остаток>` (мусор/истечение — 600); заголовок добавлен во
  ВСЕ три построителя NOTIFY — `StationSubscriptions.build_notify`
  (стимулы/движок, `scenarios.ts`), `SubDialog.notify_message` (собственные
  UAC-подписки генератора) и `StationSas.send_notify`; диалог подписки теперь
  хранит `expires_at` (`StationSubView`, в client-режиме — из запроса, в
  UAC-режиме — из 200 на SUBSCRIBE).
- **Доводка заголовка (указание стороны АТС):** Content-Type SSInfo NOTIFY —
  `application/ss-info+xml` (не simple-list+xml — с ним тело SSInfo не
  разбиралось): константа `SSINFO_CONTENT_TYPE` (`bodies.ts`), SAS-движок и
  зонд `.probe_case_b.ts` переведены. Fuzz-стимулы t2/t8 намеренно остаются
  на `simple-list+xml` — их дефектность определена `doc/los_mem/plan_test.md`.
- **Попутно (дефекты тестовой обвязки):** в `station_sas.test.ts` конфиг
  был с `subscribers: []` вне 3-кортежного типа (сборка падала — тест не
  выполнялся), и первым пакетом loopback-«пира» ловился его же `200` на
  SUBSCRIBE вместо NOTIFY; теперь ждём пакет именно метода NOTIFY.

**Статус приёмки:** критерии кода зелёные; целевой маркер (в свежем дампе —
`sub_on_rx_notify_uac: SSW_SRVM … rx notify` + `ss_info.c : ss_on_rx_notify`
хотя бы с `bad property`, без `400/NOTIFY` и `fail2ban: BAN suggest`) ждёт
повторного прогона на стенде: включённый SAS → перерегистрация телефона линии
с `SAS=.159` (аппарат `.133`) — внешний блокер прежний (обращения станции
приходят только на её регистрации). Итог склейки логов — дописать сюда по
свежему дампу.

related: doc/plan_6.md, doc/los_mem/new_log/11.log (контракт), 12.log (дамп
приёмки: 400/NOTIFY → UAC_WAIT_NOTIFY), doc/los_mem/new_log/10.log (эталон),
server/station/station.ts, server/station/sas.ts, server/los_mem/raw_sip.ts
(`subscription_state_value`), server/los_mem/bodies.ts (`SSINFO_CONTENT_TYPE`),
server/los_mem/scenarios.ts, doc/task_27_plan_2.md (план 5: UAS-диалоги).
