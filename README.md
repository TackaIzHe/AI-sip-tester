# Сервер SIP-автестов с веб-интерфейсом

Node+TS сервер (Express, rails-style API): SIP-протокол перенесён 1-в-1 из
`task2/` (машина sip.js поверх классического UDP/TCP), работает против **живой
АТС** `PBX_HOST:PBX_PORT` из `.env`. Asterisk не используется. Медиа нет
никогда (SDP-заглушка `m=audio 9` + `a=inactive`); кодек согласуется — иначе
АТС отвечает `488`.

Виртуальные абоненты зарегистрированы на станции самим сервером; вызовы делают
они же. Веб-страница: дерево файлов сервера (включая скрытые) с просмотром
содержимого (подсветка `.ts`/`.json`/`.md`) + вкладка «Тесты» (запуск e2e-кейсов из списка, вердикты и журнал
прогона) + вкладка «Станция» (запуск/останов собственной станции-эмулятора,
её статус и журнал обращений) + раздел отчётов прогонов (HTML). Терминал
сервера запускает те же e2e-кейсы. Полные цепочки этапов (REGISTER→401→200, INVITE/180/200/ACK/BYE,
CANCEL, 486/480/502) фиксируются в отчётах `reports/*.html|md|json`.

- REST-контракт всех endpoints — [`doc/api.md`](doc/api.md)
- Архитектура и инварианты — [`doc/arch.md`](doc/arch.md)
- План работ и журналы сессий — `doc/plan_2.md`, `doc/task_<n>_plan_2.md`
- Протокольная справка — `doc/sip_rfc.md`

## Требования

Node.js ≥ 18. Доступ из сети станции до сервера (транспорт SIP и эфемерные
порты UDP/TCP) и до самой станции (`PBX_HOST:PBX_PORT`).

## Запуск

```bash
npm install
cp .env.example .env      # вписать реальные номера/пароли и адреса стенда
npm start                 # конфиг → express → терминал `sip> `
```

Страница: `http://<host>:<SERVER_PORT>/` (образец: `http://192.168.80.159:3000/`).

### `.env` (образец — `.env.example`, читается только через `server/config.ts`)

| Переменная | Назначение |
|---|---|
| `SERVER_PORT` | HTTP-порт веб-интерфейса и REST API |
| `PBX_HOST`, `PBX_PORT` | живая АТС (образец: `192.168.80.157:5060`) |
| `SIP_PROTOCOL` | транспорт SIP: `udp` или `tcp` |
| `BRIDGE_HOST`, `BRIDGE_PORT` | WS-мост: адрес ЭТОЙ машины, видимый станции (не `127.0.0.1`!), порт WS-сервера |
| `SIP_NUMBER_1`/`SIP_PASS_1` | абонент 1 (образец: `9404`/`123`) — звонящий |
| `SIP_NUMBER_2`/`SIP_PASS_2` | абонент 2 (образец: `52`/`321`) |
| `SIP_NUMBER_3`/`SIP_PASS_3` | абонент 3 (образец: `3203`/`123`) — **только цель вызова, не регистрируется** (цепочка 9404→3203→52) |
| `STATION_HOST` | адрес станции-эмулятора (необязат., по умолчанию `192.168.80.159`) |
| `STATION_PORT` | её SIP-порт (необязат., по умолчанию `5060`; `0` — эфемерный) |
| `STATION_PROTO` | `udp` \| `tcp` \| `both` (необязат., по умолчанию `both`) |

## Команды

| Команда | Действие |
|---|---|
| `npm start` | сервер: конфиг → express → терминал (`server/main.ts`) |
| `npx tsx bridge_main.ts` | WS-мост отдельно (`BRIDGE_HOST:BRIDGE_PORT` из `.env`) |
| `npm run build` | `tsc --noEmit` (единственная проверка типов) |
| `npm test` | юнит + api-тесты (без сети) |
| `npm run test:unit` | юнит-тесты vitest (`tests/unit/`) |
| `npm run test:api` | API-тесты supertest (`tests/api/`, без сети, мок пула) |
| `npm run test:e2e` | e2e-кейсы против живой АТС (`tests/e2e/`, последовательно) |
| `npm run test:losmem -- t1 --minutes=1` | генератор стимулов тестов локализации утечки памяти T1–T8 (`doc/los_mem/`, см. `--list`) |
| `SIP_DEBUG=1 npm start` | отладочный лог SIP-транспорта |

## Терминал сервера (после `npm start`, приглашение `sip> `)

