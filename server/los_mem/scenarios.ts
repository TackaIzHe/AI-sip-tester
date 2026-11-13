// Сценарии T1–T8 генератора стимулов (doc/los_mem/plan_test.md §3).
//
// Каждый сценарий — ГЕНЕРАЦИЯ стимулирующих SIP-событий по плану: фазы
// «stim_start → stim_stop» с метками времени в stdout и CSV (сшивка рядов
// «память/пакеты/лог» по времени, план §2.2), сводка «отправлено/ответы»
// в конце. ВЕРДИКТА НЕТ (решение оператора, см. doc/task_22_plan_2.md):
// память и вывод об утечке оператор делает сам по CSV + своему мониторингу;
// сценарий завершается успешно, кроме ошибок сокета/конфига. Остановка —
// Ctrl-C (SIGINT): цикл замечает флаг, делает graceful-зачистку
// (unsubscribe, закрытие сокетов) и тоже выходит с кодом 0.
//
// A/B-контроль (план §4 шаг 6) — не отдельная фаза, а варианты запуска:
// T1 `--variant=f`, T2 `--props` с корректными длинами — «исправленное»
// сообщение; разница видна оператору по двум прогонам с CSV.
//
// Достижимость parse-путей станции (зонд doc/.probe_losmem_events.ts):
// - станция как UAS отклоняет наши подписки: dialog-info/event-list → 489,
//   dialog → 401→Digest→403 (без BLF-настройки на номер);
// - blf_on_rx_notify/ss_on_rx_notify живут на ИСХОДЯщих подписках станции
//   (res.md, sub_on_rx_notify_uac): настроит админ АТС BLF/SSW на номера
//   генератора — станция сама пришлёт SUBSCRIBE на наш Contact, Register+
//   StationSubscriptions по нему и NOTIFY попадают точно в кандидатные пути;
// - без настройки NOTIFY идут «вслепую» (станция отвечает 481) — сводки
//   прогонов честно разделяют «в диалоги станции» и «вслепую».
// related: server/los_mem/raw_sip.ts, server/los_mem/bodies.ts,
// los_mem_main.ts (CLI), doc/los_mem/plan_test.md §2.2/§3, doc/sip_rfc.md.

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig, SubscriberConfig } from '../config';
import {
    build_digest_authorization,
    build_sip_request,
    build_sip_response,
    parse_digest_challenge,
    parse_sip_request_head,
    parse_sip_response,
    sip_call_id,
    subscription_state_value,
    uri_host_port,
    RawSipClient,
    RawUdpResponder,
} from './raw_sip';
import {
    DIALOG_INFO_VARIANTS,
    DIALOG_INFO_CONTENT_TYPE,
    SIMPLE_LIST_CONTENT_TYPE,
    dialog_info_body,
    ipc_subscribe_frames,
    simple_list_body,
    type DialogInfoVariant,
    type SimpleListOptions,
} from './bodies';

// ---------- контракт сценариев ----------

/** Параметры прогона (CLI-флаги los_mem_main.ts, дефолты — по плану §3). */
export interface ScenarioOpts
{
    /** Длительность стимула, минуты. */
    minutes: number;
    /** Темп стимула, сообщений/с (для T5 — на каждый вариант). */
    rate: number;
    /** T1/T8: вариант тела dialog-info (a..f|all). */
    variant: string;
    /** T2: свойств в одном NOTIFY (гибрид c: 100–1000). */
    props: number;
    /** T2: value|name|hybrid — что делать дефектным (план a/b/c). */
    kind: string;
    /** T3: число циклов «полный конфиг подписок». */
    cycles: number;
    /** T3: пауза между циклами, с (2–5 мин по плану). */
    pause_s: number;
    /** T4: порт «провайдера-401» на этом хосте. */
    provider_port: number;
    /** T5: пауза наблюдения после flood'а, мин (0 — пропустить). */
    observe_min: number;
    /** T6: число IPC-кадров. */
    count: number;
    /** T6: команда-обёртка IPC (stdin = hex-кадры по строке); пусто — файл. */
    ipc_cmd?: string;
    /** T7: домен «висящего» резолва (.invalid — гарантированный NXDOMAIN). */
    domain: string;
}

/**
 * Базовые дефолты флагов (переопределяются defaults сценария, а те — CLI
 * флагами/короткой версией прогона): единый источник для standalone-CLI
 * (los_mem_main.ts) и кейсов T1–T8 в реестре CASES (e2e_runner.ts).
 */
export const BASE_SCENARIO_OPTS: ScenarioOpts = {
    minutes: 30,
    rate: 1,
    variant: 'a',
    props: 500,
    kind: 'hybrid',
    cycles: 5,
    pause_s: 180,
    provider_port: 5061,
    observe_min: 15,
    count: 10_000,
    domain: 'losmem-storm.invalid',
};

/**
 * Короткие версии сценариев для прогонов внутри сервера (терминал
 * `test t1..t8`, вкладка «Тесты», стимулы на вкладке «Станция»): полные
 * длительности из plan_test.md §3 (часы-сутки) в интерактивном прогоне
 * неуместны. Флаги (variant/props/target/…) — прерогатива standalone-CLI;
 * здесь дефолты «быстрого прогона» из таблицы doc/task_22_plan_2.md.
 */
export const LOS_QUICK_OPTS: Record<string, Partial<ScenarioOpts>> = {
    t1: { minutes: 1, variant: 'all' },
    t2: { minutes: 1, props: 100 },
    t3: { cycles: 1, pause_s: 5 },
    t4: { minutes: 1 },
    t5: { minutes: 1, observe_min: 0 },
    t6: { count: 1000 },
    t7: { minutes: 1 },
    t8: { minutes: 1 },
};

/**
 * View принятой подписки станции (её SUBSCRIBE к нам) — форма записи
 * пассивного UAS: адресат/теги для NOTIFY строго в этом диалоге (план 5
 * п.4b; реализует SipStation.subscriptions(), doc/task_27).
 */
export interface StationSubView
{
    call_id: string;
    /** Пакет из её Event (event-list/dialog/…) — как прислала. */
    event: string;
    /** Её To → From наших NOTIFY (зеркало диалога). */
    from_uri: string;
    /** Её From → To наших NOTIFY. */
    to_uri: string;
    /** Contact из её SUBSCRIBE (R-URI/адресат NOTIFY; пуст — remote). */
    contact_uri: string;
    /** Адресат NOTIFY: хост/порт из её Contact (или src запроса). */
    remote: { host: string; port: number };
    /** Наш To-тег из 200 — From-tag NOTIFY. */
    our_tag: string;
    /** Её From-tag — To-tag NOTIFY. */
    peer_tag: string;
    /** Текущий CSeq наших NOTIFY (монотонен, двигает take_cseq). */
    cseq: number;
    /**
     * ISO-время истечения подписки: остаток секунд подставляется в
     * `Subscription-State` наших NOTIFY (без заголовка pjsip отвечает 400,
     * 12.log).
     */
    expires_at: string;
}

/**
 * Источник принятых станцией подписок (DI контекста): станции ведёт
 * диалоги и их CSeq, сценарий только строит NOTIFY.
 */
export interface StationSubSource
{
    list(): StationSubView[];
    take_cseq(call_id: string): number | undefined;
}

