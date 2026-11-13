# task_2 — журнал работ (продолжение: plan.md → plan_2.md)

Журнал сессий по плану [`plan_2.md`](plan_2.md). Дата абсолютная.

## Сессия 2026-10-27 (п.1–2 плана)

### п.1 — каркас и конфиг (выполнено ранее в этот день)

`package.json` (скрипты start/build/test:*), `.env`/`.env.example`,
`tsconfig.json` (модель task2), `server/config.ts` с валидацией и
юнит-тестами `tests/unit/config.test.ts`. Критерии: `npm run build` зелёный,
тест конфига зелёный — подтверждено.

### п.2 — перенос SIP-кода из task2 (эта сессия)

Перенесено в `server/sip/` (пути импортов + snake_case-имена файлов, логика без смен):

| Файл | Откуда | Правки |
|---|---|---|
| `state.ts` | `task2/src/state.ts` | только шапка/пути |
| `sip_client.ts` | `task2/src/sipClient.ts` | фабрика транспорта обязательна (дефолтной ws/bridge-фабрики нет) |
| `transport.ts` | `task2/src/transport.ts` | убраны `createTransport` и ветки ws/wss/bridge; добавлен тип `SipTransport` |
| `sip_text.ts` | `task2/src/sipText.ts` | только шапка + ссылки `doc/sip_rfc.md §7` |
| `config.ts` | `task2/src/config.ts` | упрощён до host/sip_port/number/password/transport (план §2.1) |
| `classic_transport.ts` | `task2/bridge/classicTransport.ts` | `proto` берётся из `cfg.transport`; ссылки RFC |
| `sip_node_transport.ts` | `task2/bridge/sipNodeTransport.ts` | только шапка/ссылки (rport, фрейминг TCP) |
| `session.ts` | `task2/bridge/session.ts` | `PhoneConfig` упрощённый, `transport` из команды register |
| `protocol.ts` | `task2/bridge/protocol.ts` | только шапка |
| `../bridge_main.ts` | `task2/bridge/main.ts` | host/port из `.env` (`BRIDGE_HOST:BRIDGE_PORT`), heartbeat/ graceful без смен |

Отклонения от целевой структуры плана (обоснованные):

1. **Добавлен `server/sip/sip_ua_transport.ts`** — перенос `task2/src/wsTransport.ts`
   под именем `SipUaTransport`. Машина `UserAgent` sip.js (регистрации с Digest,
   сессии, SDP-заглушка `m=audio 9`+`a=inactive`, Contact user=номер) нужна
   `classic_transport.ts` 1-в-1; в целевом списке плана файла не было, а без него
   перенос «без смены логики» невозможен. WS-ветка (`ws://…/ws` URL) убрана —
   транспорт инжектируется через `transportConstructor`.
2. **Добавлен `server/sip/debug.ts`** — упрощённый `task2/src/debug.ts`
   (`SIP_DEBUG=1`), сервер всегда Node.
3. `tsconfig.json`: в `include` добавлены `bridge_main.ts` и `e2e_runner.ts`
   (файлы плана в корне `to/`, иначе не проходят типизацию).

### Проверка п.2 (критерии плана)

- `npm run build` (`tsc --noEmit`) — без ошибок.
- `tests/unit/state.test.ts` (перенос `task2/tests/state.test.ts`) + тест конфига —
  20/20 зелёные (`npx vitest run tests/unit`).
- Рантайм-дым моста без АТС: `BRIDGE_HOST=127.0.0.1 BRIDGE_PORT=18090 tsx bridge_main.ts`
  — WS подключается, приходит стартовый `state{unregistered}` и `pong` на keepalive;
  битый JSON не роняет мост.

### Симптом → причина → решение

Дефектов в этой сессии не вскрывалось; перенос механический. На будущее зафиксированы
грабли в перенесённых комментариях: `rport` в Via (иначе REGISTER теряется),
viaHost без порта (SanityCheck sip.js), Contact user=номер (401 на INVITE),
`m=audio 9` (иначе 488).