| Команда | Действие |
|---|---|
| `test <1\|2\|3\|4\|5\|noanswer\|caller\|batch24reg\|batch24unreg\|all>` | прогон e2e-кейса: шаги — в терминал, отчёт — в `reports/` (ссылка на HTML печатается) |
| `status` | регистрации абонентов и активные вызовы |
| `help` | справка |
| `quit` | graceful-завершение: unregister всех → закрыть HTTP |

Пример: `test 1` → `PASS: регистрация 9404 подтверждена: REGISTER → 200` +
`HTML: http://<host>:3000/reports/<отчёт>.html`.

## Станция-эмулятор (`server/station/station.ts`)

SIP-UAS на UDP и/или TCP (адрес из `STATION_*`, см. `.env.example`): входящий
OPTIONS (keep-alive пира) → `200` с `Allow`/`Allow-Events`/`User-Agent` как у
pa_sip, прочие методы → `405 Allow: OPTIONS`, не-SIP — игнор со счётчиком.
Ничего не отправляет сама. Автозапуска нет: слушатели поднимаются кнопкой на
вкладке «Станция» или `POST /api/station/start`; на странице — статус,
счётчики и журнал последних ~200 обращений (опрос 2 с, пока вкладка открыта).

Порт 5060 привилегированный (<1024): без прав `start` честно вернёт `502` с
подсказкой — нужен root или разово:

```bash
sudo setcap cap_net_bind_service=+ep $(which node)
```

Зонд мимикрии (поднимает станцию из `.env` и печатает полные ответы на
OPTIONS/REGISTER/мусор; `STATION_PORT=0` — без root):

```bash
npx tsx doc/.probe_station_ka.ts
```

## Тест-кейсы (живая АТС)

| Кейс | Сценарий |
|---|---|
| `1` | регистрация абонента 1 и снятие (цепочка REGISTER → [401 → Digest] → 200) |
| `2` | вызов и приём: INVITE → 180 → 200 → ACK → BYE у обеих ног |
| `3` | приём и отклонение: 200+BYE, затем reject → 486, без зависших диалогов |
| `4` | прокси-цепочка 9404→3203→52: входящий у 52, 3203 не регистрируется |
| `5` | пароли: корректные → успех; неверный → условная ветка стенда (без ложного REGISTERED — регресс BUG-1) |
| `noanswer` | не-ответ: вызов незарегистрированного номера, финальный отказ станции в отчёте (стенд: 100 → 502) |
| `caller` | Calling party number у 52: в цепочке 9404→3203→52 входящий INVITE у 52 содержит номер вызывающего (From=9404), затем reject 486 |
| `batch24reg` | пакетная регистрация 24 абонентов 24..47 (REGISTER → 200 у каждого) на теневом пуле; регистрации остаются живыми — снятие отдельным `batch24unreg` (основной кейс пары, `tests/e2e/batch_24_47_reg_unreg.test.ts`) |
| `batch24unreg` | второстепенный: снятие диапазона, оставленного `batch24reg` (200 на REGISTER expires=0 у каждого). Обязан идти в том же процессе сервера — binding станции привязана к Contact транспорта; без живого пула честно FAIL |

Прогон тем же раннером доступен по HTTP: `POST /api/test_runs {"case":1}` →
`202 {id}` → `GET /api/test_runs/:id` (вердикты + журнал), см. `doc/api.md`.

## Структура

```
server/          main.ts (bootstrap), config.ts (.env), app.ts+routes.ts+controllers/
                 (REST), middleware/, journal.ts (отчёты), sip_pool.ts (абоненты),
                 station/station.ts (станция-эмулятор, keep-alive UAS),
                 terminal.ts (REPL), sip/ (перенесённый SIP-код, лист без express)
bridge_main.ts   WS-мост (JSON v:1) — отдельный процесс
e2e_runner.ts    общий раннер кейсов 1–5 + noanswer + caller + batch24reg/unreg (терминал / API / vitest)
public/          index.html — страница (дерево файлов + запуск тестов + отчёты + статус)
reports/         генерируемые отчёты прогонов (json+md+html)
tests/           unit/ · api/ (без сети) · e2e/ (живая АТС)
doc/             plan_2.md, api.md, arch.md, sip_rfc.md, task_*_plan_2.md
task2/           прежний проект — только источник переноса, не редактируется
```

## Быстрая проверка (приёмка)

```bash
npm run build && npm test                          # типы + юнит/api — зелёные без сети
curl -s localhost:3000/api/health                  # статус и адрес АТС
curl -sX POST localhost:3000/api/subscribers/9404/register   # регистрация на живой АТС
curl -s 'localhost:3000/api/files/content?path=../../etc/passwd'  # → 403
curl -sX POST localhost:3000/api/station/start   # станция (порт 5060 — см. setcap выше)
```