/** DI-контекст сценария: адресация станции, вывод, сигнал остановки. */
export interface ScenarioCtx
{
    config: AppConfig;
    /** Куда слать стимул (по умолчанию АТС из .env, --target переопределяет). */
    target: { host: string; port: number };
    /** Реальный IP этой машины в Via/Contact (BRIDGE_HOST, станция шлёт туда). */
    via_host: string;
    /** Каталог для побочных файлов сценариев (T6: hex-дампы кадров). */
    reports_dir: string;
    opts: ScenarioOpts;
    /** Строка в stdout с UTC-меткой. */
    log: (text: string) => void;
    /** Метка фазы (stdout + CSV): stim_start/stim_stop/observe_stop/… */
    phase: (name: string) => void;
    /** Периодический сэмпл: сколько отправлено (CSV, раз в ~минуту). */
    tick: (sent: number) => void;
    /** true после SIGINT — циклы обязаны выйти с graceful-зачисткой. */
    stopped: () => boolean;
    /**
     * Фабрика транспортов вместо собственного bind (движок стимулов станции,
     * doc/task_26): клиенты уходят через сокет станции (Via/Contact = её
     * адрес), close() сокет станции не трогает. Нет — обычный RawSipClient
     * с эфемерным портом (standalone-CLI и кейсы реестра).
     */
    make_client?: () => Promise<RawSipClient>;
    /**
     * Подписки, принятые НАШЕЙ станцией (план 5 п.4a): есть — пассивный UAS
     * живёт на станции, StationSubscriptions свои 200 НЕ шлёт (двойных
     * ответов нет) и next_notify берёт диалоги отсюда. Нет (CLI без станции) —
     * прежний клиентский UAS.
     */
    station_subs?: StationSubSource;
    /**
     * Сырая строка в CSV-фазы (план 5 п.2): каждый отправленный NOTIFY —
     * адресат/Call-ID/CSeq/теги/Event/CT/длина тела. Нет — только ctx.log.
     */
    log_raw?: (line: string) => void;
}

/** Запись реестра сценариев: заголовок, ссылка на план, дефолты, тело. */
export interface ScenarioDef
{
    title: string;
    plan_ref: string;
    /** Дефолты сценария поверх общих (план §3: T1/T2 30 мин, T5 60 мин…). */
    defaults: Partial<ScenarioOpts>;
    /** Тело: генерирует стимул, возвращает текст сводки (без вердикта). */
    run: (ctx: ScenarioCtx) => Promise<string>;
}

// ---------- помощники ----------

function sleep(ms: number): Promise<void>
{
    return new Promise((r) => setTimeout(r, ms));
}

/** Сон до ms, но реагирует на SIGINT каждые 500 мс. */
async function wait_ms(ms: number, stopped: () => boolean): Promise<void>
{
    const end = Date.now() + ms;
    for (;;)
    {
        if (stopped()) return;
        const left = end - Date.now();
        if (left <= 0) return;
        await sleep(Math.min(500, left));
    }
}

/** Тело-итерация раз в 1000/rate мс до duration_ms; тик ~раз в минуту. */
async function paced_loop(
    ctx: ScenarioCtx,
    duration_ms: number,
    rate: number,
    body: (i: number) => Promise<void>,
): Promise<number>
{
    const end = Date.now() + duration_ms;
    const interval_ms = 1000 / rate;
    const tick_every = Math.max(1, Math.round(60 * rate));
    let i = 0;
    while (!ctx.stopped() && Date.now() < end)
    {
        await body(i);
        i += 1;
        if (i % tick_every === 0) ctx.tick(i);
        await wait_ms(interval_ms, ctx.stopped);
    }
    return i;
}

