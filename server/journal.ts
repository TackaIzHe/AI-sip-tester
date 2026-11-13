// Журнал SIP-событий и генерация отчётов (plan_2.md п.3).
//
// Источники событий (п.3.1):
//  - attach_phone      — снапшоты стейт-машины (server/sip/state.ts);
//  - attach_transport  — события транспорта (server/sip/transport.ts: incoming,
//                        ringing, established, terminated, …);
//  - on_sip_message    — сырые SIP-сообщения сокета (hook on_trace у
//                        SipNodeTransport): REGISTER, 401/407, 200, INVITE,
//                        100/180, 200+ACK, BYE, CANCEL, 480/486/487 — полная
//                        протокольная цепочка 1-в-1 (doc/sip_rfc.md §7).
//
// Рендер (п.3.2): render_report() пишет reports/<UTC-ts>_<case>.{json,md,html} —
// шапка (адрес АТС, протокол, номера, участники вызовов: от кого/кому) +
// таблица этапов + вердикт PASS/FAIL.

import fs from 'node:fs';
import path from 'node:path';
import type { PhoneStateMachine } from './sip/state';
import type { Transport } from './sip/transport';

// ---------- модель журнала ----------

/** Направление: от абонента сервера к АТС / обратно / внутреннее событие телефона. */
export type JournalDirection = 'in' | 'out' | 'internal';

/** Одно событие журнала (plan_2.md п.3.1). */
export interface JournalEvent
{
    /** Метка времени, мс с эпохи (Date.now). */
    ts: number;
    /** Сессия/абонент: номер или метка WS-клиента моста. */
    session: string;
    direction: JournalDirection;
    /**
     * Вид события: метод SIP-транзакции в нижнем регистре для сообщений сети
     * ('register', 'invite', 'ack', 'bye', 'cancel', …) и служебные вехи
     * ('state', 'call-in', 'ringing', 'call-established', 'call-ended',
     * 'transport-lost', 'registration-lost', 'sip-other').
     */
    kind: string;
    /** SIP-код ответа (для ответов станции). */
    sip_code?: number;
    /** Человекочитаемое описание этапа. */
    detail: string;
    /** Call-ID диалога/транзакции (пусто, если сообщения нет). */
    call_id: string;
}

/** Вердикт прогона (ассерт — задача e2e-раннера, п.8; журнал лишь фиксирует). */
export type ReportVerdict = 'PASS' | 'FAIL';

/** Участник вызова в шапке отчёта: от кого и кому (из реестра пула, п.4.2). */
export interface ReportCall
{
    from: string;
    to: string;
    /** out — наш абонент отправил вызов, in — вызов пришёл нашему абоненту. */
    direction: 'out' | 'in';
}

/** Шапка отчёта: параметры стенда и итог. */
export interface ReportMeta
{
    /** Имя кейса для имени файла и заголовка: 'case_1', 'probe', … */
    case: string;
    verdict: ReportVerdict;
    /** Комментарий вердикта (что подтверждено/почему FAIL). */
    verdict_text?: string;
    pbx_host: string;
    pbx_port: number;
    sip_protocol: string;
    /** Участствующие номера (образец: 9404, 52, 3203). */
    subscribers: string[];
    /** Вызовы прогона: кому отправлялись и от кого приходили (шапка, строка на вызов). */
    calls?: ReportCall[];
}

/** Пути созданных файлов отчёта; id — база имени для /api/reports/:id (п.5). */
export interface ReportFiles
{
    id: string;
    dir: string;
    json_path: string;
    md_path: string;
    html_path: string;
}

export interface JournalOptions
{
    /** Каталог отчётов (по умолчанию ./reports — резолвится от cwd процесса). */
    reports_dir?: string;
    /** Часы (для тестов). */
    now?: () => number;
}

/** Доп. поля log(). */
export interface LogExtra
{
    code?: number;
    detail?: string;
    call_id?: string;
}

// ---------- разбор сырых SIP-сообщений ----------

/** Минимальный разбор первой строки и заголовков (транзакции считает sip.js). */
interface SipHead
{
    is_request: boolean;
    /** Метод запроса (REQUEST) или метод из CSeq для ответа. */
    method: string;
    /** user из RURI запроса (кого вызываем/регистрируем). */
    ruri_user: string;
    /** user из заголовка From — Calling party number (кто вызывает). */
    from_user: string;
    /** user из заголовка To — кого вызывают. */
    to_user: string;
    /** Статус-код ответа. */
    status: number;
    /** Причина из status-line. */
    reason: string;
    call_id: string;
    /** Есть ли заголовок Authorization (REGISTER с Digest). */
    has_digest: boolean;
}

