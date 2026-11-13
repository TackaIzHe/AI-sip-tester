// Тела-стимулы нагрузочных тестов (doc/los_mem/plan_test.md T1/T2).
//
// Формы тел скопированы с форм «как в логах станции» из doc/los_mem/res.md:
// T1 — dialog-info с дефектами разбора (кандидат A, blf_on_rx_notify: «no
// dialog el» / «no remote/identity el»), T2 — simple-list+xml со свойствами
// фиксированной длины при лимите 32 (кандидат B, ss_on_rx_notify: «value …
// len 137, allowed 32», «name … len 33, allowed 32»). Вариант «f» T1 —
// корректное тело (A/B-контроль error-пути, план §4 шаг 6).
// related: server/los_mem/scenarios.ts, doc/los_mem/plan_test.md §3 T1/T2.

/** Вариант тела dialog-info из плана T1 (a–e — дефекты, f — контроль). */
export type DialogInfoVariant = 'a' | 'b' | 'c' | 'd' | 'e' | 'f';

/** Порядок обхода вариантов при --variant=all (по плану a,b,c,d,e + f). */
export const DIALOG_INFO_VARIANTS: DialogInfoVariant[] = ['a', 'b', 'c', 'd', 'e', 'f'];

/** Content-Type тел T1 (план: верный, даже когда тело не-XML). */
export const DIALOG_INFO_CONTENT_TYPE = 'application/dialog-info+xml';

/** Content-Type тел T2 (SSW_SRVM event-list, как в логах res.md). */
export const SIMPLE_LIST_CONTENT_TYPE = 'application/simple-list+xml';

/**
 * Content-Type SSInfo NOTIFY в принятую SSW_SRVM-подписку станции (план 6
 * п.2, указание стороны АТС): разбором тела ведает модуль SSInfo, с
 * simple-list+xml сообщение не принималось (доводка по дампу 12.log).
 */
export const SSINFO_CONTENT_TYPE = 'application/ss-info+xml';

/** Полное корректное тело dialog-info (база для вариантов d/f). */
function dialog_info_ok(entity: string): string
{
    return (
        `<?xml version="1.0" encoding="UTF-8"?>\r\n` +
        `<dialog-info xmlns="urn:ietf:params:xml:ns:dialog-info" version="1" ` +
        `state="full" entity="sip:${entity}">\r\n` +
        `  <dialog id="los1" direction="initiated">\r\n` +
        `    <local><identity uri="sip:${entity}">${entity}</identity></local>\r\n` +
        `    <remote><identity uri="sip:52@${entity}">52</identity>` +
        `<session-description/></remote>\r\n` +
        `    <state>confirmed</state>\r\n` +
        `  </dialog>\r\n` +
        `</dialog-info>`
    );
}

/**
 * Тело NOTIFY для T1 по варианту плана §3:
 * - a — пустой `<dialog-info>` (нет элемента `<dialog>` → «no dialog el»);
 * - b — `<dialog>` без `<remote><identity>` («no remote/identity el»);
 * - c — не-XML (JSON) при верном Content-Type;
 * - d — обрезанный XML (обрыв на середине тега);
 * - e — корректное тело (лишний Content-Encoding навешивает сценарий);
 * - f — корректное тело (чистый контроль A/B).
 */
export function dialog_info_body(variant: DialogInfoVariant, entity = '9404'): string
{
    switch (variant)
    {
        case 'a':
            return (
                `<?xml version="1.0" encoding="UTF-8"?>\r\n` +
                `<dialog-info xmlns="urn:ietf:params:xml:ns:dialog-info" ` +
                `version="1" state="full" entity="sip:${entity}"></dialog-info>`
            );
        case 'b':
            return (
                `<?xml version="1.0" encoding="UTF-8"?>\r\n` +
                `<dialog-info xmlns="urn:ietf:params:xml:ns:dialog-info" version="1" ` +
                `state="full" entity="sip:${entity}">\r\n` +
                `  <dialog id="los1" direction="initiated">\r\n` +
                `    <local><identity uri="sip:${entity}">${entity}</identity></local>\r\n` +
                `    <state>confirmed</state>\r\n` +
                `  </dialog>\r\n` +
                `</dialog-info>`
            );
        case 'c':
            // Не-XML при верном Content-Type — парсер падает на разборе.
            return `{"state": "confirmed", "entity": "sip:${entity}"}`;
        case 'd':
            // Обрыв на середине тега: ровно пополам байтов корректного тела.
            return dialog_info_ok(entity).slice(
                0,
                Math.floor(dialog_info_ok(entity).length / 2),
            );
        case 'e':
        case 'f':
            return dialog_info_ok(entity);
        default:
            return dialog_info_ok(variant as string);
    }
}

