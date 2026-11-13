# Задача 22 — генератор стимулов тестов локализации утечки памяти (doc/los_mem)

Запрос пользователя: «Реализуй тесты по плану из папки doc/los_mem» — сценарии
T1–T8 из `doc/los_mem/plan_test.md` (кандидаты A–F из `doc/los_mem/res.md`,
адаптер `pa_sip` АТС Eltex). Уточнение пользователя: **вердикт и отчёт об
утечке не нужны** — нужна только генерация стимулирующих SIP-событий, каждый
прогон завершается успешно (код 0), память/вывод оператор определяет сам по
фазовым меткам CSV и своему мониторингу. Анализ RSS, R², PASS/FAIL — НЕ
реализованы (отклонение от §2.2/§4 плана по решению оператора).

## Что сделано

- `server/los_mem/raw_sip.ts` — сырой SIP-слой поверх `dgram`/`net` (sip.js
  намеренно не используется: его UA из `server/sip/` не умеет
  SUBSCRIBE/NOTIFY и не пропускает невалидные сообщения, а тестам нужны
  ровно они):
  - `build_sip_request` — запросы произвольной формы (Via с `rport`, branch
    `z9hG4bK-…`, sent-by без порта — грабли стенда; Content-Length — байтовая
    длина; ветки `content_length_override` и `garbage_after_body`);
  - `build_sip_response` — ответы («провайдер-401» T4, 200 на SUBSCRIBE);
  - `parse_sip_response` / `parse_sip_request_head` — разбор ответов станции
    (To-tag/Contact) и её входящих SUBSCRIBE (Event/Expires/Contact/теги);
  - `parse_digest_challenge` / `build_digest_authorization` — RFC 2617 MD5
    (с qop=auth), нужен потому, что станция просит Digest на SUBSCRIBE и
    REGISTER (см. «Зонд» ниже);
  - `RawSipClient` — UDP bind (фикс. `local_port` — «повторное использование
    src-порта» плана §2.1) / TCP с фреймингом по Content-Length; счётчики
    sent_by_method/answered, `wait_response` по Call-ID, `local_port()` для
    Contact с эфемерным портом;
  - `RawUdpResponder` — UDP-сервер «провайдера-401» (T4a).
- `server/los_mem/bodies.ts` — тела-стимулы: `dialog_info_body` варианты
  a–f T1 (пустой `<dialog-info>`, `<dialog>` без `<remote><identity>`,
  не-XML, обрезанный, корректный+лишний Encoding (e), контроль (f)) и
  `simple_list_body` T2 (value ровно 137 символов с `&quot;`, name ровно 33 —
  `replace_category_from_redirection`, лимит станции 32; гибрид 100–1000
  свойств), `ipc_subscribe_frames` — hex-кадры subscribe(type 54) для T6.
- `server/los_mem/scenarios.ts` — сценарии T1–T8 + реестр `LOS_SCENARIOS`
  (дефолты темпа/длительности из плана §3): общий каркас `paced_loop`
  (1000/rate мс, SIGINT-чувствительный), `SubDialog` (SUBSCRIBE своей машины
  + Digest-повтор, To-tag/Contact только из 2xx, NOTIFY «в диалоге»),
  `register_raw`/`RawRegistration` (сырая регистрация с Digest и снятием
  expires=0), `StationSubscriptions` — пассивный UAS входящих SUBSCRIBE
  станции (см. «Зонд»), сводки разделяют «в диалоги станции» и «вслепую».
- `los_mem_main.ts` (корень) — CLI: `npx tsx los_mem_main.ts <t1..t8>
  [--minutes --rate --variant --kind --props --target --cycles --pause
  --provider-port --observe-min --count --ipc-cmd --domain --csv=path|off]`;
  конфиг только из `.env` через `server/config.ts`, номера/пароли из
  `AppConfig.subscribers`; CSV-журнал `reports/los_<t>_<UTC>.csv`
  (`ts_utc,ts_ms,scenario,kind,text`, метки фаз stim_start/stim_stop/… —
  план §2.2), Ctrl-C — досрочный стоп с зачисткой, выход всегда 0 (кроме
  ошибок сокета/конфига).
- Обвязка: `tsconfig.json` (include `los_mem_main.ts`), `package.json`
  (`"test:losmem": "tsx los_mem_main.ts"`, format-скрипты).
- `tests/unit/los_mem_raw.test.ts` — 17 юнитов без сети: порядок заголовков
  и rport/branch, байтовый CL (кириллица), битый CL override + мусор после
  CL, разбор ответов/запросов (SUBSCRIBE станции), `uri_host_port`, Digest
  (разбор вызова + вектор RFC 2617 §3.5 `6629fae4…`), размеры тел T1/T2
  (137/33 из логов res.md), IPC-кадры.
- `doc/.probe_losmem_events.ts` — прогон-зонд поведения станции (не в бандле).

## Зонд: что показал стенд (симптом → причина → решение)

- `SUBSCRIBE Event: dialog-info/event-list/presence` → **489 Bad Event**.
  Имя пакета BLF у станции — RFC 4235 `dialog` (в `res.md` «dialog-info» —
  имя Content-Type тела, не пакета). Решение: T1/T3/T8 шлют `Event: dialog`,
  тело остаётся `application/dialog-info+xml`.
- `SUBSCRIBE Event: dialog` → **401** (Digest). Добавлен Digest (RFC 2617);
  после Digest → **403 Forbidden** — станция не принимает внешние
  dialog-подписки (даже с REGISTER → 200). `Expires: 120` при этом → **423
  Interval Too Small** (порог в `Accept-Expires`).