function header_value(lines: string[], name: string): string
{
    for (const l of lines)
    {
        if (l === '') break; // дальше тело
        const m = new RegExp(`^${name}\\s*:\\s*(.*)$`, 'i').exec(l);
        if (m) return m[1].trim();
    }
    return '';
}

/**
 * user из `<sip:52@host…>` / `sip:52@host` (без скобок и параметров).
 * Display-name перед URI (`"9404" <sip:9404@host>`) пропускаем: ищем схему
 * в любом месте значения — станция на переизлученном INVITE добавляет имя.
 */
function uri_user(value: string): string
{
    const m = /(?:sips?|tel):([^@;>"\s]+)@/i.exec(value.trim());
    return m ? m[1] : '';
}

/** Разбор сообщения; null — не SIP (мусор в сокете). */
export function parse_sip_message(raw: string): SipHead | null
{
    const lines = raw.split('\r\n');
    const first = lines[0] ?? '';
    const req = /^([A-Z]+)\s+(\S+)\s+SIP\/2\.0$/i.exec(first);
    const res = /^SIP\/2\.0\s+(\d{3})\s*(.*)$/i.exec(first);
    if (!req && !res) return null;
    // CSeq: «1 REGISTER» / «2 BYE» — метод вторым токеном.
    const cseq = header_value(lines, 'cseq');
    const cseq_method = (cseq.split(/\s+/)[1] ?? '').toUpperCase();
    return {
        is_request: !!req,
        method: req ? req[1].toUpperCase() : cseq_method,
        ruri_user: req ? uri_user(req[2]) : '',
        from_user: uri_user(header_value(lines, 'from')),
        to_user: uri_user(header_value(lines, 'to')),
        status: res ? Number(res[1]) : 0,
        reason: res ? res[2].trim() : '',
        call_id: header_value(lines, 'call-id'),
        has_digest: header_value(lines, 'authorization') !== '',
    };
}

// ---------- журнал ----------

/**
 * Журнал SIP-событий автотестов. Чистый наблюдатель: ничего не знает про
 * express/мост; пул абонентов (п.4) и e2e-раннер (п.8) пишут в него события,
 * reports-контроллер (п.5) читает файлы, созданные render_report().
 */
export class Journal
{
    private items: JournalEvent[] = [];
    private readonly reports_dir: string;
    private readonly now: () => number;

    constructor(opts: JournalOptions = {})
    {
        this.reports_dir = opts.reports_dir ?? path.resolve('reports');
        this.now = opts.now ?? Date.now;
    }

    /** Все события в порядке фиксации (только чтение). */
    get events(): readonly JournalEvent[]
    {
        return this.items;
    }

    /** Фиксация события; возвращает его (для chain-оформления в тестах). */
    log(
        session: string,
        direction: JournalDirection,
        kind: string,
        extra: LogExtra = {},
    ): JournalEvent
    {
        const ev: JournalEvent = {
            ts: this.now(),
            session,
            direction,
            kind,
            detail: extra.detail ?? '',
            call_id: extra.call_id ?? '',
        };
        if (extra.code !== undefined) ev.sip_code = extra.code;
        this.items.push(ev);
        return ev;
    }

    /**
     * Подписка на стейт-машину: этапы фиксируются при смене состояния
     * (первый текущий снапшот — тоже этап; патчи без смены состояния игнорируются).
     * Возвращает отписку.
     */
    attach_phone(session: string, sm: PhoneStateMachine): () => void
    {
        let last: string | null = null;
        return sm.subscribe((s) =>
        {
            const sig = `${s.state}|${s.peer}|${s.error}`;
            if (sig === last) return;
            last = sig;
            const parts = [`состояние ${s.state}`];
            if (s.peer) parts.push(`собеседник ${s.peer}`);
            if (s.ringing) parts.push('180 Ringing');
            if (s.registering) parts.push('REGISTER отправлен');
            if (s.error) parts.push(`ошибка: ${s.error}`);
            this.log(session, 'internal', 'state', { detail: parts.join(', ') });
        });
    }

    /**
     * Подписка на события транспорта (контракт Transport). Это вехи телефона;
     * полная протокольная цепочка messages — от on_sip_message (hook on_trace).
     * Возвращает отписку.
     */
    attach_transport(session: string, t: Transport): () => void
    {
        const offs = [
            t.on('incoming', (peer) =>
                this.log(session, 'in', 'call-in', {
                    detail: `INVITE от ${peer} — входящий вызов`,
                }),
            ),
            t.on('ringing', () =>
                this.log(session, 'in', 'ringing', { code: 180, detail: '180 Ringing' }),
            ),
            t.on('established', () =>
                this.log(session, 'in', 'call-established', {
                    code: 200,
                    detail: '200 OK + ACK — вызов принят',
                }),
            ),
            t.on('terminated', (code) =>
                code
                    ? this.log(session, 'in', 'call-ended', {
                          code,
                          detail: `завершён с кодом ${code}`,
                      })
                    : this.log(session, 'internal', 'call-ended', {
                          detail: 'завершён (BYE)',
                      }),
            ),
            t.on('transport-lost', (text) =>
                this.log(session, 'internal', 'transport-lost', { detail: text }),
            ),
            t.on('registration-lost', (text) =>
                this.log(session, 'internal', 'registration-lost', { detail: text }),
            ),
            t.on('registered', () =>
                this.log(session, 'internal', 'state', {
                    detail: 'перерегистрация после реконнекта — 200 OK',
                }),
            ),
        ];
        return () => offs.forEach((off) => off());
    }

    /**
     * Сырое SIP-сообщение из сокета (dir: 'out' — мы отправили, 'in' — станция).
     * kind = метод транзакции (для ответов — метод из CSeq), поэтому цепочка
     * регистрации выглядит как register → register(401) → register(Digest) →
     * register(200).
     */
    on_sip_message(session: string, direction: 'in' | 'out', raw: string): void
    {
        const h = parse_sip_message(raw);
        if (!h)
        {
            this.log(session, direction, 'sip-other', {
                detail: (raw.split('\r\n')[0] ?? '').slice(0, 120),
            });
            return;
        }
        const kind = (h.method || 'other').toLowerCase();
        if (h.is_request)
        {
            const target = h.ruri_user ? ` → ${h.ruri_user}` : '';
            const digest = h.has_digest ? ' с Digest' : '';
            // Calling party number (user из From) — виден и в отчёте, и в ассертах (п.8).
            const caller = h.from_user ? ` от ${h.from_user}` : '';
            this.log(session, direction, kind, {
                detail: `${h.method}${digest}${target}${caller}`,
                call_id: h.call_id,
            });
        }
        else
        {
            const for_method = h.method ? ` для ${h.method}` : '';
            this.log(session, direction, kind, {
                code: h.status,
                detail: `${h.status} ${h.reason}${for_method}`.trim(),
                call_id: h.call_id,
            });
        }
    }

    // ---------- отчёты (п.3.2) ----------

    /**
     * Сгенерировать отчёт прогона: reports/<UTC-ts>_<case>.{json,md,html}.
     * Имя файла уникально (UTC-метка, при коллизии — суффикс _2, _3, …).
     * events — события отчёта; по умолчанию весь журнал. Раннер (п.7/п.8) передаёт
     * срез одного прогона, чтобы отчёт кейса не тащил этапы предыдущих кейсов.
     */
    render_report(
        meta: ReportMeta,
        events: readonly JournalEvent[] = this.items,
    ): ReportFiles
    {
        const base = `${utc_stamp(this.now())}_${safe_case(meta.case)}`;
        fs.mkdirSync(this.reports_dir, { recursive: true });
        // Счётчик коллизий: суффикс _2, _3 … (цифры имени кейса не трогаем).
        let id = base;
        for (let n = 2; fs.existsSync(path.join(this.reports_dir, `${id}.json`)); n++)
        {
            id = `${base}_${n}`;
        }
        const json_path = path.join(this.reports_dir, `${id}.json`);
        const md_path = path.join(this.reports_dir, `${id}.md`);
        const html_path = path.join(this.reports_dir, `${id}.html`);
        const generated_at = new Date(this.now()).toISOString();
        const snapshot = [...events]; // фиксируем срез — журнал продолжает расти
        fs.writeFileSync(
            json_path,
            JSON.stringify({ id, generated_at, meta, events: snapshot }, null, 2) + '\n',
        );
        fs.writeFileSync(md_path, render_md(id, generated_at, meta, snapshot));
        fs.writeFileSync(html_path, render_html(id, generated_at, meta, snapshot));
        return { id, dir: this.reports_dir, json_path, md_path, html_path };
    }
}

// ---------- рендер ----------

/** UTC-метка для имени файла: 20261027T153000Z (без двоеточий — safe в путях). */
export function utc_stamp(ts: number): string
{
    return new Date(ts)
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}Z$/, 'Z');
}

