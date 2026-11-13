# task_35 — INVITE перенаправления по образцу pimer.md (сверх плана, запрос пользователя)

## Запрос

В `pimer.md` — дамп «эталонного» INVITE станции Coral pa_sip (.186 → .133):
`INVITE sip:u00s30p00@192.168.80.133:5060`, Via с портом в sent-by,
Max-Forwards: 69, From `"qwer" <sip:53@…;user=phone>`, To `<sip:123@…>`,
Allow, User-Agent Coral, полный SDP (PCMA/PCMU/101, sendrecv). Требование:
«вот так должен быть отправлен инвайт; вместо 192.168.80.186 нужно подставить
наш адрес».

Согласованные решения (вопрос-ответ сессии):

- охват — ТОЛЬКО перенаправление INVITE по таблице регистраций
  (режим `forward_invite`, task_32/34); прямой вызов с вкладки «Вызов»
  сохраняет байты task_30/31;
- SDP — полное тело образца (`o=`/`c=` = наш IP; RTP-порт формальный:
  медиа как и прежде не ходит, порт нужен нижестоящей станции принять offer);
- R-URI и Via — байт-в-байт как пример: `R-URI = sip:<identifier>@<адресат:порт>`
  (НЕ на наш IP, как было в task_34) и ОДИН Via — src отправителя на проводе
  не отображается (в статусе/журнале остаётся);
- отпечатки — `;user=phone` в From и `Allow:` из образца; User-Agent Coral и
  `P-Coral-Info: 040c tr002c` НЕ копируются (UA остаётся `station-outcall/1.0`,
  P-Coral-Info — привязка к чужому транку); display-name «qwer» опускается
  (имени линии у нас нет); padding пробелов в Content-Length не копируется;
  CSeq/branch/tag/Call-ID — наша прежняя генерация (RFC-совместима).

## План (согласован)

`server/station/outbound.ts`:

- модульные `coral_sdp(host)` (тело образца, чётный случайный RTP-порт и
  session-id фиксируются на вызов — retransmit `call.raw` байт-в-байт) и
  `build_coral_invite(init)` (порядок строк образца: Via `H:P` один,
  Max-Forwards 69, From `<sip:номер@H;user=phone>`, Contact после To, Allow
  образца, UA движка, Content-*);
- `DialInit.coral_style?: boolean` — ставит только `on_invite_forward`;
  в `dial()` при нём INVITE собирается `build_coral_invite`, `via_extra`
  пуст (CANCEL/ACK-на-не-2xx наследуют его — остаются одно-Via-зеркалом);
- `on_invite_forward`: `ruri` = `sip:<row.identifier>@<target:порт>`;
  to_uri/caller/дедуп/занятый/петля — без изменений.

Тесты: `tests/unit/station_outbound.test.ts` — describe перенаправления под
новые байты (R-URI на адресата, один Via с портом, 69, `;user=phone`, Allow,
SDP sendrecv вместо заглушки, origin в статусе сохраняется); тесты прямого
вызова не трогаются — доказательство неизменности байтов dial.

## Результат (выполнено)

Все пункты плана реализованы; отклонений нет.

Сделано:

- `server/station/outbound.ts`: константы `CORAL_ALLOW`/`CORAL_MAX_FORWARDS`,
  функции `coral_sdp()` и `build_coral_invite()` (только coral_style;
  `build_sip_request`/`raw_sip.ts` не менялись), `DialInit.coral_style`,
  ветки в `dial()` (сборка INVITE + `via_extra` пуст при coral_style),
  `on_invite_forward` — R-URI линии на адресате; шапка файла и JSDoc —
  новый контракт со ссылкой `pimer.md`.
- `tests/unit/station_outbound.test.ts` — ассерты перенаправления:
  `INVITE sip:u00s01p01@<адресат>`, `From: <sip:52@127.0.0.1;user=phone>`,
  `To: <sip:9404@127.0.0.1>`, ровно один Via `…127.0.0.1:<порт>;rport`,
  `Max-Forwards: 69`, `Allow: …` образца, `m=audio <порт> RTP/AVP 8 0 101` +
  `a=sendrecv` + `c=IN IP4 127.0.0.1`, `User-Agent: station-outcall/1.0`,
  `status().origin` по-прежнему заполнен.

Проверка критериев: `npm run build` зелёный; `npm run test:unit` 130/130;
`npm run test:api` 101/101 (REST-контракты не менялись, `doc/api.md` без
правок). Приёмка на живой АТС — за стендом: станция + таблица регистраций +
галочка «перенаправлять INVITE по таблице регистраций» → INVITE от пира на
номер из таблицы; дамп ушедшего пакета (вкладка «Вызов»/журнал) совпадает с
`pimer.md` с нашими адресами.
