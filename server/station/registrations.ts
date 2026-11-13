// Таблица регистраций нижестоящей станции (doc/task_33_plan_2.md, запрос
// пользователя): массив объектов {номер, идентификатор линии u00s00p00,
// адрес прихода REGISTER, время}. Хранение — память процесса (конвенция
// проекта: как хранилище прогонов test_runs_controller и журнал станции —
// рестарт очищает); в будущем — источник маршрутизации вызовов в SAS-режиме
// (маршрутизация — следующая задача, здесь только справочник).
//
// Контракты и инварианты:
// - identifier — user из R-URI port-register REGISTER станции (11.log:
//   `sip:u00s00p00@наш:5060`), уникальный естественный ключ; сравнение
//   точное, БЕЗ нормализации регистра (дампы — нижний регистр; строка
//   «U00S00P00» даст вторую строку — сознательно, иначе правка оператора
//   тихо сливалась бы с другой линией);
// - id — стабильный автоинкрементный номер строки: identifier редактируем
//   руками, поэтому адресацией правки/удаления является именно id;
// - record() — идемпотентный upsert по identifier: retransmit REGISTER =
//   повторный вызов тех же данных (дедуп не нужен, в отличие от dial в
//   doc/task_32), refresh обновляет address/last_seen_at, телефон оператора
//   и id СОХРАНЯЕТ; REGISTER expires=0 строку не снимает (это справочник
//   линий, а не живое состояние регистрации — снятие только кнопкой UI);
// - наружу отдаются только копии записей (мутабельные строки класса из
//   хранилища не живут — иначе контроллер/страница правили бы массив мимо
//   контракта).
// related: server/station/station.ts (attach_registrations, REGISTER+SAS-
// ветка), server/controllers/station_controller.ts (эндпоинты 36-39),
// doc/api.md (раздел «Регистрации»).

/**
 * Строка таблицы регистраций (GET /api/station/registrations, вкладка
 * «Регистрации» страницы).
 */
export interface RegistrationEntry
{
    /** Автоинкрементный стабильный id (не меняется при правках identifier). */
    id: number;
    /** Идентификатор линии `u00s00p00` (user из R-URI REGISTER), уникален. */
    identifier: string;
    /** Номер, вводимый оператором; '' — ещё не заполнен. */
    phone: string;
    /** `host:port` src REGISTER (формат журнала StationEvent.peer); '' — не было. */
    address: string;
    /** ISO-время последнего REGISTER по identifier; '' — не приходил. */
    last_seen_at: string;
}

/**
 * DI-контракт хранилища регистраций (по образцу Station/StationSasApi):
 * контроллер и страница зависят только от него; REGISTER+SAS-ветка станции
 * зовёт лишь record().
 */
export interface RegistrationsApi
{
    /**
     * Копии записей в порядке вставки.
     */
    list(): RegistrationEntry[];
    /**
     * Ручная строка со страницы; бросает Error с русским текстом при дубле
     * identifier (контроллер кодирует в 409).
     */
    add(identifier: string, phone: string): RegistrationEntry;
    /**
     * Правка по id; undefined — нет такой строки (→ 404); бросает Error,
     * если новый identifier занят другой строкой (→ 409).
     */
    update(
        id: number,
        patch: { phone?: string; identifier?: string },
    ): RegistrationEntry | undefined;
    /**
     * Снятие строки кнопкой UI; false — нет такой строки (→ 404).
     */
    remove(id: number): boolean;
    /**
     * Автозаполнение из REGISTER станции (upsert по identifier, см. шапку);
     * пустой identifier — no-op.
     */
    record(identifier: string, address: string): void;
}

/**
 * Хранилище в памяти процесса (массив в порядке вставки, идемпотентные
 * правки — синхронные, как Map прогонов в test_runs_controller).
 */
export class StationRegistrations implements RegistrationsApi
{
    private readonly entries: RegistrationEntry[] = [];
    private seq = 0;

    /**
     * Копии записей в порядке вставки (контракт RegistrationsApi).
     */
    list(): RegistrationEntry[]
    {
        return this.entries.map((e) => ({ ...e }));
    }

    /**
     * Добавляет ручную строку; дубль identifier — Error с русским текстом.
     */
    add(identifier: string, phone: string): RegistrationEntry
    {
        if (this.find_by_identifier(identifier))
        {
            throw new Error(`Идентификатор «${identifier}» уже есть в таблице`);
        }
        const entry: RegistrationEntry = {
            id: (this.seq += 1),
            identifier,
            phone,
            address: '',
            last_seen_at: '',
        };
        this.entries.push(entry);
        return { ...entry };
    }

    /**
     * Применяет правку по id; undefined — строки нет, Error — identifier
     * занят другой строкой.
     */
    update(
        id: number,
        patch: { phone?: string; identifier?: string },
    ): RegistrationEntry | undefined
    {
        const entry = this.entries.find((e) => e.id === id);
        if (!entry) return undefined;
        if (patch.identifier !== undefined && patch.identifier !== entry.identifier)
        {
            const taken = this.find_by_identifier(patch.identifier);
            if (taken)
            {
                throw new Error(
                    `Идентификатор «${patch.identifier}» уже занят строкой ` +
                        `${taken.id} (номер ${taken.phone || '—'})`,
                );
            }
            entry.identifier = patch.identifier;
        }
        if (patch.phone !== undefined) entry.phone = patch.phone;
        return { ...entry };
    }

    /**
     * Удаляет строку по id; false — строки нет.
     */
    remove(id: number): boolean
    {
        const i = this.entries.findIndex((e) => e.id === id);
        if (i < 0) return false;
        this.entries.splice(i, 1);
        return true;
    }

    /**
     * Upsert приходящего REGISTER: существующая строка получает адрес и
     * время (телефон оператора сохраняется), новая заводится с пустым
     * телефоном; пустой identifier — no-op (R-URI без user — не линия).
     */
    record(identifier: string, address: string): void
    {
        if (identifier === '') return;
        const now = new Date().toISOString();
        const entry = this.find_by_identifier(identifier);
        if (entry)
        {
            entry.address = address;
            entry.last_seen_at = now;
            return;
        }
        this.entries.push({
            id: (this.seq += 1),
            identifier,
            phone: '',
            address,
            last_seen_at: now,
        });
    }

    private find_by_identifier(identifier: string): RegistrationEntry | undefined
    {
        return this.entries.find((e) => e.identifier === identifier);
    }
}