/** Имя кейса в safe-имя файла: только [a-z0-9_-]. */
function safe_case(name: string): string
{
    return (
        name
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '_')
            .slice(0, 64) || 'case'
    );
}

function fmt_time(ts: number): string
{
    return new Date(ts)
        .toISOString()
        .replace('T', ' ')
        .replace(/\.\d{3}Z$/, 'Z');
}

/** Строка этапа для таблицы: «register 401» / «invite». */
function stage_of(e: JournalEvent): string
{
    return e.sip_code !== undefined ? `${e.kind} ${e.sip_code}` : e.kind;
}

function dir_of(e: JournalEvent): string
{
    return e.direction === 'out' ? '→ АТС' : e.direction === 'in' ? '← АТС' : '·';
}

/** Строка вызова для шапки: кто отправил и кому (direction — с нашей стороны). */
function call_line(c: ReportCall): string
{
    const dir = c.direction === 'out' ? 'исходящий' : 'входящий';
    return `Вызов (${dir}): от ${c.from} → кому ${c.to}`;
}

function header_lines(meta: ReportMeta): string[]
{
    return [
        `АТС: ${meta.pbx_host}:${meta.pbx_port} (${meta.sip_protocol})`,
        `Номера: ${meta.subscribers.join(', ') || '—'}`,
        ...(meta.calls ?? []).map(call_line),
        `Кейс: ${meta.case}`,
        `Вердикт: ${meta.verdict}${meta.verdict_text ? ` — ${meta.verdict_text}` : ''}`,
    ];
}

