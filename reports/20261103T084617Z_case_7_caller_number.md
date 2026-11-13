# Отчёт 20261103T084617Z_case_7_caller_number

Сгенерирован: 2026-11-03T08:46:17.164Z

- АТС: 192.168.80.157:5060 (udp)
- Номера: 9404, 52, 3203
- Вызов (исходящий): от 9404 → кому 3203
- Кейс: case_7_caller_number
- Вердикт: PASS — Calling party number у 52: входящий INVITE (цепочка 9404→3203→52) содержит номер вызывающего 9404

| # | Время | Абонент | Напр. | Этап | SIP | Call-ID | Детали |
|---|---|---|---|---|---|---|---|
| 1 | 2026-11-03 08:46:14Z | 9404 | · | state |  |  | состояние UNREGISTERED |
| 2 | 2026-11-03 08:46:14Z | 9404 | → АТС | register |  | jsd3cup6k4furk55l9tp | REGISTER от 9404 |
| 3 | 2026-11-03 08:46:14Z | 9404 | ← АТС | register | 200 | jsd3cup6k4furk55l9tp | 200 OK для REGISTER |
| 4 | 2026-11-03 08:46:14Z | 9404 | · | state |  |  | состояние REGISTERED, REGISTER отправлен |
| 5 | 2026-11-03 08:46:14Z | 52 | · | state |  |  | состояние UNREGISTERED |
| 6 | 2026-11-03 08:46:14Z | 52 | → АТС | register |  | docvhuoa35p74kbplc4m | REGISTER от 52 |
| 7 | 2026-11-03 08:46:14Z | 52 | ← АТС | register | 200 | docvhuoa35p74kbplc4m | 200 OK для REGISTER |
| 8 | 2026-11-03 08:46:14Z | 52 | · | state |  |  | состояние REGISTERED, REGISTER отправлен |
| 9 | 2026-11-03 08:46:14Z | 9404 | · | state |  |  | состояние CALL_OUT, собеседник 3203 |
| 10 | 2026-11-03 08:46:14Z | 9404 | → АТС | invite |  | jsd3cklkd9c3gr95776r | INVITE → 3203 от 9404 |
| 11 | 2026-11-03 08:46:14Z | 9404 | ← АТС | invite | 100 | jsd3cklkd9c3gr95776r | 100 Trying для INVITE |
| 12 | 2026-11-03 08:46:14Z | 9404 | ← АТС | invite | 183 | jsd3cklkd9c3gr95776r | 183 Session Progress для INVITE |
| 13 | 2026-11-03 08:46:14Z | 9404 | ← АТС | ringing | 180 |  | 180 Ringing |
| 14 | 2026-11-03 08:46:14Z | 9404 | ← АТС | invite | 180 | jsd3cklkd9c3gr95776r | 180 Ringing для INVITE |
| 15 | 2026-11-03 08:46:14Z | 9404 | ← АТС | ringing | 180 |  | 180 Ringing |
| 16 | 2026-11-03 08:46:15Z | 52 | ← АТС | invite |  | 4AtT97NKJcKOGZXabz-OIbLZRIKB2k.p | INVITE → 52 от 9404 |
| 17 | 2026-11-03 08:46:15Z | 52 | → АТС | invite | 100 | 4AtT97NKJcKOGZXabz-OIbLZRIKB2k.p | 100 Trying для INVITE |
| 18 | 2026-11-03 08:46:15Z | 52 | → АТС | invite | 180 | 4AtT97NKJcKOGZXabz-OIbLZRIKB2k.p | 180 Ringing для INVITE |
| 19 | 2026-11-03 08:46:15Z | 52 | ← АТС | call-in |  |  | INVITE от 9404 — входящий вызов |
| 20 | 2026-11-03 08:46:15Z | 52 | · | state |  |  | состояние CALL_IN, собеседник 9404 |
| 21 | 2026-11-03 08:46:15Z | 52 | → АТС | invite | 486 | 4AtT97NKJcKOGZXabz-OIbLZRIKB2k.p | 486 Busy Here для INVITE |
| 22 | 2026-11-03 08:46:15Z | 52 | · | call-ended |  |  | завершён (BYE) |
| 23 | 2026-11-03 08:46:15Z | 52 | · | state |  |  | состояние REGISTERED |
| 24 | 2026-11-03 08:46:15Z | 52 | ← АТС | ack |  | 4AtT97NKJcKOGZXabz-OIbLZRIKB2k.p | ACK → 52 от 9404 |
| 25 | 2026-11-03 08:46:16Z | 9404 | ← АТС | invite | 486 | jsd3cklkd9c3gr95776r | 486 Busy Here для INVITE |
| 26 | 2026-11-03 08:46:16Z | 9404 | → АТС | ack |  | jsd3cklkd9c3gr95776r | ACK → 3203 от 9404 |
| 27 | 2026-11-03 08:46:16Z | 9404 | ← АТС | call-ended | 486 |  | завершён с кодом 486 |
| 28 | 2026-11-03 08:46:16Z | 9404 | · | state |  |  | состояние REGISTERED, ошибка: 486 — Абонент занят |
| 29 | 2026-11-03 08:46:17Z | 9404 | → АТС | register |  | jsd3cup6k4furk55l9tp | REGISTER от 9404 |
| 30 | 2026-11-03 08:46:17Z | 9404 | ← АТС | register | 200 | jsd3cup6k4furk55l9tp | 200 OK для REGISTER |
| 31 | 2026-11-03 08:46:17Z | 9404 | · | state |  |  | состояние UNREGISTERED |
| 32 | 2026-11-03 08:46:17Z | 52 | → АТС | register |  | docvhuoa35p74kbplc4m | REGISTER от 52 |
| 33 | 2026-11-03 08:46:17Z | 52 | ← АТС | register | 200 | docvhuoa35p74kbplc4m | 200 OK для REGISTER |
| 34 | 2026-11-03 08:46:17Z | 52 | · | state |  |  | состояние UNREGISTERED |

**Вердикт: PASS**
