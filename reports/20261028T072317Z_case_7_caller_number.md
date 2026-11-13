# Отчёт 20261028T072317Z_case_7_caller_number

Сгенерирован: 2026-10-28T07:23:17.973Z

- АТС: 192.168.80.157:5060 (udp)
- Номера: 9404, 52, 3203
- Вызов (исходящий): от 9404 → кому 3203
- Кейс: case_7_caller_number
- Вердикт: PASS — Calling party number у 52: входящий INVITE (цепочка 9404→3203→52) содержит номер вызывающего 9404

| # | Время | Абонент | Напр. | Этап | SIP | Call-ID | Детали |
|---|---|---|---|---|---|---|---|
| 1 | 2026-10-28 07:23:16Z | 9404 | · | state |  |  | состояние UNREGISTERED |
| 2 | 2026-10-28 07:23:16Z | 9404 | → АТС | register |  | uv936daqqaljhacfqloo | REGISTER от 9404 |
| 3 | 2026-10-28 07:23:16Z | 9404 | ← АТС | register | 200 | uv936daqqaljhacfqloo | 200 OK для REGISTER |
| 4 | 2026-10-28 07:23:16Z | 9404 | · | state |  |  | состояние REGISTERED, REGISTER отправлен |
| 5 | 2026-10-28 07:23:16Z | 52 | · | state |  |  | состояние UNREGISTERED |
| 6 | 2026-10-28 07:23:16Z | 52 | → АТС | register |  | q7q68nqtghriujuk9fhb | REGISTER от 52 |
| 7 | 2026-10-28 07:23:16Z | 52 | ← АТС | register | 200 | q7q68nqtghriujuk9fhb | 200 OK для REGISTER |
| 8 | 2026-10-28 07:23:16Z | 52 | · | state |  |  | состояние REGISTERED, REGISTER отправлен |
| 9 | 2026-10-28 07:23:16Z | 9404 | · | state |  |  | состояние CALL_OUT, собеседник 3203 |
| 10 | 2026-10-28 07:23:16Z | 9404 | → АТС | invite |  | uv9360kpbvdn2r7t2poj | INVITE → 3203 от 9404 |
| 11 | 2026-10-28 07:23:16Z | 9404 | ← АТС | invite | 100 | uv9360kpbvdn2r7t2poj | 100 Trying для INVITE |
| 12 | 2026-10-28 07:23:16Z | 9404 | ← АТС | invite | 183 | uv9360kpbvdn2r7t2poj | 183 Session Progress для INVITE |
| 13 | 2026-10-28 07:23:16Z | 9404 | ← АТС | ringing | 180 |  | 180 Ringing |
| 14 | 2026-10-28 07:23:16Z | 9404 | ← АТС | invite | 180 | uv9360kpbvdn2r7t2poj | 180 Ringing для INVITE |
| 15 | 2026-10-28 07:23:16Z | 9404 | ← АТС | ringing | 180 |  | 180 Ringing |
| 16 | 2026-10-28 07:23:16Z | 52 | ← АТС | invite |  | qdKO3SRuHovexwrizxDxRFRKaWOzBp97 | INVITE → 52 от 9404 |
| 17 | 2026-10-28 07:23:16Z | 52 | → АТС | invite | 100 | qdKO3SRuHovexwrizxDxRFRKaWOzBp97 | 100 Trying для INVITE |
| 18 | 2026-10-28 07:23:16Z | 52 | → АТС | invite | 180 | qdKO3SRuHovexwrizxDxRFRKaWOzBp97 | 180 Ringing для INVITE |
| 19 | 2026-10-28 07:23:16Z | 52 | ← АТС | call-in |  |  | INVITE от 9404 — входящий вызов |
| 20 | 2026-10-28 07:23:16Z | 52 | · | state |  |  | состояние CALL_IN, собеседник 9404 |
| 21 | 2026-10-28 07:23:16Z | 52 | → АТС | invite | 486 | qdKO3SRuHovexwrizxDxRFRKaWOzBp97 | 486 Busy Here для INVITE |
| 22 | 2026-10-28 07:23:16Z | 52 | · | call-ended |  |  | завершён (BYE) |
| 23 | 2026-10-28 07:23:16Z | 52 | · | state |  |  | состояние REGISTERED |
| 24 | 2026-10-28 07:23:16Z | 52 | ← АТС | ack |  | qdKO3SRuHovexwrizxDxRFRKaWOzBp97 | ACK → 52 от 9404 |
| 25 | 2026-10-28 07:23:17Z | 9404 | ← АТС | invite | 486 | uv9360kpbvdn2r7t2poj | 486 Busy Here для INVITE |
| 26 | 2026-10-28 07:23:17Z | 9404 | → АТС | ack |  | uv9360kpbvdn2r7t2poj | ACK → 3203 от 9404 |
| 27 | 2026-10-28 07:23:17Z | 9404 | ← АТС | call-ended | 486 |  | завершён с кодом 486 |
| 28 | 2026-10-28 07:23:17Z | 9404 | · | state |  |  | состояние REGISTERED, ошибка: 486 — Абонент занят |
| 29 | 2026-10-28 07:23:17Z | 9404 | → АТС | register |  | uv936daqqaljhacfqloo | REGISTER от 9404 |
| 30 | 2026-10-28 07:23:17Z | 9404 | ← АТС | register | 200 | uv936daqqaljhacfqloo | 200 OK для REGISTER |
| 31 | 2026-10-28 07:23:17Z | 9404 | · | state |  |  | состояние UNREGISTERED |
| 32 | 2026-10-28 07:23:17Z | 52 | → АТС | register |  | q7q68nqtghriujuk9fhb | REGISTER от 52 |
| 33 | 2026-10-28 07:23:17Z | 52 | ← АТС | register | 200 | q7q68nqtghriujuk9fhb | 200 OK для REGISTER |
| 34 | 2026-10-28 07:23:17Z | 52 | · | state |  |  | состояние UNREGISTERED |

**Вердикт: PASS**
