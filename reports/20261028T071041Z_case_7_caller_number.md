# Отчёт 20261028T071041Z_case_7_caller_number

Сгенерирован: 2026-10-28T07:10:41.051Z

- АТС: 192.168.80.157:5060 (udp)
- Номера: 9404, 52, 3203
- Вызов (исходящий): от 9404 → кому 3203
- Кейс: case_7_caller_number
- Вердикт: FAIL — таймаут 15000 мс: входящий у 52 после INVITE на 3203 — сейчас REGISTERED

| # | Время | Абонент | Напр. | Этап | SIP | Call-ID | Детали |
|---|---|---|---|---|---|---|---|
| 1 | 2026-10-28 07:10:25Z | 9404 | · | state |  |  | состояние UNREGISTERED |
| 2 | 2026-10-28 07:10:25Z | 9404 | → АТС | register |  | 0n4ofsd5lcoto7fqqosd | REGISTER от 9404 |
| 3 | 2026-10-28 07:10:25Z | 9404 | ← АТС | register | 200 | 0n4ofsd5lcoto7fqqosd | 200 OK для REGISTER |
| 4 | 2026-10-28 07:10:25Z | 9404 | · | state |  |  | состояние REGISTERED, REGISTER отправлен |
| 5 | 2026-10-28 07:10:25Z | 52 | · | state |  |  | состояние UNREGISTERED |
| 6 | 2026-10-28 07:10:25Z | 52 | → АТС | register |  | n98s3lr95b25l5e46sq7 | REGISTER от 52 |
| 7 | 2026-10-28 07:10:25Z | 52 | ← АТС | register | 200 | n98s3lr95b25l5e46sq7 | 200 OK для REGISTER |
| 8 | 2026-10-28 07:10:25Z | 52 | · | state |  |  | состояние REGISTERED, REGISTER отправлен |
| 9 | 2026-10-28 07:10:25Z | 9404 | · | state |  |  | состояние CALL_OUT, собеседник 3203 |
| 10 | 2026-10-28 07:10:25Z | 9404 | → АТС | invite |  | 0n4of4ef14kle9k1ddb2 | INVITE → 3203 от 9404 |
| 11 | 2026-10-28 07:10:25Z | 9404 | ← АТС | invite | 100 | 0n4of4ef14kle9k1ddb2 | 100 Trying для INVITE |
| 12 | 2026-10-28 07:10:25Z | 9404 | ← АТС | invite | 183 | 0n4of4ef14kle9k1ddb2 | 183 Session Progress для INVITE |
| 13 | 2026-10-28 07:10:25Z | 9404 | ← АТС | ringing | 180 |  | 180 Ringing |
| 14 | 2026-10-28 07:10:25Z | 9404 | ← АТС | invite | 180 | 0n4of4ef14kle9k1ddb2 | 180 Ringing для INVITE |
| 15 | 2026-10-28 07:10:25Z | 9404 | ← АТС | ringing | 180 |  | 180 Ringing |
| 16 | 2026-10-28 07:10:27Z | 9404 | ← АТС | invite | 480 | 0n4of4ef14kle9k1ddb2 | 480 Temporarily Unavailable для INVITE |
| 17 | 2026-10-28 07:10:27Z | 9404 | → АТС | ack |  | 0n4of4ef14kle9k1ddb2 | ACK → 3203 от 9404 |
| 18 | 2026-10-28 07:10:27Z | 9404 | ← АТС | call-ended | 480 |  | завершён с кодом 480 |
| 19 | 2026-10-28 07:10:27Z | 9404 | · | state |  |  | состояние REGISTERED, ошибка: 480 — Абонент недоступен |
| 20 | 2026-10-28 07:10:41Z | 9404 | → АТС | register |  | 0n4ofsd5lcoto7fqqosd | REGISTER от 9404 |
| 21 | 2026-10-28 07:10:41Z | 9404 | ← АТС | register | 200 | 0n4ofsd5lcoto7fqqosd | 200 OK для REGISTER |
| 22 | 2026-10-28 07:10:41Z | 9404 | · | state |  |  | состояние UNREGISTERED |
| 23 | 2026-10-28 07:10:41Z | 52 | → АТС | register |  | n98s3lr95b25l5e46sq7 | REGISTER от 52 |
| 24 | 2026-10-28 07:10:41Z | 52 | ← АТС | register | 200 | n98s3lr95b25l5e46sq7 | 200 OK для REGISTER |
| 25 | 2026-10-28 07:10:41Z | 52 | · | state |  |  | состояние UNREGISTERED |

**Вердикт: FAIL**
