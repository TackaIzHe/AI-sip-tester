# Задача 24 — эмулятор телефонной станции: ответы на keep-alive (план 4, фаза 1)

Выполнен `doc/plan_4.md` (п.1–6): SIP-UAS-листок, отвечающий на keep-alive
пира (OPTIONS каждые ~21 с, трасса `pa_sip` в `doc/los_mem`), с адресом из
`.env` (по умолчанию `192.168.80.159:5060`, UDP+TCP). Станция НИЧЕГО не
отправляет сама: OPTIONS → `200` с `Allow`/`Allow-Events`/`User-Agent` как у
pa_sip, прочие методы → `405 Allow: OPTIONS`, не-SIP → игнор со счётчиком.

## Что сделано

- `server/station/station.ts` (новый) — DI-контракт `Station`
  (`status/events/start/stop`, по образцу `SipPool` п.4.2) и `SipStation`:
  UDP (`dgram`, ответ на src-порт пира — rport-семантика) и TCP (`net`,
  фрейминг по Content-Length — тот же алгоритм, что `feed_tcp()` в
  `server/los_mem/raw_sip.ts:539`, не экспортируется → повторён с
  комментарием); значения ответов взяты дословно из дампов `doc/los_mem`
  (`Allow: INVITE, …`, `Allow-Events: presence, dialog, …`, `User-Agent:
  Eltex ECSS-10 SIP 3.14.15.27.4`); To-tag `station` дописывает
  `build_sip_response`; обработчик не бросает (ошибка сокета → `stopped` +
  текст, express не роняем); ring-buffer журнала ~200 обращений
  (`ts/peer/proto/method/ruri/cseq/call_id/code`, newest first);
  `start()/stop()` идемпотентны.
- `server/config.ts` + `.env.example` — необязательные `STATION_HOST` (по
  умолчанию `192.168.80.159`), `STATION_PORT` (5060; `0` — эфемерный,
  допустим только для станции: зонды/тесты без root), `STATION_PROTO`
  (udp|tcp|both, both); синтетические конфиги тестов не сломаны.
- `server/controllers/station_controller.ts` (новый) — `GET /api/station`,
  `POST /start` (200/409 уже запущена/502 bind + подсказка root/setcap),
  `POST /stop` (200/409), `GET /events?limit=` (400 на не-целое/<1);
  коды — в контроллере, `error_handler` не расширялся.
- `server/routes.ts`, `server/app.ts` — `station?: Station` в `RouteDeps`/
  `AppDeps`, ресурс монтируется только при наличии станции (иначе честный
  404); `server/controllers/health_controller.ts` — опц. аргумент, блок
  `station: {state, host, port}` в `/api/health`; `server/main.ts` —
  `new SipStation(config)` в wire-up (НЕ стартует), `stop()` в `shutdown()`.
- `public/index.html` — вкладка «Станция»: кнопки запустить/остановить
  (confirm на стоп, disabled по состоянию), блок статуса (пилюля, адрес,
  uptime, счётчики по методам/кодам, игноры, пиры, последний keep-alive),
  журнал обращений; опрос 2 с только пока вкладка открыта; пилюля станции в
  статус-строке по `/api/health`.
- `tests/unit/station.test.ts` (новый, 8 тестов) и
  `tests/api/station.test.ts` (новый, 8 тестов с `MockStation` через DI) —
  см. «Проверки»; `doc/.probe_station_ka.ts` — зонд мимикрии (свою станцию
  из `.env` или внешний `host:port`; печатает полные ответы OPTIONS/
  REGISTER/мусор + счётчики).
- Документация: `doc/api.md` — раздел «Станция» (+4 endpoints, карта
  19→23, блок station в health), README — `.env`-строки, раздел
  «Станция-эмулятор» с setcap-подсказкой, структура, приёмка.

## Ключевые решения (с обоснованием)

- Заголовка `Server:` в дампах `doc/los_mem` НЕТ — не добавляем: мимикрия
  обязана совпадать с трассой, лишний заголовок выдал бы эмулятор
  (отклонение от «взять из дампов» в сторону строгого соответствия).
- `parse_sip_request_head` не возвращает R-URI и CSeq (генератору los_mem
  они не нужны) — достаём из сырья в `handle_request` (`request-line[1]`,
  регулярка `^cseq:`), не меняя общий парсер.
- Порт 0: UDP bind первым занимает эфемерный номер, TCP биндится на тот же
  (иначе `status().port` двусмысленен); в tcp-only режим номер берётся из
  адреса самого сервера.
- Идемпотентность `start/stop` — на уровне сервиса (no-op), а 409 — на
  уровне контроллера (проверка `status().state` до вызова): контракт
  станции остаётся пригодным для main.ts, коды REST — не его забота.
- Блок `station` в health — через `undefined`-ключ (`res.json` его вырезает):
  приложение без станции честно не отдаёт блок.

## Результат проверок

- `npm run format`/`format:check`, `npm run build` — зелёные.
- `npm run test:unit` 75/75 (включая 8 станционных: OPTIONS→200 с Allow/
  Allow-Events/To-tag и копиями Via/CSeq, REGISTER→405 Allow: OPTIONS,
  мусор — игнор+счётчик+строка журнала, TCP-фрейминг «два сообщения в
  одном чанке», both на один порт, идемпотентность, после stop не отвечает —
  плюс 2 на дефолты/ошибки STATION_* в config.test),
  `npm run test:api` 59/59 (включая 8 новых: форма статуса, start/stop +
  409-повторы, 502 с текстом сервиса при живом сервере, events/limit/400,
  блок station в health, 404 без станции), `npm test` 134/134.
- Критерий карты endpoints: `grep -rE "router\.(get|post|delete)\("
  server/controllers/ | wc -l` = 23 == 23 задокументированных (`doc/api.md`).
- Зонд: `STATION_PORT=0 npx tsx doc/.probe_station_ka.ts` (0 — эфемерный,
  без root; валидация принимает 0 только для STATION_PORT) — UDP и TCP:
  OPTIONS → 200 (полный дамп совпадает с образцом `pa_sip`), REGISTER →
  405 Allow: OPTIONS, мусор — без ответа; счётчики
  `in={OPTIONS:2,REGISTER:2} answered={200:2,405:2} ignored=1`.

### Симптом → причина → решение

- Все api-тесты станции получали 404 (зелён только «без станции»):
  `create_app` в `server/app.ts` не передавал `station` в `build_api_router`
  — поле опциональное, `tsc` не ошибкавался. Причина — правка AppDeps без
  правки места проброса; решение — `station: deps.station` в вызове
  фабрики роутера. Грабля опциональных DI-полей: монтировать надо тестом
  «с DI», а не только «без DI».
- `status().port` = 0 у tcp-only станции (валился юнит): номер брался только
  из UDP-адреса; добавлен вывод порта из `tcp.address()` при `!want_udp`.

## Для будущих сессий

- Фаза 2 (по плану не делалась): REGISTER/INVITE-логика станции — сейчас
  всё, кроме OPTIONS, честно получает 405; точка расширения —
  `handle_request` в `server/station/station.ts`.
- Живой пир (Eltex SMG, keep-alive на `STATION_HOST:STATION_PORT`) —
  проверка с реального устройства: `npm start` (с setcap) → вкладка
  «Станция» → «запустить»; пиры и периоды видны в журнале вкладки.
- Зонд без root: `STATION_PORT=0 npx tsx doc/.probe_station_ka.ts`; на
  чужой UAS — аргументом `host:port` (свою не поднимает).
