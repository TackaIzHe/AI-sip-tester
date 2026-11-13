# Отчёт 20261028T072034Z_case_7_caller_number

Сгенерирован: 2026-10-28T07:20:34.255Z

- АТС: 192.168.80.157:5060 (udp)
- Номера: 9404, 52, 3203
- Вызов (исходящий): от 9404 → кому 3203
- Кейс: case_7_caller_number
- Вердикт: FAIL — таймаут 15000 мс: входящий у 52 после INVITE на 3203 — сейчас REGISTERED

| # | Время | Абонент | Напр. | Этап | SIP | Call-ID | Детали |
|---|---|---|---|---|---|---|---|
| 1 | 2026-10-28 07:20:19Z | 9404 | · | state |  |  | состояние UNREGISTERED |
| 2 | 2026-10-28 07:20:19Z | 9404 | → АТС | register |  | i9b44utame4s954rbct9 | REGISTER от 9404 |
| 3 | 2026-10-28 07:20:19Z | 9404 | ← АТС | register | 200 | i9b44utame4s954rbct9 | 200 OK для REGISTER |
| 4 | 2026-10-28 07:20:19Z | 9404 | · | state |  |  | состояние REGISTERED, REGISTER отправлен |
| 5 | 2026-10-28 07:20:19Z | 52 | · | state |  |  | состояние UNREGISTERED |
| 6 | 2026-10-28 07:20:19Z | 52 | → АТС | register |  | pqe11d3l6pbu7639bc8h | REGISTER от 52 |
| 7 | 2026-10-28 07:20:19Z | 52 | ← АТС | register | 200 | pqe11d3l6pbu7639bc8h | 200 OK для REGISTER |
| 8 | 2026-10-28 07:20:19Z | 52 | · | state |  |  | состояние REGISTERED, REGISTER отправлен |
| 9 | 2026-10-28 07:20:19Z | 9404 | · | state |  |  | состояние CALL_OUT, собеседник 3203 |
| 10 | 2026-10-28 07:20:19Z | 9404 | → АТС | invite |  | i9b443hed0v9udn06auk | INVITE → 3203 от 9404 |
| 11 | 2026-10-28 07:20:19Z | 9404 | ← АТС | invite | 100 | i9b443hed0v9udn06auk | 100 Trying для INVITE |
| 12 | 2026-10-28 07:20:19Z | 9404 | ← АТС | invite | 183 | i9b443hed0v9udn06auk | 183 Session Progress для INVITE |
| 13 | 2026-10-28 07:20:19Z | 9404 | ← АТС | ringing | 180 |  | 180 Ringing |
| 14 | 2026-10-28 07:20:19Z | 9404 | ← АТС | invite | 180 | i9b443hed0v9udn06auk | 180 Ringing для INVITE |
| 15 | 2026-10-28 07:20:19Z | 9404 | ← АТС | ringing | 180 |  | 180 Ringing |
| 16 | 2026-10-28 07:20:20Z | 9404 | ← АТС | invite | 480 | i9b443hed0v9udn06auk | 480 Temporarily Unavailable для INVITE |
| 17 | 2026-10-28 07:20:20Z | 9404 | → АТС | ack |  | i9b443hed0v9udn06auk | ACK → 3203 от 9404 |
| 18 | 2026-10-28 07:20:20Z | 9404 | ← АТС | call-ended | 480 |  | завершён с кодом 480 |
| 19 | 2026-10-28 07:20:20Z | 9404 | · | state |  |  | состояние REGISTERED, ошибка: 480 — Абонент недоступен |
| 20 | 2026-10-28 07:20:34Z | 9404 | → АТС | register |  | i9b44utame4s954rbct9 | REGISTER от 9404 |
| 21 | 2026-10-28 07:20:34Z | 9404 | ← АТС | register | 200 | i9b44utame4s954rbct9 | 200 OK для REGISTER |
| 22 | 2026-10-28 07:20:34Z | 9404 | · | state |  |  | состояние UNREGISTERED |
| 23 | 2026-10-28 07:20:34Z | 52 | → АТС | register |  | pqe11d3l6pbu7639bc8h | REGISTER от 52 |
| 24 | 2026-10-28 07:20:34Z | 52 | ← АТС | register | 200 | pqe11d3l6pbu7639bc8h | 200 OK для REGISTER |
| 25 | 2026-10-28 07:20:34Z | 52 | · | state |  |  | состояние UNREGISTERED |

**Вердикт: FAIL**