/** Параметры simple_list_body (T2): длина и число свойств. */
export interface SimpleListOptions
{
    /** Сколько свойств в одном теле (гибрид c: 100–1000). */
    properties: number;
    /** Длина value в символах (137 — как в логах, лимит станции 32). */
    value_len: number;
    /** Длина name в символах (33 — как в логах, лимит станции 32). */
    name_len: number;
}

/**
 * Значение свойства ровно length символов: JSON с XML-сущностями `&quot;`.
 * База — ПОБАЙТОВАЯ копия триггера кейса B из логов станции
 * (`ss_on_rx_notify: … bad property list: value …, len 137, allowed 32`,
 * doc/los_mem/res.md, pbx_sip.1.log 2026-08-19 10:47:05.773): при 5-значном
 * prefix ровно 137 символов (12×`&quot;` + 65 обычных, сверено с дампом).
 * Экспорт — переиспользует SAS-движок (server/station/sas.ts).
 */
export function padded_value(prefix: string, length: number): string
{
    const core =
        `{&quot;prefix&quot;:&quot;${prefix}&quot;` +
        `,&quot;media&quot;:&quot;system://sounds/ring/default.wav&quot;` +
        `,&quot;ring&quot;:&quot;ring03&quot;}`;
    if (core.length >= length) return core.slice(0, length);
    return core + 'x'.repeat(length - core.length);
}

/**
 * Имя свойства ровно length символов (33 — sample из логов станции).
 * Экспорт — переиспользует SAS-движок (server/station/sas.ts).
 */
export function padded_name(index: number, length: number): string
{
    const sample = 'replace_category_from_redirection';
    const base = index === 0 ? sample : `prop_${index}_from_redirection`;
    if (base.length >= length) return base.slice(0, length);
    return base + '_'.repeat(length - base.length);
}

/**
 * Тело NOTIFY для T2: simple-list+xml с properties свойствами заданных
 * длин (значения с `&quot;` — 137 символов при лимите 32, имена — 33;
 * гибрид «сотни префиксов» — properties=100..1000). Схема свойств —
 * name/value парами, как их разбирает ss_on_rx_notify (res.md).
 */
export function simple_list_body(o: SimpleListOptions): string
{
    const items: string[] = [];
    for (let i = 0; i < o.properties; i++)
    {
        items.push(
            `  <item>\r\n` +
                `    <name>${padded_name(i, o.name_len)}</name>\r\n` +
                `    <value>${padded_value(String(67800 + i), o.value_len)}</value>\r\n` +
                `  </item>\r\n`,
        );
    }
    return (
        `<?xml version="1.0" encoding="UTF-8"?>\r\n` +
        `<simple-list xmlns="urn:ietf:params:xml:ns:simple-list" version="0">\r\n` +
        items.join('') +
        `</simple-list>`
    );
}

/** Дефектные IPC-сообщения subscribe (type 54) для T6: поле заведомо битое. */
export function ipc_subscribe_frames(count: number): string[]
{
    const frames: string[] = [];
    for (let i = 0; i < count; i++)
    {
        // Формат разборщика неизвестен (закрытая прошивка): кадр — type 54 +
        // мусорный payload; station-лог фиксирует «error 70004 (PJ_EINVAL)».
        const body = Buffer.from(
            `subscribe-losmem-${i}-${'x'.repeat(16)}`,
            'utf8',
        ).toString('hex');
        frames.push(`36${body.length / 2}${body}`.toUpperCase());
    }
    return frames;
}