function render_md(
    id: string,
    generated_at: string,
    meta: ReportMeta,
    events: readonly JournalEvent[],
): string
{
    const lines: string[] = [`# Отчёт ${id}`, '', `Сгенерирован: ${generated_at}`, ''];
    lines.push(...header_lines(meta).map((s) => `- ${s}`), '');
    lines.push(
        '| # | Время | Абонент | Напр. | Этап | SIP | Call-ID | Детали |',
        '|---|---|---|---|---|---|---|---|',
    );
    events.forEach((e, i) =>
    {
        lines.push(
            `| ${i + 1} | ${fmt_time(e.ts)} | ${e.session} | ` +
                `${dir_of(e)} | ${e.kind} | ` +
                `${e.sip_code ?? ''} | ${e.call_id} | ${e.detail} |`,
        );
    });
    if (events.length === 0) lines.push('| — | — | — | — | (пусто) | | | |');
    lines.push('', `**Вердикт: ${meta.verdict}**`, '');
    return lines.join('\n');
}

function esc(s: string): string
{
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function render_html(
    id: string,
    generated_at: string,
    meta: ReportMeta,
    events: readonly JournalEvent[],
): string
{
    const rows = events
        .map(
            (e, i) =>
                `      <tr class="d-${e.direction} k-${esc(e.kind)}"><td>${i + 1}</td>` +
                `<td>${fmt_time(e.ts)}</td><td>${esc(e.session)}</td>` +
                `<td>${dir_of(e)}</td><td class="stage">${esc(stage_of(e))}</td>` +
                `<td>${e.sip_code ?? ''}</td><td class="cid">${esc(e.call_id)}</td>` +
                `<td>${esc(e.detail)}</td></tr>`,
        )
        .join('\n');
    return (
        `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Отчёт ${esc(id)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; color: #1c2733; ` +
        `background: #f7f9fb; }
  h1 { font-size: 20px; }
  .meta { background: #fff; border: 1px solid #d7e0e8; border-radius: 8px; ` +
        `padding: 12px 16px; margin-bottom: 16px; }
  .meta div { margin: 2px 0; }
  .verdict { font-weight: 700; }
  .PASS { color: #147d3c; }
  .FAIL { color: #b3261e; }
  table { border-collapse: collapse; width: 100%; background: #fff; font-size: 13px; }
  th, td { border: 1px solid #d7e0e8; padding: 4px 8px; ` +
        `text-align: left; vertical-align: top; }
  th { background: #eef3f7; }
  tr.d-out td.stage { color: #0b57a4; }
  tr.d-in  td.stage { color: #8a4b00; }
  .cid { font-family: monospace; font-size: 11px; color: #5b6b7b; word-break: break-all; }
</style>
</head>
<body>
  <h1>Отчёт прогона: ${esc(id)}</h1>
  <div class="meta">
    <div>Сгенерирован: ${generated_at}</div>
${header_lines(meta)
    .map((s) => `    <div>${esc(s)}</div>`)
    .join('\n')}
  </div>
  <table>
    <thead>
      <tr><th>#</th><th>Время (UTC)</th><th>Абонент</th>` +
        `<th>Напр.</th><th>Этап</th><th>SIP</th><th>Call-ID</th><th>Детали</th></tr>
    </thead>
    <tbody>
${rows || '      <tr><td colspan="8">журнал пуст</td></tr>'}
    </tbody>
  </table>
  <p class="verdict ${meta.verdict}">Вердикт: ${meta.verdict}` +
        `${meta.verdict_text ? ` — ${esc(meta.verdict_text)}` : ''}</p>
</body>
</html>
`
    );
}