- `blf_on_rx_notify`/`ss_on_rx_notify` по `res.md` живут на **исходящих**
  подписках станции (`sub_on_rx_notify_uac`): станция сама слала бы SUBSCRIBE
  на Contact зарегистрированного абонента. Зонд: REGISTER 9404 → 200, слушание
  40 с — входящих SUBSCRIBE **0** (BLF/SSW за тестовыми номерами на АТС не
  настроены). Решение: `register_raw` + `StationSubscriptions` отвечают 200
  на её SUBSCRIBE и льют NOTIFY в её диалог — как только админ АТС настроит
  BLF/distinctive-ring на номера генератора (9404/…), кандидатные пути
  достижимы без правки кода; без настройки сводка честно пишет
  «в диалоги станции 0» и NOTIFY идут вслепую (станция отвечала 481 без To-tag
  и 500 с тегом из 403 — пакеты до ядра доходят).
- В середине сессии станция **перестала отвечать вообще** (OPTIONS → нет
  ответа; до этого отвечала на всё). Совпадает с картиной OOM из `res.md`
  (падение/рестарт `pa_sip`) либо SIP-защитой по источнику. На код не влияет:
  прогоны при недоступности станции уходят с 0 и счётчиком «нет ответа».

## Прогоны T и как запускать

| ID | Что шлёт | Пример |
|---|---|---|
| t1 | SUBSCRIBE `dialog` + NOTIFY телами a–f (`--variant=all` — по очереди, `e` — с лишним Content-Encoding), темп 1.5/с, `--minutes=30` | `npm run test:losmem -- t1 --minutes=1 --variant=all` |
| t2 | NOTIFY simple-list+xml, `--props` свойств (value 137/name 33, `--kind=value\|name\|hybrid`), 1/с | `… t2 --minutes=1 --props=100` |
| t3 | цикл «полный набор SUBSCRIBE → пауза → повтор» новым сокетом (`--cycles --pause`), дубли активных подписок | `… t3 --cycles=1 --pause=5` |
| t4 | (a) «провайдер-401» `realm="GUmvd"` на `--provider-port=5061` (нужен транк АТС на нас; 0 входящих — не ошибка), (b) OPTIONS от абонентов 2/с | `… t4 --minutes=1` |
| t5 | flood с 3 чужих портов: REGISTER/SUBSCRIBE/INVITE cseq=1, `--rate` на вариант + пауза наблюдения `--observe-min` | `… t5 --minutes=1 --observe-min=0` |
| t6 | IPC-кадры subscribe(54) в hex-файл `reports/` или на stdin `--ipc-cmd` (разъёма app↔адаптер с этой машины нет — hook транспорта за оператором) | `… t6 --count=10000` |
| t7 | OPTIONS/SUBSCRIBE с доменными RURI `losmem-*.--domain` (NXDOMAIN, резолв станции), 35/с | `… t7 --minutes=1` |
| t8 | soak: битые dialog-info 1.5/с + event-list 1/30с + чужие REGISTER 1/с (`--minutes` до 1440) | `… t8 --minutes=720` |

## Отклонения от плана (с обоснованием)

1. Вердикт/RSS/«прогретый аллокатор» (§2.1–2.2, §4) — по решению оператора:
   вместо них фазовые метки времени в CSV/stdout и сводки счётчиков.
2. T1/T2 «на каждую активную BLF-подписку»: активная подписка снаружи
   несоздаваема (489/403, см. «Зонд») — NOTIFY уходят в диалоги станции при их
   появлении, иначе вслепую; достижение кандидатов требует BLF/SSW-настройки
   АТС на номера генератора (в своде прогона видно, получилось ли).
3. T4a: 401-провайдер слушает эту машину — сработает при транке, настроенном
   на нас; 0 принятых в сводке — допустимый честный итог (не FAIL).
4. T6: нет доступа к IPC-разъёму закрытой прошивки — кадры в файл/через
   `--ipc-cmd` (hook для транспорта оператора).
5. T7: подмены DNS нет — шторм строится на NXDOMAIN (`*.invalid`, RFC 6761):
   резолвер станции тратит циклы на заведомо пустые резолвы.

## Результат проверок

- `npm run build` — зелёный; `npm test` — 115/115 (новые юниты включены).
- Живой стенд до его молчания: t1 `--minutes=1 --variant=all` — exit 0,
  ответы станции 489/401/403/481/500 в сводке, CSV в `reports/`;
  повторный t1 (с регистрацией) — exit 0 (станция уже молчала — «нет ответа»);
  t6 `--count=50` — exit 0, hex-дамп в `reports/`. Прогоны t2/t3/t5/t7/t4 —
  за стендом после его восстановления (команды в таблице выше); код путей
  проверен сборкой/юнитами и одинаковым каркасом с проверенным t1.

## Для будущих сессий

- Точка входа — `los_mem_main.ts` (флаги в шапке), сценарии — `run(ctx)` из
  `LOS_SCENARIOS`; новый T = запись в реестр + (опц.) флаги в CLI.
- Станция: REGISTER без challenge (пароль не проверяется), SUBSCRIBE-и как UAS
  не принимает, `Event: dialog` требует Digest и Expires ≥ порога; Digest —
  MD5, qop=auth. Сырой UDP-клиент обязан: rport в Via, sent-by без порта,
  Contact user=номер (+ эфемерный порт — только в Contact).
- Зонд актуальности поведения станции: `npx tsx doc/.probe_losmem_events.ts`.
