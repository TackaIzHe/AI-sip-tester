# task_33 — таблица регистраций нижестоящей станции + вкладка «Регистрации» (сверх плана, запрос пользователя)

## Запрос

Создать таблицу для хранения регистраций (массив объектов): номер телефона
регистрации (указывает пользователь через веб-интерфейс, правка применяется к
массиву при изменении) и идентификатор, который приходит от нижестоящей станции
в формате `u00s00p00`. В будущем таблица будет использована для маршрутизации
вызовов в SAS-режиме (маршрутизация в этой задаче НЕ делается). Таблицу вынести
на веб-интерфейс отдельной вкладкой: у каждой регистрации — поля для ввода
номера и идентификатора. Дополнительно (уточнение пользователя): адрес, с
которого пришла регистрация, тоже сохраняется в таблице и отображается на
вкладке.

Согласованные решения (вопрос-ответ в сессии):
- строки появляются и автоматически (из приходящих REGISTER станции), и
  вручную (пользователь заводит строку сам);
- хранение — память процесса (конвенция проекта: прогоны test_runs, журнал
  станции — тоже память, рестарт очищает);
- автозахват — только в SAS-режиме станции.

## План (согласован)

Контракты — новый `server/station/registrations.ts`:

- `RegistrationEntry` = `{id: number; identifier: string; phone: string;
  address: string; last_seen_at: string}` — `id` стабильный автоинкрементный
  (адресация правки/удаления; identifier редактируем, поэтому ключом доступа
  не является), `identifier` — уникальный естественный ключ `u00s00p00`
  (user из R-URI REGISTER, регистр сохраняется как есть), `phone` — номер
  оператора ('' — не заполнен), `address` — `host:port` src REGISTER (формат
  журнала `StationEvent.peer`; '' — REGISTER не приходил), `last_seen_at` —
  ISO последнего REGISTER ('' — не приходил).
- DI-контракт `RegistrationsApi` + класс `StationRegistrations` (массив в
  памяти): `list()` — копии наружу; `add(identifier, phone)` — ручная строка,
  дубль identifier → `Error` с русским текстом (→ 409); `update(id, {phone?,
  identifier?})` — нет id → undefined (→ 404), identifier занят другой строкой
  → Error (→ 409); `remove(id)` — false → 404; `record(identifier, address)` —
  идемпотентный upsert по identifier: есть строка → обновляются только
  `address`/`last_seen_at` (телефон и id сохраняются), нет → новая строка;
  ретранслят REGISTER = повторный `record()` (дедуп не нужен), `expires=0`
  строку НЕ снимает (справочник линий, снятие — только кнопкой), пустой
  identifier — no-op.

Захват из REGISTER — `server/station/station.ts`:

- метод `attach_registrations(store)` + приватное поле (НЕ часть контракта
  `Station` — моки api-тестов не трогается); wire-up в `main.ts`.
- в REGISTER+SAS-ветке `handle_request` (уже есть `ruri` и `peer_str`): user
  из R-URI идомом `/^sips?:([^@:]+)@/i` (fallback — To), затем
  `registrations?.record(user, peer_str)` — до формирования 200.

REST (карта 35 → 39, внутри `station_controller`, подс-роутер под гейтом
`if (registrations)`, как stimulus/sas/outbound; валидация формы в контроллере
— 400, уникальность — Error из хранилища → 409):

- 36 `GET /api/station/registrations` → `200 {registrations: [...]}`;
- 37 `POST /api/station/registrations {"identifier","phone?"}` → `201
  {registration}`; 400 — identifier не по `IDENTIFIER_RE =
  /^[A-Za-z0-9._-]{1,64}$/`/пуст, phone не по `NUMBER_RE`; 409 — identifier
  уже есть;
- 38 `POST /api/station/registrations/:id/update {"phone?"|"identifier?"}`
  (≥1 поле) → `200 {registration}`; 400 — `:id` не целое/пустое тело/поля не
  по форме; 404 — нет строки; 409 — identifier занят другой строкой;
- 39 `DELETE /api/station/registrations/:id` → `200 {ok:true}`; 400 — `:id`
  не целое; 404 — нет строки.

DI: необязательное поле `registrations?: RegistrationsApi` в `AppDeps`/
`RouteDeps`, 5-й аргумент `station_controller`, в `main.ts` —
`new StationRegistrations()` + `station.attach_registrations(...)` +
передача в `create_app`. Без DI — честный 404 (конвенция проекта).

`public/index.html` — nav-кнопка `data-pane="registrations"` + `section.pane
registrations`: слева форма ручного добавления (identifier + номер + «добавить»)
и кнопка «обновить», справа таблица (`#reg-viewer`): identifier (input), номер
(input), адрес (текст), обновлён (текст), «удалить» (button). Правка input
применяется к массиву по событию `change` сразу (POST `/:id/update`). Опрос
2 с только на активной вкладке; анти-перетирание ввода: скелет таблицы строится
один раз, строки СИНХРОНИЗИРУЮТСЯ по `data-id` (не пересоздаются), значение
input присваивается только если он не `document.activeElement`, при неизменном
JSON ответа рендер пропускается вовсе.

