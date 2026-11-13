# task_37 — умножение приходящего INVITE ×10 при перенаправлении (сверх плана, запрос пользователя)

## Запрос

Режим, в котором приходящий INVITE умножается на 10: при включённой галочке
перенаправления (`forward_invite`, doc/task_34_plan_2.md) все десять копий
должны уйти на адресата разом.

Согласованные решения:

- множитель фиксирован — 10 (константа движка, не настройка REST/формы);
- режим — отдельная галочка-флаг станции `multiply_invite` (как
  silent_invite/forward_invite/ignore_provisional): живёт между stop/start,
  409 нет; без включённого `forward_invite` ни на что не влияет (INVITE
  мимикрия отвечает 405/молчание как раньше);
- адресат один — строка таблицы регистраций по номеру из R-URI (как сейчас);
  десять копий отличаются Call-ID/branch/From-tag (иначе станции слили бы
  их в одну транзакцию), байты — прежний образец pimer.md (task_35);
- «разом» — все десять INVITE отправляются в один synchronous-проход хука
  перенаправления;
- полнота транзакций: первая копия — обычный dial() (главный вызов,
  состояние/счётчики/кнопки как сейчас); остальные девять — «теневые»
  диалоги движка: свои retransmit INVITE (те же T1-таймеры), финал не-2xx →
  ACK той же веткой, 2xx → ACK + немедленный BYE (копия линию не держит),
  таймаут/завершение — копия снимается; состояние движка и answered/
  last_code — по главному вызову, судьба копий — журнал движка;
- «отбой» (cancel) и abort/останов гасят и копии (CANCEL/BYE best-effort);
  `ignore_provisional` действует и на копии (они тоже `forwarded`);
- занятость/дедуп: retransmit исходного INVITE и новый вызов на занятом
  движке — прежние ветки (съедаются без нового набора).

## План (согласован)

1. `server/station/station.ts`: `StationStatus.multiply_invite: boolean`;
   контракт `Station` — `multiply_invite_mode()`/`set_multiply_invite(on)`;
   `SipStation` — private флаг (по образцу `ignore_provisional`); шапка —
   пункт контракта.
2. `server/station/outbound.ts`:
   - константа `FORWARD_MULTIPLY_COPIES = 10`;
   - вынести сборку диалога из `dial()` в `build_call(init, target)`
     (валидация callee/сокета/состояния остаётся в dial; байты не меняются);
   - `ShadowCall { call, phase: 'calling'|'terminating', invite_timer,
     bye_timer, invite_done }` + `shadows: Map<call_id, ShadowCall>`;
   - `start_shadow(init)`: build_call → свой Call-ID/branch/tags, отправка,
     `shadow_arm_invite` (retransmit как у главного);
   - `on_invite_forward`: после dial() первой копии — цикл
     `multiply_invite_mode() ? 9 : 0` теней; строка журнала с «×10»;
   - `on_response`/`on_incoming`: диспетч по Call-ID — главный/тень/чужой;
     ветки тени: ignore_provisional (100/180), финал ≥300 → ACK+снятие,
     2xx → ACK+`shadow_send_bye`, BYE/ACK пира в диалог копии — потребление
     (BYE → 200+снятие), повтор финала — повтор ACK на 2xx;
   - `cancel()` — CANCEL всем копиям в phase 'calling' (одноразово,
     best-effort, финал ждёт on_shadow_response для ACK); `abort()` —
     CANCEL/BYE копиям + снятие таймеров; `finish()` — хук снимается через
     `maybe_release_hook()` (только idle И пустые тени); повторный dial при
     живых тенях хук повторно не навешивается;
   - `OutboundStatus.multiplied_active: number` — живые копии;
   - опциональный параметр `count` у `send_raw` — отправки копий не
     раздувают счётчик `sent` главного вызова (логируются наравне);
   - шапка файла — новый пункт контракта.
3. REST: `POST /api/station/multiply_invite {"on":bool}` — контракт 1-в-1
   с `/silent_invite` (200 с полным статусом, 400 на не-boolean); карта
   маршрутов `server/routes.ts` (эндпоинт 41).
4. `public/index.html`: галочка `station-multiply-invite` на вкладке
   «Станция» («умножать перенаправляемый INVITE ×10»),
   `multiply_invite_set()` по образцу `ignore_provisional_set()`,
   синхронизация в поллере статуса, обработчик `change`, заголовок.
