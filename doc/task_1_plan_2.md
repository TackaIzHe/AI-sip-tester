# Отчёт: пункт 1 «Каркас и конфиг» (plan_2.md §1)

Дата выполнения: 2026-10-27. Статус: **выполнен, критерии приёмки зелёные**.

## Что сделано

### 1.1 `package.json`
- Имя `sip-atc-test-server`, `"type": "module"` (ESM, как в task2).
- Скрипты:
  - `start` — `tsx server/main.ts`;
  - `build` — `tsc --noEmit`;
  - `test` — `vitest run tests/unit tests/api`;
  - `test:unit` / `test:api` / `test:e2e` — vitest по соответствующим каталогам.
- Зависимости: `express`, `ws`, `sip.js`, `dotenv`.
- Dev-зависимости: `typescript`, `tsx`, `vitest`, `supertest`, `@types/{node,express,ws,supertest}`.
- `npm install` выполнен успешно.

### 1.2 `.env.example` + `.env`
Заглушки по образцу плана, с русскими комментариями; `.env` — копия `.env.example`
(реальные номера/пароли пользователь впишет сам):

```
SERVER_PORT=3000
PBX_HOST=192.168.80.157
PBX_PORT=5060
SIP_PROTOCOL=udp
BRIDGE_HOST=192.168.80.159
BRIDGE_PORT=8090
SIP_NUMBER_1=9404 / SIP_PASS_1=123
SIP_NUMBER_2=52   / SIP_PASS_2=321
SIP_NUMBER_3=3203 / SIP_PASS_3=123
```

В комментарии явно зафиксировано: абонент 3 (3203) — только цель вызова
в прокси-цепочке 9404→3203→52, **НЕ регистрируется**.

### 1.3 `server/config.ts`
Единая точка чтения конфигурации:

- `load_config(env = process.env): AppConfig` — чистая функция; env передаётся
  явно ради юнит-тестов без подмены модулей.
- `load_config_from_env(): AppConfig` — вызывает `dotenv.config()`
  (не перетирает уже заданные переменные окружения) и делегирует `load_config`.
- Тип `AppConfig`: `server_port`, `pbx_host`, `pbx_port`,
  `sip_protocol: 'udp' | 'tcp'`, `bridge_host`, `bridge_port`,
  `subscribers: [SubscriberConfig ×3]`.
- `SubscriberConfig`: `number`, `password`, `can_register` — у абонента 3
  (образец 3203) `can_register: false` («вызываемый, не регистрируется»).
- Валидация: порты — целые 1–65535; `SIP_PROTOCOL` строго `udp|tcp`
  (регистр не важен); номера — только цифры; хосты по маске
  `[a-zA-Z0-9._-]+`; пароли непустые.
- Все найденные проблемы собираются в массив и бросаются одним
  `ConfigError` — частичный конфиг не отдаётся никогда.

### 1.4 `tsconfig.json`
Модель task2: `target ES2020`, `module ESNext`, `moduleResolution bundler`,
`strict`, `noEmit`, `esModuleInterop`, `isolatedModules`, `useDefineForClassFields`,
`skipLibCheck`. Отличия: `lib: ["ES2020"]` без DOM (сервер, не браузер),
`types: ["node"]`, `include: ["server", "tests"]`.

### Дополнительно (в рамках каркаса)
- `server/main.ts` — минимальный бутстрап: загружает конфиг и печатает сводку
  запуска; с TODO-якорями на пункты 2.3 (WS-мост), 5 (express), 7 (REPL-терминал).
- `tests/unit/config.test.ts` — юнит-тест конфигурации на подменённом env.

## Приёмка (критерии пункта 1)

| Проверка | Результат |
|---|---|
| `npm run build` (`tsc --noEmit`) | ✅ без ошибок |
| `npm run test:unit` | ✅ 13/13 тестов зелёные (vitest, ~0.4 c) |
| `npm start` (smoke) | ✅ печатает: `АТС 192.168.80.157:5060 (udp), HTTP :3000, мост 192.168.80.159:8090, абоненты: 9404, 52, 3203(только вызов)` |

## Покрыто юнит-тестом (`tests/unit/config.test.ts`, 13 кейсов)

- полный разбор корректного окружения (образец `.env.example`);
- абонент 3 (3203): `can_register === false`, у 9404/52 — `true`;
- принятие `tcp` (в т.ч. `TCP`), отклонение неизвестного протокола;
- отклонение `SERVER_PORT` = `0`, `65536`, `abc`, `''`, `3000.5` (each-таблица);
- отклонение некорректного `PBX_PORT`;
- отклонение нецифрового номера (`52a`) и пустого пароля;
- отклонение пустого `PBX_HOST` и мусорного `BRIDGE_HOST` (`'bad host!'`);
- на пустом env собираются все ≥12 проблем сразу;
- явный `env` изолирует от `process.env` (проверка с намеренно битым
  `process.env.SERVER_PORT`).

## Созданные файлы

```
to/
  package.json
  tsconfig.json
  .env.example
  .env
  server/config.ts
  server/main.ts
  tests/unit/config.test.ts
```

## Следующий шаг

Пункт 2 плана — перенос SIP-кода из `task2/` в `server/sip/`
(пути импортов + snake_case-имена файлов, удаление веток `ws/wss`)
и портирование `bridge_main.ts`.