/** Счётчики `Map<ключ, n>` в одну строку: «NOTIFY 200×312, …»; пусто — «нет». */
export function fmt_counts(map: ReadonlyMap<string, number>): string
{
    const parts = [...map.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k}×${n}`);
    return parts.length > 0 ? parts.join(', ') : 'нет';
}

function rnd(len = 8): string
{
    return crypto.randomBytes(len).toString('hex');
}

/** Новый сырой клиент к цели (UDP/TCP по конфигу станции). */
async function new_client(ctx: ScenarioCtx, local_port?: number): Promise<RawSipClient>
{
    if (ctx.make_client) return ctx.make_client();
    const client = new RawSipClient({
        host: ctx.target.host,
        port: ctx.target.port,
        proto: ctx.config.sip_protocol,
        local_port,
    });
    await client.connect();
    return client;
}

// ---------- отправка NOTIFY (план 5 п.2/п.4b) ----------

/**
 * Строка сырого журнала отправленного NOTIFY: адресат (R-URI — он же
 * фактический dst), Call-ID, CSeq, From/To-теги, Event, Content-Type,
 * байтовая длина тела (plan_5 п.2: сшивка с трассой станции по строкам
 * `Processing incoming message: Request msg NOTIFY`).
 */
export function notify_log_line(
    msg: string,
    dst: { host: string; port: number },
): string
{
    const first = (re: RegExp): string => re.exec(msg)?.[1]?.trim() ?? '';
    const to_line = first(/^to\s*:\s*(.*)$/im);
    const from_line = first(/^from\s*:\s*(.*)$/im);
    const tag_of = (l: string): string => /;tag=([^;>\s]+)/i.exec(l)?.[1] ?? '—';
    const body = msg.slice(msg.indexOf('\r\n\r\n') + 4);
    return (
        `NOTIFY → ${dst.host}:${dst.port} cid=${sip_call_id(msg) || '—'} ` +
        `cseq=${first(/^cseq\s*:\s*(\d+\s+NOTIFY)/im) || '—'} ` +
        `tags=${tag_of(from_line)}/${tag_of(to_line)} ` +
        `event=${first(/^event\s*:\s*([^;\r\n]+)/im) || '—'} ` +
        `ct=${first(/^content-type\s*:\s*(\S+)/im) || '—'} ` +
        `body=${Buffer.byteLength(body, 'utf8')}B`
    );
}

/**
 * Отправить NOTIFY: адресат — R-URI сообщения (Contact принятой подписки,
 * п.4b), НЕ дефолтная цель клиента: в дампе №2 NOTIFY шли на .157:5060,
 * тогда как Contact подписки станции — другой адрес (.133/.157 из её SUBSCRIBE);
 * UDP-send уходит точно в R-URI. Каждая отправка — строка в log/CSV (п.2).
 */
async function send_notify(
    ctx: ScenarioCtx,
    client: RawSipClient,
    msg: string,
): Promise<void>
{
    const ruri = /^NOTIFY\s+(\S+)\s+SIP\/2\.0/i.exec(msg)?.[1] ?? '';
    const dst = uri_host_port(ruri, ctx.target.port) ?? ctx.target;
    await client.send(msg, dst.host, dst.port);
    const line = notify_log_line(msg, dst);
    ctx.log(line);
    ctx.log_raw?.(line);
}

// ---------- регистрация и входящие подписки станции ----------

/**
 * Активная raw-регистрация абонента: держит Call-ID/тег для снятия
 * (expires=0) при зачистке прогона.
 */
export class RawRegistration
{
    constructor(
        private readonly ctx: ScenarioCtx,
        private readonly client: RawSipClient,
        private readonly sub: SubscriberConfig,
        /** Код финального ответа REGISTER (0 — ответа нет). */
        readonly code: number,
        private readonly call_id: string,
        private readonly from_tag: string,
    )
    {}

    /** REGISTER expires=0 — снять binding станции (best-effort). */
    async release(): Promise<void>
    {
        try
        {
            await this.client.send(
                build_sip_request('REGISTER', {
                    ruri: `sip:${this.ctx.target.host}:${this.ctx.target.port}`,
                    from_uri: `sip:${this.sub.number}@${this.ctx.via_host}`,
                    to_uri: `sip:${this.sub.number}@${this.ctx.target.host}`,
                    call_id: this.call_id,
                    cseq: 99,
                    from_tag: this.from_tag,
                    contact:
                        `sip:${this.sub.number}@${this.ctx.via_host}:` +
                        `${this.client.local_port()}`,
                    via_host: this.ctx.via_host,
                    proto: this.ctx.config.sip_protocol,
                    extra_headers: ['Expires: 0'],
                }),
            );
        }
        catch
        {
            /* сокет мог быть закрыт зачисткой раньше — сигнал игнорируем */
        }
    }
}

/**
 * Сырая REGISTER (+Digest-повтор): станция ставит binding по Contact и,
 * если на АТС настроен BLF/SSW за этим номером, шлёт свой SUBSCRIBE на него
 * — единственный легальный вход в blf_on_rx_notify/ss_on_rx_notify (проверено
 * зондом doc/.probe_losmem_events.ts: без BLF-настройки станция не
 * подписывается, а наши SUBSCRIBE как UAS — 489/403).
 */
async function register_raw(
    ctx: ScenarioCtx,
    client: RawSipClient,
    sub: SubscriberConfig,
    expires = 600,
): Promise<RawRegistration>
{
    const call_id = `losmem-reg-${rnd(8)}`;
    const from_tag = `los-${rnd(6)}`;
    const ruri = `sip:${ctx.target.host}:${ctx.target.port}`;
    const base = {
        ruri,
        from_uri: `sip:${sub.number}@${ctx.via_host}`,
        to_uri: `sip:${sub.number}@${ctx.target.host}`,
        call_id,
        cseq: 1,
        from_tag,
        // Contact user = номер + эфемерный порт (грабли стенда, CLAUDE.md).
        contact: `sip:${sub.number}@${ctx.via_host}:${client.local_port()}`,
        via_host: ctx.via_host,
        proto: ctx.config.sip_protocol,
        extra_headers: [`Expires: ${expires}`],
        user_agent: 'losmem-gen/1.0',
    };
    const wait = client.wait_response(call_id, 5000);
    await client.send(build_sip_request('REGISTER', base));
    let raw = await wait;
    let head = raw ? parse_sip_response(raw) : null;
    const ch = raw ? parse_digest_challenge(raw) : null;
    if (head?.status === 401 && ch)
    {
        const auth = build_digest_authorization('REGISTER', ch, {
            user: sub.number,
            password: sub.password,
            uri: ruri,
        });
        const wait2 = client.wait_response(call_id, 5000);
        await client.send(
            build_sip_request('REGISTER', {
                ...base,
                cseq: 2,
                extra_headers: [`Expires: ${expires}`, `Authorization: ${auth}`],
            }),
        );
        raw = await wait2;
        head = raw ? parse_sip_response(raw) : null;
    }
    return new RawRegistration(ctx, client, sub, head?.status ?? 0, call_id, from_tag);
}

/**
 * Диалог, открытый СТАНЦИЕЙ (её SUBSCRIBE к нам): всё, что нужно для наших
 * NOTIFY в её диалог. Тот же view, что отдаёт пассивный UAS станции
 * (SipStation.subscriptions, план 5 п.4a) — форма общая.
 */
type StationDialog = StationSubView;

/**
 * Пассивный UAS подписок станции: входящий SUBSCRIBE получает 200 с нашим
 * tag, диалог запоминается. Если админ АТС настроит BLF/SSW на номера
 * генератора, NOTIFY в этих диалогах приходят ровно в blf_on_rx_notify /
 * ss_on_rx_notify (res.md, путь sub_on_rx_notify_uac). Без такой настройки
 * диалогов нет — сценарии честно пишут об этом в сводке и шлют «вслепую».
 */
export class StationSubscriptions
{
    /**
     * Активные диалоги станции (Call-ID → параметры NOTIFY).
     */
    readonly dialogs = new Map<string, StationDialog>();
    /**
     * Имена пакетов, по которым станция подписывалась (для сводки: видно,
     * как именно АТС называет BLF/SSW-подписки).
     */
    readonly events = new Set<string>();

    constructor(
        private readonly client: RawSipClient,
        private readonly via_host: string,
        private readonly local: SubscriberConfig,
        /** DI принятых станцией подписок (план 5 п.4a); нет — клиентский UAS. */
        private readonly external?: StationSubSource,
    )
    {
        // При станционном UAS (external) свои 200 НЕ шлём и свои диалоги не
        // копим: станция ответила сразу (п.4c), второй 200 сломал бы диалог
        // pjsip пира (дефект двойных ответов, doc/task_26_plan_2.md).
        if (!external)
        {
            client.on_message((raw, from) =>
            {
                void this.on_request(raw, from);
            });
        }
    }

    /** Имена пакетов живых диалогов (для сводки; external — от станции). */
    active_events(): string[]
    {
        if (this.external)
        {
            return [...new Set(this.external.list().map((d) => d.event))];
        }
        return [...this.events];
    }

    /** Число живых диалогов (для сводки). */
    active_count(): number
    {
        return this.external ? this.external.list().length : this.dialogs.size;
    }

    /**
     * Следующий NOTIFY в диалог станции (любой пакет events или первый
     * попавшийся, если список пуст); undefined — подходящего диалога нет.
     */
    next_notify(
        body: string,
        content_type: string,
        events: string[] = [],
    ): string | undefined
    {
        // п.4b: сначала диалоги, принятые станцией (её 200-теги/Contact у
        // неё же в учёте), потом собственная копия (CLI без станции).
        if (this.external)
        {
            for (const d of this.external.list())
            {
                if (events.length > 0 && !events.includes(d.event)) continue;
                const cseq = this.external.take_cseq(d.call_id);
                if (cseq === undefined) continue; // диалог истёк на витке
                return this.build_notify(d, cseq, body, content_type);
            }
        }
        let picked: [string, StationDialog] | undefined;
        for (const e of this.dialogs.entries())
        {
            if (events.length === 0 || events.includes(e[1].event))
            {
                picked = e;
                break;
            }
        }
        if (!picked) return undefined;
        const d = picked[1];
        d.cseq += 1;
        return this.build_notify(d, d.cseq, body, content_type);
    }

    // ---------- внутреннее ----------

    /** Сборка NOTIFY в диалог d (R-URI — её Contact, теги — из диалога). */
    private build_notify(
        d: StationDialog,
        cseq: number,
        body: string,
        content_type: string,
    ): string
    {
        const contact =
            `sip:${this.local.number}@${this.via_host}:` + `${this.client.local_port()}`;
        const ruri =
            d.contact_uri || `sip:${this.local.number}@${d.remote.host}:${d.remote.port}`;
        return build_sip_request('NOTIFY', {
            ruri,
            from_uri: d.from_uri,
            to_uri: d.to_uri,
            call_id: d.call_id,
            cseq,
            from_tag: d.our_tag,
            to_tag: d.peer_tag,
            contact,
            via_host: this.via_host,
            content_type,
            body,
            // Subscription-State — обязателен в NOTIFY (RFC 3265 §4.1.4):
            // без него pjsip-evsub станции отвечает 400 и отписывается
            // (12.log), до ss_on_rx_notify сообщение не доходит.
            extra_headers: [
                ...(d.event ? [`Event: ${d.event}`] : []),
                `Subscription-State: ${subscription_state_value(d.expires_at)}`,
            ],
            user_agent: 'losmem-gen/1.0',
        });
    }

    private async on_request(
        raw: string,
        from: { host: string; port: number },
    ): Promise<void>
    {
        const head = parse_sip_request_head(raw);
        if (!head || head.method !== 'SUBSCRIBE') return;
        this.events.add(head.event);
        const tag = `losuas-${rnd(6)}`;
        const contact =
            `sip:${this.local.number}@${this.via_host}:` + `${this.client.local_port()}`;
        const resp = build_sip_response(200, 'OK', raw, [`Contact: <${contact}>`], tag);
        if (head.expires === 0)
        {
            this.dialogs.delete(head.call_id);
        }
        else
        {
            const hp = uri_host_port(head.contact_uri, from.port) ?? {
                host: from.host,
                port: from.port,
            };
            this.dialogs.set(head.call_id, {
                call_id: head.call_id,
                contact_uri: head.contact_uri,
                remote: { host: hp.host, port: hp.port },
                from_uri: head.to_uri,
                to_uri: head.from_uri,
                our_tag: tag,
                peer_tag: head.from_tag,
                cseq: 0,
                event: head.event,
                // Остаток для Subscription-State (нет Expires в запросе — 600).
                expires_at: new Date(
                    Date.now() + (head.expires < 0 ? 600 : head.expires) * 1000,
                ).toISOString(),
            });
        }
        try
        {
            // UDP: отвечаем на src-адрес запроса; TCP в клиенте его игнорирует.
            await this.client.send(resp, from.host, from.port);
        }
        catch
        {
            /* гонка с закрытием сокета на зачистке — запрос потеряли */
        }
    }
}

// ---------- подписочный диалог ----------

/** Параметры SubDialog: кто/куда/что подписывает (T1/T2/T3/T8). */
export interface SubDialogSpec
{
    client: RawSipClient;
    /** Имя события SUBSCRIBE (dialog / event-list). */
    event: string;
    local: SubscriberConfig;
    /** Номер цели подписки (BLF-цель). */
    remote_number: string;
    target: { host: string; port: number };
    via_host: string;
    content_type?: string;
    body?: string;
    expires?: number;
}

/**
 * Подписочный диалог: SUBSCRIBE нашей машины к станции и NOTIFY «в диалоге
 * подписки» (план T1 «Call-Id/CSeq в диалоге подписки»). To-tag и удалённый
 * target берутся из финального ответа (401 → повтор с Authorization: Digest —
 * станция так пропускает `Event: dialog`, зонд doc/.probe_losmem_events.ts);
 * без ответа/без To-tag диалог продолжается вслепую — считать ли NOTIFY
 * «в диалоге», решает станция, а сценарий честно пишет об этом в лог
 * (open_status) и стимул не прекращает.
 */
export class SubDialog
{
    readonly call_id: string;
    readonly from_tag = `los-${rnd(6)}`;
    /** To-tag из ответа станции ('' — не получен). */
    to_tag = '';
    /** Код финального ответа на SUBSCRIBE (0 — ответа не было). */
    open_status = 0;
    /** Удалённый target диалога (Contact ответа; по умолчанию — адрес цели). */
    remote: { host: string; port: number };
    /**
     * ISO-истечение подписки по 2xx-ответу (наш запросанный Expires; '' —
     * ответ не принят) — остаток идёт в `Subscription-State` наших NOTIFY.
     */
    expires_at = '';
    private cseq = 0;

    constructor(private readonly spec: SubDialogSpec)
    {
        this.call_id = `losmem-${rnd(10)}`;
        this.remote = { ...spec.target };
    }

    /** Следующий номер CSeq транзакции диалога. */
    next_cseq(): number
    {
        this.cseq += 1;
        return this.cseq;
    }

    /** Request-URI подписки (он же Digest uri при повторе после 401). */
    ruri(): string
    {
        const s = this.spec;
        return `sip:${s.remote_number}@${s.target.host}:${s.target.port}`;
    }

    /**
     * SUBSCRIBE диалога (expires=0 — снятие подписки, зачистка);
     * auth — значение Authorization для повтора после 401.
     */
    subscribe_message(expires?: number, auth?: string): string
    {
        const s = this.spec;
        const ttl = expires ?? s.expires ?? 600;
        const body = expires === 0 ? '' : (s.body ?? '');
        const extra = [`Event: ${s.event}`, `Expires: ${ttl}`, 'Allow: NOTIFY'];
        if (auth) extra.push(`Authorization: ${auth}`);
        return build_sip_request('SUBSCRIBE', {
            ruri: this.ruri(),
            from_uri: `sip:${s.local.number}@${s.via_host}`,
            to_uri: `sip:${s.remote_number}@${s.target.host}`,
            call_id: this.call_id,
            cseq: this.next_cseq(),
            from_tag: this.from_tag,
            to_tag: this.to_tag || undefined,
            // Contact user = номер абонента (грабль стенда: иначе 401/403).
            contact: `sip:${s.local.number}@${s.via_host}`,
            via_host: s.via_host,
            content_type: expires === 0 ? undefined : s.content_type,
            body,
            extra_headers: extra,
            user_agent: 'losmem-gen/1.0',
        });
    }

    /**
     * NOTIFY «в диалоге»: RURI/To-tag — удалённый target диалога;
     * Subscription-State обязателен (pjsip-evsub без него отвечает 400,
     * 12.log), остаток — от истечения по 200-ответу (вслепую — 600).
     */
    notify_message(body: string, content_type: string, extra: string[] = []): string
    {
        const s = this.spec;
        return build_sip_request('NOTIFY', {
            ruri: `sip:${s.remote_number}@${this.remote.host}:${this.remote.port}`,
            from_uri: `sip:${s.local.number}@${s.via_host}`,
            to_uri: `sip:${s.remote_number}@${s.target.host}`,
            call_id: this.call_id,
            cseq: this.next_cseq(),
            from_tag: this.from_tag,
            to_tag: this.to_tag || undefined,
            contact: `sip:${s.local.number}@${s.via_host}`,
            via_host: s.via_host,
            content_type,
            body,
            extra_headers: [
                ...extra,
                `Event: ${s.event}`,
                `Subscription-State: ${subscription_state_value(this.expires_at)}`,
            ],
            user_agent: 'losmem-gen/1.0',
        });
    }

    /**
     * Отправить SUBSCRIBE, при 401 повторить с Authorization: Digest (учётка
     * local.number/password) и взять To-tag/Contact из финального ответа.
     * false — ответа нет; отказ станции (489/403/…) остаётся в open_status.
     */
    async open(timeout_ms = 5000): Promise<boolean>
    {
        const s = this.spec;
        const wait = s.client.wait_response(this.call_id, timeout_ms);
        await s.client.send(this.subscribe_message());
        let raw = await wait;
        let head = raw ? parse_sip_response(raw) : null;
        this.open_status = head?.status ?? 0;
        const ch = raw ? parse_digest_challenge(raw) : null;
        if (head?.status === 401 && ch)
        {
            const auth = build_digest_authorization('SUBSCRIBE', ch, {
                user: s.local.number,
                password: s.local.password,
                uri: this.ruri(),
            });
            const wait2 = s.client.wait_response(this.call_id, timeout_ms);
            await s.client.send(this.subscribe_message(undefined, auth));
            raw = await wait2;
            head = raw ? parse_sip_response(raw) : null;
            this.open_status = head?.status ?? 0;
        }
        if (!head) return false;
        // To-tag/Contact берём только из 2xx: tag из 403/489 — не диалог,
        // NOTIFY с ним станция читает иначе (500 вместо честного 481).
        if (head.status >= 200 && head.status < 300)
        {
            this.to_tag = head.to_tag;
            // Подписка принята — фиксируем истечение (наш запросанный
            // Expires) для Subscription-State последующих NOTIFY.
            const ttl = s.expires ?? 600;
            this.expires_at = new Date(Date.now() + ttl * 1000).toISOString();
            const contact = head.contact_uri
                ? uri_host_port(head.contact_uri, s.target.port)
                : undefined;
            if (contact) this.remote = contact;
        }
        return true;
    }

    /** Снятие подписки (expires=0) — graceful-зачистка прогона. */
    async unsubscribe(): Promise<void>
    {
        try
        {
            await this.spec.client.send(this.subscribe_message(0));
        }
        catch
        {
            /* сокет мог быть уже закрыт зачисткой — сигнал игнорируем */
        }
    }
}

// ---------- T1: NOTIFY с битым dialog-info (кандидат A) ----------

/** Честная пометка итога SUBSCRIBE: диалог или «NOTIFY вслепую». */
function log_open_result(ctx: ScenarioCtx, dialog: SubDialog, event: string): void
{
    if (dialog.open_status >= 200 && dialog.open_status < 300)
    {
        ctx.log(`SUBSCRIBE ${event} → ${dialog.open_status}, диалог открыт`);
    }
    else
    {
        const why = dialog.open_status
            ? `станция ответила ${dialog.open_status}`
            : 'ответа станции нет';
        ctx.log(
            `SUBSCRIBE ${event} → ${why}: NOTIFY пойдут без принятого диалога ` +
                '(parse-путь станции может не достигаться — фиксируем честно), ' +
                'стимул продолжаем',
        );
    }
}

/** T1: NOTIFY телами-вариантами a–f в подписочном диалоге dialog-info. */
async function t1(ctx: ScenarioCtx): Promise<string>
{
    const sub = ctx.config.subscribers[0];
    const client = await new_client(ctx);
    ctx.phase('T1: register');
    const reg = await register_raw(ctx, client, sub);
    ctx.log(
        `REGISTER ${sub.number} → ${reg.code || 'нет ответа'}; ` +
            'NOTIFY пойдут в диалоги станции, если она подписана на номер ' +
            '(BLF/SSW в конфиге АТС), — иначе вслепую',
    );
    const station = new StationSubscriptions(client, ctx.via_host, sub, ctx.station_subs);
    const dialog = new SubDialog({
        client,
        // Имя пакета — `dialog` (RFC 4235): станция на `dialog-info` как UAS
        // даёт 489, на `dialog` — 401→Digest→403 без BLF-настройки (зонд
        // doc/.probe_losmem_events.ts); тело остаётся dialog-info+xml.
        event: 'dialog',
        local: sub,
        remote_number: ctx.config.subscribers[1].number,
        target: ctx.target,
        via_host: ctx.via_host,
        content_type: DIALOG_INFO_CONTENT_TYPE,
    });
    ctx.phase('T1: subscribe dialog');
    await dialog.open();
    log_open_result(ctx, dialog, 'dialog');

    const variants: DialogInfoVariant[] =
        ctx.opts.variant === 'all'
            ? [...DIALOG_INFO_VARIANTS]
            : [ctx.opts.variant as DialogInfoVariant];
    ctx.log(`варианты тел: ${variants.join(',')}, темп ${ctx.opts.rate}/с`);
    ctx.phase('stim_start');
    let via_station = 0;
    const sent = await paced_loop(
        ctx,
        ctx.opts.minutes * 60_000,
        ctx.opts.rate,
        async (i) =>
        {
            const v = variants[i % variants.length];
            // «e» — корректное тело + ЛИШНИЙ Content-Encoding (план T1 e).
            const extra = v === 'e' ? ['Content-Encoding: gzip'] : [];
            const body = dialog_info_body(v, sub.number);
            const station_msg = station.next_notify(body, DIALOG_INFO_CONTENT_TYPE, [
                'dialog',
                'dialog-info',
            ]);
            if (station_msg)
            {
                via_station += 1;
                await send_notify(ctx, client, station_msg);
            }
            else
            {
                await send_notify(
                    ctx,
                    client,
                    dialog.notify_message(body, DIALOG_INFO_CONTENT_TYPE, extra),
                );
            }
        },
    );
    ctx.phase('stim_stop');
    await dialog.unsubscribe();
    await reg.release();
    const summary =
        `NOTIFY отправлено ${sent} (variant=${ctx.opts.variant}, ` +
        `${ctx.opts.minutes} мин @ ${ctx.opts.rate}/с), из них в диалоги ` +
        `станции ${via_station} (её подписок: ${station.active_count()}, ` +
        `пакеты: ${station.active_events().join(',') || '—'}); ответы станции: ` +
        `${fmt_counts(client.answered)}`;
    client.close();
    return summary;
}

// ---------- T2: event-list oversized property (кандидат B) ----------

/** Соответствие --kind → длины полей тела T2 (план §3 T2 a/b/c). */
function t2_lengths(ctx: ScenarioCtx): SimpleListOptions
{
    switch (ctx.opts.kind)
    {
        case 'value':
            return { properties: ctx.opts.props, value_len: 137, name_len: 8 };
        case 'name':
            return { properties: ctx.opts.props, value_len: 8, name_len: 33 };
        default:
            // гибрид (критический «c»): сотни свойств по 137 байт в NOTIFY
            return { properties: ctx.opts.props, value_len: 137, name_len: 33 };
    }
}

/** T2: NOTIFY event-list с oversized-свойствами (simple-list+xml). */
async function t2(ctx: ScenarioCtx): Promise<string>
{
    const sub = ctx.config.subscribers[0];
    const lens = t2_lengths(ctx);
    const body = simple_list_body(lens);
    const client = await new_client(ctx);
    ctx.phase('T2: register');
    const reg = await register_raw(ctx, client, sub);
    ctx.log(
        `REGISTER ${sub.number} → ${reg.code || 'нет ответа'}; при SSW_SRVM-` +
            'подписке АТС на этот номер NOTIFY пойдут в её диалог (путь ' +
            'ss_on_rx_notify), иначе вслепую',
    );
    const station = new StationSubscriptions(client, ctx.via_host, sub, ctx.station_subs);
    const dialog = new SubDialog({
        client,
        event: 'event-list',
        local: sub,
        remote_number: ctx.config.subscribers[1].number,
        target: ctx.target,
        via_host: ctx.via_host,
        content_type: SIMPLE_LIST_CONTENT_TYPE,
    });
    ctx.phase('T2: subscribe event-list');
    await dialog.open();
    // Пакет event-list станция как UAS не принимает (489, зонд
    // doc/.probe_losmem_events.ts) — он у неё живёт только на исходящей
    // подписке SSW_SRVM к провайдеру; NOTIFY достают парсер ядра, достает ли
    // ss_on_rx_notify — решает конфигурация станции, лог ниже честен.
    log_open_result(ctx, dialog, 'event-list');
    ctx.log(
        `свойств в NOTIFY: ${lens.properties}, value=${lens.value_len}, ` +
            `name=${lens.name_len} (лимит станции 32), темп ${ctx.opts.rate}/с`,
    );
    ctx.phase('stim_start');
    let via_station = 0;
    const sent = await paced_loop(
        ctx,
        ctx.opts.minutes * 60_000,
        ctx.opts.rate,
        async () =>
        {
            const station_msg = station.next_notify(body, SIMPLE_LIST_CONTENT_TYPE);
            if (station_msg)
            {
                via_station += 1;
                await send_notify(ctx, client, station_msg);
            }
            else
            {
                await send_notify(
                    ctx,
                    client,
                    dialog.notify_message(body, SIMPLE_LIST_CONTENT_TYPE),
                );
            }
        },
    );
    ctx.phase('stim_stop');
    await dialog.unsubscribe();
    await reg.release();
    const props_total = sent * lens.properties;
    const summary =
        `NOTIFY отправлено ${sent} (kind=${ctx.opts.kind}, ` +
        `props=${lens.properties}; свойств всего ${props_total}), тело ` +
        `${Buffer.byteLength(body, 'utf8')} байт, в диалоги станции ` +
        `${via_station} (её подписок: ${station.active_count()}, пакеты: ` +
        `${station.active_events().join(',') || '—'}); ответы станции: ` +
        `${fmt_counts(client.answered)}`;
    client.close();
    return summary;
}

// ---------- T3: дубли подписок (кандидат C) ----------

/**
 * T3: цикл «полный конфиг подписок → пауза → повтор» (эмуляция повторного
 * Total config от app, план §3 T3). Каждый цикл — НОВЫЙ сокет (эмуляция
 * рестарта app: прежние подписки активны, новые дублируют их по
 * from/to/event — станция должна писать `already active`).
 */
async function t3(ctx: ScenarioCtx): Promise<string>
{
    let sent_subs = 0;
    const answered = new Map<string, number>();
    for (let cycle = 1; cycle <= ctx.opts.cycles; cycle++)
    {
        if (ctx.stopped()) break;
        ctx.phase(`T3: cycle ${cycle}/${ctx.opts.cycles}`);
        const client = await new_client(ctx); // новый src-порт — как рестарт app
        for (const sub of ctx.config.subscribers)
        {
            if (!sub.can_register || ctx.stopped()) continue;
            // Короткая регистрация: binding по Contact нужен, чтобы станция
            // считала нас легитимным подписчиком (сокет цикла умрёт — binding
            // истечёт сам).
            await register_raw(ctx, client, sub, 120);
            // `dialog` — поддерживаемый станцией пакет BLF (см. T1);
            // event-list остаётся как в логах SSW_SRVM (UAS даёт 489 —
            // дубль-подписка на стороне станции от нас недоступна).
            for (const ev of ['dialog', 'event-list'])
            {
                const dialog = new SubDialog({
                    client,
                    event: ev,
                    local: sub,
                    remote_number: ctx.config.subscribers[1].number,
                    target: ctx.target,
                    via_host: ctx.via_host,
                    content_type:
                        ev === 'dialog'
                            ? DIALOG_INFO_CONTENT_TYPE
                            : SIMPLE_LIST_CONTENT_TYPE,
                });
                await dialog.open(2000); // ждём ответ коротко — ради счётчиков
                sent_subs += 1;
            }
        }
        for (const [k, n] of client.answered)
        {
            answered.set(k, (answered.get(k) ?? 0) + n);
        }
        client.close(); // подписки станции остаются — дубли следующий цикл
        if (cycle < ctx.opts.cycles) await wait_ms(ctx.opts.pause_s * 1000, ctx.stopped);
    }
    const summary =
        `циклов ${ctx.opts.cycles}, SUBSCRIBE отправлено ${sent_subs} ` +
        `(дубли активных подписок); ответы станции: ${fmt_counts(answered)}`;
    return summary;
}

// ---------- T4: 401 с неизвестным realm (кандидат D) ----------

/**
 * T4: две ноги. (a) «провайдер-401» — UDP-порт этой машины отвечает
 * `401 realm="GUmvd"` на REGISTER/OPTIONS/SUBSCRIBE станции (сработает,
 * когда транк АТС настроен на нас; 0 входящих в сводке = транк не смотрит
 * сюда — это не ошибка прогона). (b) быстрая альтернатива плана — частые
 * исходящие OPTIONS от абонентов к станции.
 */
async function t4(ctx: ScenarioCtx): Promise<string>
{
    const responder = new RawUdpResponder(ctx.opts.provider_port);
    await responder.listen();
    ctx.log(
        `провайдер-401 слушает :${ctx.opts.provider_port} ` +
            `(realm="GUmvd") — настройте транк АТС на этот адрес, если нужно`,
    );
    const auth_401_sent = { n: 0 };
    responder.on_request((raw, from) =>
    {
        const method = (raw.split(' ')[0] ?? '?').toUpperCase();
        responder.requests_in.set(method, (responder.requests_in.get(method) ?? 0) + 1);
        if (!['REGISTER', 'OPTIONS', 'SUBSCRIBE'].includes(method)) return;
        const answer = build_sip_response(401, 'Unauthorized', raw, [
            'WWW-Authenticate: Digest realm="GUmvd", nonce="losmem-nonce", ' +
                'stale=false',
            'Server: losmem-provider/1.0',
        ]);
        responder.send_to(answer, from.host, from.port).catch(() =>
        {
            /* пир мог закрыться — сводка по счетчикам полна и без этого */
        });
        auth_401_sent.n += 1;
    });

    const client = await new_client(ctx);
    ctx.phase('stim_start');
    const subs = ctx.config.subscribers;
    const sent = await paced_loop(
        ctx,
        ctx.opts.minutes * 60_000,
        ctx.opts.rate,
        async (i) =>
        {
            const sub = subs[i % subs.length];
            // OPTIONS keepalive «каждый порт» (быстрая альтернатива T4).
            await client.send(
                build_sip_request('OPTIONS', {
                    ruri: `sip:${sub.number}@${ctx.target.host}:${ctx.target.port}`,
                    from_uri: `sip:${sub.number}@${ctx.via_host}`,
                    to_uri: `sip:${sub.number}@${ctx.target.host}`,
                    call_id: `losmem-t4-${rnd(8)}`,
                    cseq: 1,
                    from_tag: `los-${rnd(6)}`,
                    contact: `sip:${sub.number}@${ctx.via_host}`,
                    via_host: ctx.via_host,
                    user_agent: 'losmem-gen/1.0',
                }),
            );
        },
    );
    ctx.phase('stim_stop');
    client.close();
    const from_station = fmt_counts(responder.requests_in);
    responder.close();
    return (
        `OPTIONS к станции отправлено ${sent} (ответы: ` +
        `${fmt_counts(client.answered)}); «провайдеру-401» станция прислала ` +
        `запросов: ${from_station}, 401 отвечено ${auth_401_sent.n} ` +
        '(0 входящих — транк АТС на нас не настроен)'
    );
}

// ---------- T5: flood «не от транка» (кандидат F) ----------

/** SDP-заглушка INVITE для T5 (медиа нет никогда: m=audio 9 + inactive). */
function stub_sdp(ctx: ScenarioCtx): string
{
    return (
        `v=0\r\n` +
        `o=- 1 1 IN IP4 ${ctx.via_host}\r\n` +
        `s=-\r\n` +
        `c=IN IP4 ${ctx.via_host}\r\n` +
        `t=0 0\r\n` +
        `m=audio 9 RTP/AVP 0\r\n` +
        `a=inactive\r\n`
    );
}

/**
 * T5: с ОТДЕЛЬНЫХ сокетов (свои эфемерные src-порты, незнакомые From/Contact)
 * слать a) REGISTER cseq=1 повторно, b) SUBSCRIBE cseq=1 на несуществующий
 * контакт, c) INVITE cseq=1 с неизвестным From (план §3 T5 — сканер).
 * Call-ID каждого варианта постоянен — «пересоздаёт диалог с нуля», как в
 * проде. После flood'а — пауза наблюдения (план: 15 мин, --observe-min=0 —
 * пропустить): ответы 4xx уходят, транзакции завершаются.
 */
async function t5(ctx: ScenarioCtx): Promise<string>
{
    const scanners = ['losmem9901', 'losmem9902', 'losmem9903'];
    const call_ids = [rnd(8), rnd(8), rnd(8)];
    const clients: RawSipClient[] = [];
    for (let i = 0; i < 3; i++) clients.push(await new_client(ctx));

    const send_variant = async (i: number): Promise<void> =>
    {
        const base = {
            from_uri: `sip:${scanners[i]}@${ctx.via_host}`,
            call_id: `losmem-t5-${call_ids[i]}`,
            cseq: 1, // сканер: вечно cseq=1
            from_tag: `los-${rnd(6)}`,
            contact: `sip:${scanners[i]}@${ctx.via_host}`,
            via_host: ctx.via_host,
            user_agent: 'losmem-gen/1.0',
        };
        let message: string;
        if (i === 0)
        {
            message = build_sip_request('REGISTER', {
                ...base,
                ruri: `sip:${ctx.target.host}:${ctx.target.port}`,
                to_uri: `sip:${scanners[i]}@${ctx.target.host}`,
                extra_headers: ['Expires: 60'],
            });
        }
        else if (i === 1)
        {
            message = build_sip_request('SUBSCRIBE', {
                ...base,
                ruri: `sip:nosuch12345@${ctx.target.host}:${ctx.target.port}`,
                to_uri: `sip:nosuch12345@${ctx.target.host}`,
                extra_headers: ['Event: dialog-info', 'Expires: 600'],
            });
        }
        else
        {
            message = build_sip_request('INVITE', {
                ...base,
                ruri: `sip:nosuch11111@${ctx.target.host}:${ctx.target.port}`,
                to_uri: `sip:nosuch11111@${ctx.target.host}`,
                content_type: 'application/sdp',
                body: stub_sdp(ctx),
            });
        }
        await clients[i].send(message);
    };

    ctx.phase('stim_start');
    const sent_rounds = await paced_loop(
        ctx,
        ctx.opts.minutes * 60_000,
        ctx.opts.rate,
        async (i) =>
        {
            for (let v = 0; v < 3; v++) await send_variant((i + v) % 3);
        },
    );
    ctx.phase('stim_stop');
    if (ctx.opts.observe_min > 0 && !ctx.stopped())
    {
        // Наблюдение без стимула (план T5 «Контроль»): ответы розданы,
        // транзакции завершаются — оператор по CSV смотрит возврат RSS.
        ctx.log(`наблюдение ${ctx.opts.observe_min} мин без стимула…`);
        await wait_ms(ctx.opts.observe_min * 60_000, ctx.stopped);
    }
    ctx.phase('observe_stop');
    const answered = new Map<string, number>();
    for (const c of clients)
    {
        for (const [k, n] of c.answered) answered.set(k, (answered.get(k) ?? 0) + n);
        c.close();
    }
    return (
        `раундов ${sent_rounds} × 3 варианта (REGISTER/SUBSCRIBE/INVITE ` +
        `cseq=1 с чужих портов) = ${sent_rounds * 3} сообщений @ ` +
        `${ctx.opts.rate}/с на вариант; ответы станции: ${fmt_counts(answered)}; ` +
        `наблюдение ${ctx.opts.observe_min} мин`
    );
}

// ---------- T6: невалидные IPC subscribe (кандидат E) ----------

/**
 * T6: генератор IPC-кадров subscribe (type 54) с битыми полями. Разъём
 * app↔адаптер с этой машины недоступен (закрытая прошивка), поэтому кадр
 * либо пишется в hex-файл (дампование для ручного.inject), либо — при
 * --ipc-cmd — передаётся на stdin команды-обёртки (оператор подставляет
 * свой транспорт: nc, сокет-прокси и т.п.). Вердикта нет: кадры ушли —
 * прогон успешен.
 */
async function t6(ctx: ScenarioCtx): Promise<string>
{
    const frames = ipc_subscribe_frames(ctx.opts.count);
    if (!ctx.opts.ipc_cmd)
    {
        const out = path.join(
            ctx.reports_dir,
            `los_t6_ipc_${new Date().toISOString().replace(/[:.]/g, '-')}.hex`,
        );
        fs.mkdirSync(ctx.reports_dir, { recursive: true });
        fs.writeFileSync(out, frames.join('\n') + '\n');
        return (
            `кадров subscribe(type 54) сгенерировано ${frames.length}, дамп: ` +
            `${out}; IPC-разъём app↔адаптер с этой машины недоступен — ` +
            'передайте кадры своим транспортом или запустите с --ipc-cmd'
        );
    }
    ctx.phase('stim_start');
    const child = spawn('sh', ['-c', ctx.opts.ipc_cmd], {
        stdio: ['pipe', 'inherit', 'inherit'],
    });
    const closed = new Promise<number>((resolve) =>
    {
        child.on('close', (code) => resolve(code ?? -1));
        child.on('error', () => resolve(-1));
    });
    let written = 0;
    for (const frame of frames)
    {
        if (ctx.stopped()) break;
        if (!child.stdin?.write(frame + '\n'))
        {
            await new Promise<void>((r) => child.stdin?.once('drain', () => r()));
        }
        written += 1;
        if (written % 1000 === 0) ctx.tick(written);
    }
    child.stdin?.end();
    const kill_timer = setTimeout(() => child.kill(), 60_000);
    const code = await closed;
    clearTimeout(kill_timer);
    ctx.phase('stim_stop');
    return (
        `кадров subscribe(type 54) передано на stdin «${ctx.opts.ipc_cmd}»: ` +
        `${written} из ${frames.length}, код команды ${code}`
    );
}

// ---------- T7: resolver-шторм (косвенный кандидат) ----------

/**
 * T7: поток запросов, Request-URI которых — доменные имена: маршрутизируя
 * их, станция гонит резолв через ext_domain_resolver/mod_rdn (план §3 T7).
 * Домен по умолчанию в .invalid (RFC 6761 — гарантированный NXDOMAIN:
 * ответы резолвера копятся в очереди). 35/с — прод-темп из res.md.
 */
async function t7(ctx: ScenarioCtx): Promise<string>
{
    const client = await new_client(ctx);
    const sub = ctx.config.subscribers[0];
    ctx.log(`домен шторма: ${ctx.opts.domain} (NXDOMAIN), темп ${ctx.opts.rate}/с`);
    ctx.phase('stim_start');
    let subcribes_toggle = false;
    const sent = await paced_loop(
        ctx,
        ctx.opts.minutes * 60_000,
        ctx.opts.rate,
        async (i) =>
        {
            subcribes_toggle = !subcribes_toggle;
            // чередуем OPTIONS/SUBSCRIBE — оба идут через резолвер станции
            const method = subcribes_toggle ? 'OPTIONS' : 'SUBSCRIBE';
            const message = build_sip_request(method, {
                ruri: `sip:losmem-${i}.${ctx.opts.domain}`,
                from_uri: `sip:${sub.number}@${ctx.via_host}`,
                to_uri: `sip:storm.${ctx.opts.domain}`,
                call_id: `losmem-t7-${rnd(10)}`,
                cseq: 1,
                from_tag: `los-${rnd(6)}`,
                contact: `sip:${sub.number}@${ctx.via_host}`,
                via_host: ctx.via_host,
                extra_headers:
                    method === 'SUBSCRIBE' ? ['Event: presence', 'Expires: 600'] : [],
                user_agent: 'losmem-gen/1.0',
            });
            await client.send(message);
        },
    );
    ctx.phase('stim_stop');
    const summary =
        `запросов на доменные RURI отправлено ${sent} @ ${ctx.opts.rate}/с ` +
        `(domain=${ctx.opts.domain}); ответы станции: ` +
        `${fmt_counts(client.answered)}`;
    client.close();
    return summary;
}

// ---------- T8: комбинированный продакшен-реплей ----------

/**
 * T8: параллельные фоны prod-картины (план §3 T8): битые dialog-info NOTIFY
 * 1.5/с + редкие event-list NOTIFY + чужие REGISTER cseq=1 1/с. Долгий soak
 * (--minutes до 720–1440) — оператор ждёт деградации по своему мониторингу.
 */
async function t8(ctx: ScenarioCtx): Promise<string>
{
    const sub = ctx.config.subscribers[0];
    const counters: Record<string, number> = { notify: 0, event_list: 0, reg: 0 };

    // фон 1: битые dialog-info NOTIFY (пакет `dialog` — см. T1); REGISTER +
    // пассивный UAS — чтобы при настроенном BLF попасть в диалог станции
    const c1 = await new_client(ctx);
    const reg1 = await register_raw(ctx, c1, sub);
    const st1 = new StationSubscriptions(c1, ctx.via_host, sub, ctx.station_subs);
    const d1 = new SubDialog({
        client: c1,
        event: 'dialog',
        local: sub,
        remote_number: ctx.config.subscribers[1].number,
        target: ctx.target,
        via_host: ctx.via_host,
        content_type: DIALOG_INFO_CONTENT_TYPE,
    });
    // фон 2: event-list NOTIFY (редко — раз в 30 с)
    const c2 = await new_client(ctx);
    const reg2 = await register_raw(ctx, c2, sub);
    const st2 = new StationSubscriptions(c2, ctx.via_host, sub, ctx.station_subs);
    const d2 = new SubDialog({
        client: c2,
        event: 'event-list',
        local: sub,
        remote_number: ctx.config.subscribers[1].number,
        target: ctx.target,
        via_host: ctx.via_host,
        content_type: SIMPLE_LIST_CONTENT_TYPE,
    });
    // фон 3: чужой REGISTER cseq=1 (сканер)
    const c3 = await new_client(ctx);
    const scan_call = `losmem-t8-${rnd(8)}`;
    await Promise.all([d1.open(3000), d2.open(3000)]);
    const evs = [...st1.active_events(), ...st2.active_events()].join(',');
    ctx.log(
        `регистрации фонов: ${reg1.code}/${reg2.code}; диалогов станции: ` +
            `${st1.active_count()}+${st2.active_count()} ` +
            `(пакеты: ${evs || '—'})`,
    );
    log_open_result(ctx, d1, 'dialog');
    log_open_result(ctx, d2, 'event-list');

    const duration = ctx.opts.minutes * 60_000;
    ctx.phase('stim_start');
    const variant: DialogInfoVariant =
        ctx.opts.variant === 'all' ? 'a' : (ctx.opts.variant as DialogInfoVariant);
    await Promise.all([
        paced_loop(ctx, duration, 1.5, async (i) =>
        {
            counters.notify += 1;
            const body = dialog_info_body(variant, sub.number);
            const msg =
                st1.next_notify(body, DIALOG_INFO_CONTENT_TYPE, [
                    'dialog',
                    'dialog-info',
                ]) ?? d1.notify_message(body, DIALOG_INFO_CONTENT_TYPE);
            await c1.send(msg);
            void i;
        }),
        paced_loop(ctx, duration, 1 / 30, async () =>
        {
            counters.event_list += 1;
            const body = simple_list_body({
                properties: 200,
                value_len: 137,
                name_len: 33,
            });
            const msg =
                st2.next_notify(body, SIMPLE_LIST_CONTENT_TYPE) ??
                d2.notify_message(body, SIMPLE_LIST_CONTENT_TYPE);
            await c2.send(msg);
        }),
        paced_loop(ctx, duration, 1, async () =>
        {
            counters.reg += 1;
            await c3.send(
                build_sip_request('REGISTER', {
                    ruri: `sip:${ctx.target.host}:${ctx.target.port}`,
                    from_uri: 'sip:losmem8801@' + ctx.via_host,
                    to_uri: `sip:losmem8801@${ctx.target.host}`,
                    call_id: scan_call,
                    cseq: 1,
                    from_tag: 'los-t8scan',
                    contact: 'sip:losmem8801@' + ctx.via_host,
                    via_host: ctx.via_host,
                    extra_headers: ['Expires: 60'],
                    user_agent: 'losmem-gen/1.0',
                }),
            );
        }),
    ]);
    ctx.phase('stim_stop');
    await Promise.all([
        d1.unsubscribe(),
        d2.unsubscribe(),
        reg1.release(),
        reg2.release(),
    ]);
    const answered = new Map<string, number>();
    for (const c of [c1, c2, c3])
    {
        for (const [k, n] of c.answered) answered.set(k, (answered.get(k) ?? 0) + n);
        c.close();
    }
    return (
        `soak ${ctx.opts.minutes} мин: dialog-info NOTIFY ${counters.notify}, ` +
        `event-list NOTIFY ${counters.event_list}, чужих REGISTER ${counters.reg}; ` +
        `диалогов станции: ${st1.active_count()}+${st2.active_count()}, пакеты: ` +
        `${evs || '—'}; ` +
        `ответы станции: ${fmt_counts(answered)}`
    );
}

// ---------- реестр ----------

/**
 * Реестр сценариев T1–T8 (id CLI `t1..t8`); дефолты темпа/длительности —
 * из doc/los_mem/plan_test.md §3, всё переопределяется флагами CLI.
 */
export const LOS_SCENARIOS: Record<string, ScenarioDef> = {
    t1: {
        title: 'T1 — NOTIFY с битым dialog-info (кандидат A, blf_on_rx_notify)',
        plan_ref: 'doc/los_mem/plan_test.md §3 T1',
        defaults: { minutes: 30, rate: 1.5, variant: 'a' },
        run: t1,
    },
    t2: {
        title: 'T2 — event-list NOTIFY oversized property (кандидат B)',
        plan_ref: 'doc/los_mem/plan_test.md §3 T2',
        defaults: { minutes: 30, rate: 1, kind: 'hybrid', props: 500 },
        run: t2,
    },
    t3: {
        title: 'T3 — дубли подписок / повторный Total config (кандидат C)',
        plan_ref: 'doc/los_mem/plan_test.md §3 T3',
        defaults: { cycles: 5, pause_s: 180 },
        run: t3,
    },
    t4: {
        title: 'T4 — 401 с неизвестным realm GUmvd (кандидат D, sip_auth_client)',
        plan_ref: 'doc/los_mem/plan_test.md §3 T4',
        defaults: { minutes: 1440, rate: 2, provider_port: 5061 },
        run: t4,
    },
    t5: {
        title: 'T5 — flood «не от транка» REGISTER/SUBSCRIBE/INVITE (кандидат F)',
        plan_ref: 'doc/los_mem/plan_test.md §3 T5',
        defaults: { minutes: 60, rate: 2, observe_min: 15 },
        run: t5,
    },
    t6: {
        title: 'T6 — невалидные IPC subscribe type 54 (кандидат E, ipc.c)',
        plan_ref: 'doc/los_mem/plan_test.md §3 T6',
        defaults: { count: 10_000 },
        run: t6,
    },
    t7: {
        title: 'T7 — resolver-шторм на доменные RURI (ext_domain_resolver)',
        plan_ref: 'doc/los_mem/plan_test.md §3 T7',
        defaults: { minutes: 30, rate: 35, domain: 'losmem-storm.invalid' },
        run: t7,
    },
    t8: {
        title: 'T8 — комбинированный продакшен-реплей (soak до деградации)',
        plan_ref: 'doc/los_mem/plan_test.md §3 T8',
        defaults: { minutes: 720, variant: 'a' },
        run: t8,
    },
};
