# task_36 — игнорирование Trying/Ringing после перенаправленного INVITE (сверх плана, запрос пользователя)

## Запрос

Добавить галочку, при включении которой мы будем игнорировать 100 Trying и
180 Ringing, приходящие после перенаправленного INVITE (режим `forward_invite`,
doc/task_34_plan_2.md/doc/task_35_plan_2.md: движок вызова dial()'ом шлёт
INVITE на адрес из таблицы регистраций, нижестоящая станция отвечает
промежуточными 1xx).

Согласованные решения (вопрос-ответ сессии):

- охват — ТОЛЬКО вызовы, поднятые перенаправлением; прямой вызов с вкладки
  «Вызов» работает как сейчас;
- игнорируются строго 100 и 180; прочие 1xx (183 и т.п.) обрабатываются
  по-прежнему;
- семантика «игнорировать»: ответ потребляется хуком движка (в `ignored`
  станции не попадает), но не влияет ни на что — без перехода `calling →
  ringing`, без счётчика `answered`, без `last_code/last_reason`; в журнал
  движка строка «← 100/180 … (игнорирован…)» (принцип «честно в журнале»).

## План (согласован)

Флаг — настройка станции, как `silent_invite`/`forward_invite`
(doc/task_29_plan_2.md/doc/task_32_plan_2.md): живёт между stop/start,
переключается в любом состоянии (409 нет).

1. `server/station/station.ts`: `StationStatus.ignore_provisional: boolean`;
   контракт `Station` — `ignore_provisional_mode()`/`set_ignore_provisional(on)`;
   `SipStation` — private флаг + поле в `status()`.
2. `server/station/outbound.ts`: `DialInit.forwarded?: boolean` и
   `OutCall.forwarded: boolean` (false по умолчанию); `on_invite_forward`
   ставит `forwarded: true`; в `on_response` (после совпадения Call-ID, до
   обновления счётчиков): INVITE-ответ 100/180 при `call.forwarded` и
   включённом флаге станции → строка лога «игнорирован» и потребление хуком
   без побочных эффектов; шапка файла — новый пункт контракта.
3. REST: `POST /api/station/ignore_provisional {"on":bool}` — контракт 1-в-1
   с `/silent_invite` (200 с полным статусом, 400 на не-boolean); карта
   маршрутов в шапке `server/routes.ts` (эндпоинт 40).
4. `public/index.html`: галочка `station-ignore-provisional` на вкладке
   «Станция» рядом с silent/forward («игнорировать Trying/Ringing после
   перенаправленного INVITE»), `ignore_provisional_set()` по образцу
   `forward_invite_set()`, синхронизация в поллере статуса, обработчик
   `change`, упоминание в заголовке.
5. Тесты: unit — round-trip флага (`station.test.ts`) и три сценария движка
   (`station_outbound.test.ts`: флаг ON + перенаправленный + 180 → `calling`,
   `answered` пуст, `last_code` 0, лог «игнорирован»; флаг OFF → `ringing`;
   флаг ON + прямой dial + 180 → `ringing`); api — `station.test.ts`
   200/эхо/400 + моки `Station` во всех api-файлах (2 метода + поле статуса).
6. Документация: `doc/api.md` — эндпоинт 40 + поле `ignore_provisional` в
   статусе, счётчик карты 39 → 40; `CLAUDE.md` — пункт «Сверх плана».

Критерий: `npm run build`, `npm run test:unit`, `npm run test:api` зелёные;
приёмка на живой АТС — за стендом (как task_30…35).

## Результат (выполнено)

Все пункты плана реализованы; отклонений нет.

Сделано:

- `server/station/station.ts`: `StationStatus.ignore_provisional`, методы
  контракта `Station` (`ignore_provisional_mode`/`set_ignore_provisional`),
  private-флаг `SipStation` (живёт между stop/start), поле в `status()`,
  пункт в шапке контрактов.
- `server/station/outbound.ts`: `DialInit.forwarded` и `OutCall.forwarded`
  (false по умолчанию), метка `forwarded: true` в `on_invite_forward`;
  в `on_response` — ветка игнора до обновления счётчиков: 100/180 на
  INVITE перенаправленного вызова при флаге станции → журнал
  «← 100/180 … (игнорирован: Trying/Ringing)» и `return true` (ни
  `calling→ringing`, ни `answered`, ни `last_code`; хук отвечает true —
  в `ignored` станции не попадает); пункт контракта в шапке.
- `server/controllers/station_controller.ts` + `server/routes.ts`: `POST
  /api/station/ignore_provisional {on}` — контракт 1-в-1 с silent_invite
  (200 с полным статусом, 400 на не-boolean, 409 нет); строка карты в
  шапке routes.ts.
- `public/index.html`: галочка `station-ignore-provisional` на вкладке
  «Станция» («игнорировать Trying/Ringing после перенаправленного INVITE»),
  `ignore_provisional_set()` (по образцу `forward_invite_set`), синхронизация
  в 2-с поллере (skip по disabled — клик не перебивается), обработчик
  `change`, упоминания в заголовке и HTML-комментарии.
- Тесты: unit — `station.test.ts` round-trip флага (134/134),
  `station_outbound.test.ts` описания игнора: флаг ON + перенаправленный +
  100+180 → `calling`/пустой `answered`/`last_code` 0/строка «игнорирован»/
  `ignored` станции не тронут, финал 486 обработан; флаг OFF → `ringing`;
  флаг ON + прямой dial + 180 → `ringing` (область). api —
  `station.test.ts` 200/эхо флага + 400 на не-boolean (103/103); моки
  `Station` дополнены во всех пяти api-файлах.
- Документация: `doc/api.md` — эндпоинт 40 (метод/тело/коды/curl), поле
  `ignore_provisional` в примере статуса и его описание, карта 39 → 40;
  `CLAUDE.md` — пункт «Сверх плана».

Проверка критериев: `npm run build` зелёный; `npm run test:unit` 134/134;
`npm run test:api` 103/103; `npm run format:check` чистый. Приёмка на живой
АТС — за стендом: станция + таблица регистраций + галочки «перенаправлять
INVITE…» и «игнорировать Trying/Ringing…» → INVITE от пира на номер из
таблицы; 100/180 от адресата на вкладке «Вызов» помечены «игнорирован»,
состояние не «звонит»; с выключенной галочкой — прежний `ringing`.