Тесты: unit — хранилище (`registrations.test.ts`: add/update/remove,
уникальность, upsert `record()` с сохранением телефона, копии наружу) и
станция (`station_registrations.test.ts`: REGISTER в SAS → строка с адресом
пира; вне SAS — не пишется; re-REGISTER поверх ручной строки — телефон
сохраняется, адрес/время обновляются); api — `registrations.test.ts`
(CRUD-коды 200/201/400/404/409, честный 404 без DI; `make_api_app` расширяется
необязательным `registrations`, хранилище — реальный класс).

Документация: `doc/api.md` (счётчик 35→39, карта, секция «Регистрации» 36-39),
статус в CLAUDE.md, этот файл.

Критерии: `npm run build`, `npm run test:unit`, `npm run test:api` зелёные;
маршрутов 39 == задокументированных; ручная проверка вкладки без стенда
(добавить/править/удалить, опрос не перетирает ввод); автозахват на живой
АТС — за стендом.

## Что сделано

План выполнен полностью, отклонений от согласованного плана нет.

- `server/station/registrations.ts` — contracts + `StationRegistrations` по
  плану (массив в памяти, `seq` для стабильных id; `record()` — upsert: есть
  строка → только `address`/`last_seen_at`, нет → новая с `phone: ''`; пустой
  identifier — no-op; сравнение identifier точное, без нормализации регистра —
  отмечено в заголовке файла).
- `server/station/station.ts` — `attach_registrations()` (НЕ в контракте
  `Station` — моки `tests/api/*` не тронуты); в REGISTER+SAS-ветке
  `handle_request` перед 200: user из R-URI идомом
  `/^sips?:([^@:]+)@/i` (fallback — To), `registrations?.record(user,
  peer_str)`. Станция без attached-хранилища живёт как раньше (`?.`).
- `server/controllers/station_controller.ts` — 5-й необязательный параметр
  `registrations`, подс-роутер под `if (registrations)`: маршруты 36–39,
  коды/тексты — как в плане и `doc/api.md` (дубль/занятость — `Error` из
  хранилища → 409).
- DI: `registrations?` в `AppDeps` (`server/app.ts`) и `RouteDeps`
  (`server/routes.ts`, 5-й аргумент контроллера); `server/main.ts` —
  `new StationRegistrations()` + `attach_registrations` + `create_app`.
  Без DI — честный 404 (подтверждён api-тестом).
- `public/index.html` — nav-кнопка «Регистрации», `section.pane
  registrations` (форма ручного добавления + «обновить» + подсказка, таблица
  `#reg-viewer`: identifier/номер — input'ы, адрес/время — текст, «удалить» —
  кнопка с confirm). Правка применяется POST'ом `/:id/update` по `change`;
  опрос 2 с только на активной вкладке; анти-перетирание: каркас table один
  раз, строки синхронизируются по `tr[data-id]`, значение input — только если
  он не в фокусе, неизмененный JSON ответа — рендер пропускается.
- Тесты: `tests/unit/registrations.test.ts` (9), `tests/unit/station_registrations.test.ts`
  (4, реальный `SipStation` на loopback :0 + сырой UDP REGISTER образца 11.log),
  `tests/api/registrations.test.ts` (10; `make_api_app` — необязательный
  `registrations`, хранилище реальное, мокается только `Station`).
- Документация: `doc/api.md` — счётчик 35→39, карта 36–39, примечание о DI,
  секция «Регистрации»; статус-буллет в `CLAUDE.md`.

Проверка критериев: `npm run build` — зелёный; `npm run test:unit` — 129/129;
`npm run test:api` — 101/101 (прежние не изменились в поведении);
`grep -rE "router\.(get|post|delete)\(" server/controllers/ | wc -l` = 39 ==
задокументированных в `doc/api.md`. Разметка/JS вкладки синтаксически
проверены (`node --check` извлечённого `<script>`). Ручная приёмка вкладки и
автозахват с живой станции — за стендом.

Заметки для будущих сессий:
- маршруты монтируются только при станции И хранилище в DI; `record()`
  вызывается ДО отправки 200 — ошибки хранилища там не бросаются (upsert
  полон), REGISTER от этого не зависит;
- вкладка не показывает строки, пока не откроется: первый `load_registrations`
  — при входе на вкладку (по образцу «Вызов»);
- для маршрутизации в SAS-mode готовы `list()` (копии) и `identifier` как
  естественный ключ — интеграция SAS-движка здесь не делалась (вне запроса).
