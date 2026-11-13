# Отчёт 20261028T071959Z_case_7_caller_number

Сгенерирован: 2026-10-28T07:19:59.583Z

- АТС: 192.168.80.157:5060 (udp)
- Номера: 9404, 52, 3203
- Вызов (исходящий): от 9404 → кому 3203
- Кейс: case_7_caller_number
- Вердикт: FAIL — таймаут 15000 мс: входящий у 52 после INVITE на 3203 — сейчас REGISTERED

| # | Время | Абонент | Напр. | Этап | SIP | Call-ID | Детали |
|---|---|---|---|---|---|---|---|
| 1 | 2026-10-28 07:19:44Z | 9404 | · | state |  |  | состояние UNREGISTERED |
| 2 | 2026-10-28 07:19:44Z | 9404 | → АТС | register |  | d85jhks5faj97tdm0l05 | REGISTER от 9404 |
| 3 | 2026-10-28 07:19:44Z | 9404 | ← АТС | register | 200 | d85jhks5faj97tdm0l05 | 200 OK для REGISTER |
| 4 | 2026-10-28 07:19:44Z | 9404 | · | state |  |  | состояние REGISTERED, REGISTER отправлен |
| 5 | 2026-10-28 07:19:44Z | 52 | · | state |  |  | состояние UNREGISTERED |
| 6 | 2026-10-28 07:19:44Z | 52 | → АТС | register |  | 5t6f7icng0qofjl04cgb | REGISTER от 52 |
| 7 | 2026-10-28 07:19:44Z | 52 | ← АТС | register | 200 | 5t6f7icng0qofjl04cgb | 200 OK для REGISTER |
| 8 | 2026-10-28 07:19:44Z | 52 | · | state |  |  | состояние REGISTERED, REGISTER отправлен |
| 9 | 2026-10-28 07:19:44Z | 9404 | · | state |  |  | состояние CALL_OUT, собеседник 3203 |
| 10 | 2026-10-28 07:19:44Z | 9404 | → АТС | invite |  | d85jhhtr5utrudrdtkoe | INVITE → 3203 от 9404 |
| 11 | 2026-10-28 07:19:44Z | 9404 | ← АТС | invite | 100 | d85jhhtr5utrudrdtkoe | 100 Trying для INVITE |
| 12 | 2026-10-28 07:19:44Z | 9404 | ← АТС | invite | 183 | d85jhhtr5utrudrdtkoe | 183 Session Progress для INVITE |
| 13 | 2026-10-28 07:19:44Z | 9404 | ← АТС | ringing | 180 |  | 180 Ringing |
| 14 | 2026-10-28 07:19:44Z | 9404 | ← АТС | invite | 180 | d85jhhtr5utrudrdtkoe | 180 Ringing для INVITE |
| 15 | 2026-10-28 07:19:44Z | 9404 | ← АТС | ringing | 180 |  | 180 Ringing |
| 16 | 2026-10-28 07:19:45Z | 9404 | ← АТС | invite | 480 | d85jhhtr5utrudrdtkoe | 480 Temporarily Unavailable для INVITE |
| 17 | 2026-10-28 07:19:45Z | 9404 | → АТС | ack |  | d85jhhtr5utrudrdtkoe | ACK → 3203 от 9404 |
| 18 | 2026-10-28 07:19:45Z | 9404 | ← АТС | call-ended | 480 |  | завершён с кодом 480 |
| 19 | 2026-10-28 07:19:45Z | 9404 | · | state |  |  | состояние REGISTERED, ошибка: 480 — Абонент недоступен |
| 20 | 2026-10-28 07:19:59Z | 9404 | → АТС | register |  | d85jhks5faj97tdm0l05 | REGISTER от 9404 |
| 21 | 2026-10-28 07:19:59Z | 9404 | ← АТС | register | 200 | d85jhks5faj97tdm0l05 | 200 OK для REGISTER |
| 22 | 2026-10-28 07:19:59Z | 9404 | · | state |  |  | состояние UNREGISTERED |
| 23 | 2026-10-28 07:19:59Z | 52 | → АТС | register |  | 5t6f7icng0qofjl04cgb | REGISTER от 52 |
| 24 | 2026-10-28 07:19:59Z | 52 | ← АТС | register | 200 | 5t6f7icng0qofjl04cgb | 200 OK для REGISTER |
| 25 | 2026-10-28 07:19:59Z | 52 | · | state |  |  | состояние UNREGISTERED |

**Вердикт: FAIL**
