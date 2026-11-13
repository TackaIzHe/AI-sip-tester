# task_34 — перенаправление INVITE по таблице регистраций (сверх плана, запрос пользователя)

## Запрос

Переопределить логику галочки «перенаправлять INVITE на адрес из INVITE»
(doc/task_32_plan_2.md): адресат больше не берётся из R-URI входящего INVITE.
Нам приходит `INVITE sip:123@…` — по номеру 123 ищем строку таблицы
регистраций (doc/task_33_plan_2.md) и подставляем её данные: идентификатор
линии `u00s00p00`, а UDP-адресатом — `address` строки. Инициатор определяется
по Contact входящего INVITE: там identifier линии, по нему в таблице находится
номер звонящего. Ответный INVITE: `From: sip:53@<наш_ip>`,
`To: sip:123@<наш_ip>` (наш IP = station_host).

Согласованные решения (вопрос-ответ + уточнение в сессии):
- идентификатор вызываемого — в R-URI исходящего INVITE:
  `INVITE sip:u00s00p00@<наш_ip>:<порт станции>` (форма та же, что у
  port-register REGISTER станции `sip:u00sXXpXX@наш:5060` — пир опознаёт
  линию по identifier, R-URI-домен = наш адрес);
- `From`/`To`/`Contact` — наш IP (station_host); адресат UDP-пакета — `address`
  строки таблицы;
- в пакет уходит и IP, откуда пришёл входящий INVITE: ОН становится вторым
  Via (second Via = src-адрес пира, как в ретрансляции doc/task_31_plan_2.md),
  но в отличие от task_31 в From/домене Call-ID он НЕ участвует (там — наш IP);
- маршрут не найден (номер не в таблице, у строки пуст/битый `address`,
  таблица не подключена) — INVITE НЕ съедается: возвращается мимикрии, пир
  получает прежний `405` (плюс строка-разъяснение в журнал вызова).

## План (согласован)

Движок `server/station/outbound.ts`:

- DI таблицы — `attach_registrations(store: RegistrationsApi)` + приватное
  поле (по образцу `SipStation.attach_registrations`, вне контракта
  `StationOutboundApi`); wire-up в `main.ts` (создание `StationRegistrations`
  переносится выше `StationOutbound`).
- `dial` — новые необязательные поля init (поведение task_30/task_31 по
  умолчанию не меняется):
  - `ruri?: string` — полный R-URI INVITE/CANCEL/ACK-на-не-2xx (по умолчанию
    `sip:callee@target` как сейчас);
  - `to_uri?: string` — To во всех запросах вызова (по умолчанию
    `sip:callee@target`/in-dialog `sip:callee@remote` — как сейчас);
  - `ruri_user?: string` — user in-dialog R-URI (ACK на 2xx/BYE, адресат —
    remote из Contact; по умолчанию callee);
  - `origin_via_only?: boolean` — origin уходит ТОЛЬКО вторым Via;
    From/домен Call-ID остаются станцией (в task_31 origin меняет и From —
    прежняя семантика сохраняется по умолчанию false).
- `on_invite_forward` — новая цепочка (флаг станции `forward_invite` тот же,
  retransmit-дедуп по Call-ID и in-dialog-гард живого вызова — прежние):
  1. callee = user из R-URI входящего INVITE (номер, напр. 123);
  2. строка таблицы `list().find(e => e.phone === callee)` — нет / пустой или
     битый `address` / таблица не подключена → `return false` (мимикрия
     ответит 405) + причина в журнал вызова;
  3. адресат = `uri_host_port(row.address)`; совпал с самой станцией —
     INVITE съедается без набора (защита от петли, прежняя ветка);
  4. caller: user из Contact входящего INVITE = identifier → поиск строки по
     `identifier` → `phone` звонящего; fallback — user из From входящего;
     оба пусты — caller по умолчанию (первый абонент конфига, как в dial);
  5. `dial({callee, caller, target: row.address, origin: peer_src,
     origin_via_only: true, ruri: sip:<row.identifier>@<station_host:port>,
     to_uri: sip:<callee>@<station_host>, ruri_user: row.identifier})`;
     R-URI in-dialog (ACK/BYE) — `sip:<identifier>@<remote>`, To — с нашим IP.

UI/сервер:

- `public/index.html` — подпись галочки: «перенаправлять INVITE по таблице
  регистраций» (+ шапка файла и комментарий функции); поведение опроса/POST —
  прежние.
- `server/controllers/station_controller.ts`, endpoint 35 — контракт не
  меняется (флаг станции), комментарий — новая семантика; `server/station/
  station.ts` — шапка описания флага; `doc/api.md` §20/§35 — текст режима.

Тесты:

- `tests/unit/station_outbound.test.ts` — описать заново describe
  перенаправления: стенд с `StationRegistrations` (строка callee → адрес
  peer-адресата, строка инициатора); ассерты: R-URI ретранслята
  `sip:u…@127.0.0.1:<порт станции>`, `To: <sip:номер@127.0.0.1>`,
  `From: <sip:номер-из-Contact@127.0.0.1>` (NOT origin), второй Via = src
  пира, UDP-адресат = `address` строки; отказ (нет строки / пустой address) →
  пиру `405` от мимикрии; retransmit/занятый/петля/флаг-выключен — прежние
  ветки под новой формой INVITE.
- Критерии: `npm run build`, `npm run test:unit`, `npm run test:api` —
  зелёные; приёмка на живой АТС — за стендом.

## Результат (выполнено)

Все пункты плана реализованы в точности; отклонений нет. Уточнения
пользователя, зафиксированные в контракте (повторялись в сессии — сверено
по байтам ретранслята в юните):

1. src, откуда пришёл входящий INVITE, уходит во ВТОРОЙ Via исходящего
   (верхний Via — станция);
2. `To`/`From`/`Contact` — наш IP (`STATION_HOST` = 192.168.80.159 в бою);
3. `From` — номер звонящего, найденный таблицей по identifier из `Contact`
   входящего (fallback — user из From, далее — абонент конфига).

Сделано:

- `server/station/outbound.ts`: `attach_registrations()` (DI таблицы),
  `DialInit` (ruri/to_uri/ruri_user/origin_via_only — по умолчанию байты
  task_30/31 не меняются), `OutCall.ruri/to_uri?/ruri_user` (_CANCEL/
  ACK-на-не-2xx — ruri INVITE; in-dialog ACK/BYE — `sip:<ruri_user>@remote`,
  To — to_uri), `on_invite_forward` переписан: строка по `phone` из R-URI →
  адресат+identifier, caller по identifier из Contact, маршрут не найден →
  `false` (мимикрия → 405, причина в журнал вызова), retransmit/занятый/
  петля — прежние съедающие ветки.
- `server/main.ts`: `outbound.attach_registrations(registrations)`;
  `server/station/station.ts`, контроллер, вкладка «Станция» (label галочки
  — «перенаправлять INVITE по таблице регистраций»), `doc/api.md` §20/§35 —
  тексты режима.
- Таблица читается через `RegistrationsApi.list().find(...)` — правок в
  `registrations.ts` не понадобилось.

Проверка критериев: `npm run build` зелёный; `npm run test:unit` 130/130
(в outbound-наборе 15 тестов: новый «маршрут не найден — 405»);
`npm run test:api` 101/101; `npm run format` применён. Приёмка на живой
АТС — за стендом.