5. Тесты:
   - unit `station.test.ts` — round-trip флага;
   - unit `station_outbound.test.ts` — fanout: 10 INVITE с разными Call-ID
     (байты образца, `multiplied_active` 9); 486 каждому → ACK каждому и
     copies→0 с оставленным главным; 200 копии → ACK+BYE; cancel → CANCEL
     всем; таймаут копий (урезанный T1) → снятие, хук отпущен; множитель
     OFF / forward OFF — прежнее поведение;
   - api `station.test.ts` — 200/эхо/400 + обновление моков `Station`
     (2 метода + поле статуса) и `MockOutbound.status()` (multiplied_active).
6. Документация: `doc/api.md` — эндпоинт 41 + поля `multiply_invite`
   (GET /api/station) и `multiplied_active` (GET /api/station/call), карта
   40 → 41; `CLAUDE.md` — пункт «Сверх плана».

Критерий: `npm run build`, `npm run test:unit`, `npm run test:api` зелёные;
приёмка на живой АТС — за стендом (как task_30…36).

## Результат (2026-11-13)

Выполнено по плану; критерий зелёный: `npm run build` чисто, unit 145 /
api 105 (всего 250), Prettier чисто. Приёмка на живой АТС — за стендом.

- `server/station/station.ts`: `StationStatus.multiply_invite`, контракт
  `multiply_invite_mode`/`set_multiply_invite`, private-флаг `SipStation`
  (живёт между stop/start), пункт контракта в шапке.
- `server/station/outbound.ts`: константа `FORWARD_MULTIPLY_COPIES = 10`;
  сборка диалога вынесена из `dial()` в `build_call(init, target)` (байты
  1-в-1, каждая копия получает свои Call-ID/branch/From-tag);
  `ShadowCall` + карта `shadows`; `start_shadow`/`shadow_arm_invite`
  (retransmit с удвоением как у главного); в `on_invite_forward` фан-аут
  — synchronous-проход хука (главный dial + девять теней), строка журнала
  «×10 (умножение)»; `on_response`/`on_incoming` — диспетч по Call-ID
  (главный/тень/чужой); ветки копии: ignore_provisional, не-2xx финал →
  ACK той же веткой + снятие, 2xx → ACK + немедленный BYE, BYE/ACK пира —
  потребление; `cancel()` — CANCEL копиям в phase 'calling' + таймер
  ожидания финала; `abort()` — best-effort CANCEL/BYE копиям и зачистка
  таймеров; `send_raw(..., count)` — отправки копий не раздувают `sent`
  главного; `OutboundStatus.multiplied_active` — живые копии; хук
  отпускается `maybe_release_hook()` (idle И карта теней пуста), повторный
  dial при живых тенях хук повторно не навешивает.
- REST: `POST /api/station/multiply_invite {"on"}` (200 с полным статусом,
  400 на не-boolean) — контракт 1-в-1 с `/silent_invite`; карта
  `routes.ts` — эндпоинт 41.
- `public/index.html`: галочка вкладки «Станция» «умножать перенаправляемый
  INVITE ×10» + `multiply_invite_set()` + синхронизация в поллере.
- `doc/api.md`: секция 41, поля `multiply_invite` (`GET /api/station`) и
  `multiplied_active` (`GET /api/station/call`), карта 40 → 41.

Тесты: unit `station_outbound.test.ts` — 9 новых (×10 разом: десять разных
Call-ID/branch/From-tag, `multiplied_active` 9, журнал «×10»; 180 на копию
— главный неизменен; не-2xx копии — ACK той же веткой и снятие, главный
жив; 200 копии — ACK + немедленный BYE, снятие по 200 на BYE; «отбой» —
десять CANCEL с разными Call-ID; abort — idle и 0 копий; главный завершён
раньше копий — хук держится, финал копии всё ещё ACK-ится; урезанный T1 —
все девять сняты по таймауту; флаг OFF — одиночное перенаправление).
unit `station.test.ts` — round-trip флага + 405 мимикрии без перена-
правления. api `station.test.ts` — 200/эхо флага/400; моки `Station` всех
api-файлов дополнены (2 метода + поле статуса), `MockOutbound` —
`multiplied_active`.

Отклонения от плана:

- `ShadowCall.phase` получил третье значение `'cancelling'` (в плане two):
  отменённая копия обязана дождаться финала INVITE, чтобы ответить ACK, —
  иначе станция шлёт финал до 64·T1;
- плановый тест «486 каждому → копии→0 с оставленным главным» разбит на
  отдельные проверки (не-2xx одной копии с живым главным; снятие всех
  девяти по урезанному T1) — ассерты эквивалентны, прогон быстрее;
- отправки копий (retransmit/ACK/BYE) пишутся в журнал движка наравне с
  главным, но не двигают счётчики `sent`/`answered` (параметр `count`
  `send_raw`) — счётчики остаются характеристиками главного вызова.
