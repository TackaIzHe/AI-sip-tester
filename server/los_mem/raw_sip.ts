// Сырой SIP-слой генератора стимулов (doc/los_mem/plan_test.md T1–T8):
// сборка запросов произвольной формы и отправка поверх dgram/net.
//
// sip.js здесь НЕ используется намеренно: UA из server/sip/ умеет только
// REGISTER/INVITE/BYE/CANCEL, не отправляет SUBSCRIBE/NOTIFY и не пропускает
// невалидные сообщения (битые XML-тела, мусор после Content-Length, обрезанные
// тела) — а тестам утечек нужны ровно они (план §2.1 «возможность шить битые
// сообщения»). Повторное использование src-порта (план §2.1) — local_port у
// UDP-сокета; внешний сокет (udp_socket) — станция-эмулятор отдаёт свой :5060,
// чтобы стимул уходил от адреса станции, а keep-alive пира по Contact возвращался
// на неё же (doc/task_25_plan_2.md); входящие на внешний сокет подаёт владелец
// через feed(). Via с rport и sent-by без порта — грабли стенда (CLAUDE.md),
// те же, что в server/sip/sip_node_transport.ts.
// related: server/los_mem/bodies.ts (тела-стимулы),
// server/los_mem/scenarios.ts (сценарии), doc/los_mem/plan_test.md §2.1,
// doc/sip_rfc.md §6 (заголовки), §13 (транспорты).

import dgram from 'node:dgram';
import net from 'node:net';
import crypto from 'node:crypto';

// ---------- сборка сообщений ----------

/** Параметры build_sip_request: один запрос SIP/2.0 произвольной формы. */
export interface SipRequestOptions
{
    /** Request-URI (`sip:52@192.168.80.157:5060`). */
    ruri: string;
    from_uri: string;
    to_uri: string;
    call_id: string;
    /** Номер CSeq — инкремент на заботе вызывающего (dialog.next_cseq()). */
    cseq: number;
    from_tag: string;
    /** To-tag из ответа станции — обязателен в диалоге (NOTIFY в подписке). */
    to_tag?: string;
    contact?: string;
    /** Хост в sent-by Via: реальный IP этой машины, БЕЗ порта (SanityCheck). */
    via_host: string;
    /**
     * Дополнительные строки Via ПОСЛЕ основного (Via нижестоящего хопа при
     * ретрансляции, doc/task_31_plan_2.md) — ПОЛНЫЕ строки заголовка
     * `Via: SIP/2.0/…` (как extra_headers): build_sip_response копирует эхом
     * строки по `^via:`, значение без имени заголовка в эхо не попадёт.
     */
    via_extra?: string[];
    proto?: 'udp' | 'tcp';
    content_type?: string;
    body?: string;
    /** Произвольные заголовки (Event, Allow, Content-Encoding — «лишний»). */
    extra_headers?: string[];
    branch?: string;
    user_agent?: string;
    max_forwards?: number;
    /**
     * Поверх байтовой длины тела: битый Content-Length (мусор внутри лимита
     * станция читает как тело, лишнее — как начало следующего сообщения).
     */
    content_length_override?: number;
    /** Мусор ДОСЛЕ тела (при честном Content-Length — «лишние байты»). */
    garbage_after_body?: string;
}

/**
 * Собрать запрос SIP/2.0: заголовки по порядку RFC 3261 (§7.1, doc/sip_rfc.md
 * §6), Via c `rport` и branch `z9hG4bK-…`, Content-Length — БАЙТОВАЯ длина
 * тела (utf8), не символьная.
 */
export function build_sip_request(method: string, o: SipRequestOptions): string
{
    const proto = (o.proto ?? 'udp').toUpperCase();
    const branch = o.branch ?? `z9hG4bK-los-${crypto.randomBytes(6).toString('hex')}`;
    const body = o.body ?? '';
    const lines: string[] = [`${method} ${o.ruri} SIP/2.0`];
    lines.push(`Via: SIP/2.0/${proto} ${o.via_host};rport;branch=${branch}`);
    // Via ретранслируемого хопа — СРАЗУ под нашим (стек Via, RFC 3261 §16.6):
    // до Max-Forwards, порядок строк значим для транзакций нижестоящей АТС.
    for (const v of o.via_extra ?? []) lines.push(v);
    lines.push(`Max-Forwards: ${o.max_forwards ?? 70}`);
    lines.push(`From: <${o.from_uri}>;tag=${o.from_tag}`);
    lines.push(o.to_tag ? `To: <${o.to_uri}>;tag=${o.to_tag}` : `To: <${o.to_uri}>`);
    lines.push(`Call-ID: ${o.call_id}`);
    lines.push(`CSeq: ${o.cseq} ${method}`);
    if (o.user_agent) lines.push(`User-Agent: ${o.user_agent}`);
    if (o.contact) lines.push(`Contact: <${o.contact}>`);
    for (const h of o.extra_headers ?? []) lines.push(h);
    if (body !== '' || o.content_type || o.content_length_override !== undefined)
    {
        if (o.content_type) lines.push(`Content-Type: ${o.content_type}`);
        const len = o.content_length_override ?? Buffer.byteLength(body, 'utf8');
        lines.push(`Content-Length: ${len}`);
    }
    let message = lines.join('\r\n') + '\r\n\r\n' + body;
    if (o.garbage_after_body) message += o.garbage_after_body;
    return message;
}

/**
 * Собрать ответ на запрос: копируются Via (все), From, Call-ID, CSeq; в To
 * дописывается tag, если его нет (RFC 3261 §8.2.6). Нужно «провайдеру-401»
 * сценария T4.
 */
export function build_sip_response(
    status: number,
    reason: string,
    request: string,
    extra_headers: string[] = [],
    to_tag = 'losprov',
): string
{
    const lines = request.split('\r\n');
    const out: string[] = [`SIP/2.0 ${status} ${reason}`];
    const vias = lines.filter((l) => /^via\s*:/i.test(l));
    out.push(...vias);
    for (const name of ['from', 'call-id', 'cseq'])
    {
        const h = lines.find((l) => new RegExp(`^${name}\\s*:`, 'i').test(l));
        if (h) out.push(h);
    }
    const to_line = lines.find((l) => /^to\s*:/i.test(l)) ?? 'To: <sip:unknown>';
    out.push(/;tag=/i.test(to_line) ? to_line : `${to_line};tag=${to_tag}`);
    out.push(...extra_headers);
    out.push('Content-Length: 0');
    return out.join('\r\n') + '\r\n\r\n';
}

/**
 * Значение заголовка `Subscription-State` для NOTIFY (RFC 3265 §4.1.4):
 * active + остаток секунд до истечения подписки. Заголовок ОБЯЗАТЕЛЕН:
 * pjsip-evsub на NOTIFY без него (и у active/pending без параметра
 * `expires`) отвечает 400, не допуская сообщение до обработчиков станции
 * (`sub_on_rx_notify_uac`/`ss_on_rx_notify`), затем ждёт 5 с «subsequent
 * NOTIFY» и отписывается — дамп doc/los_mem/new_log/12.log (17:10:30,
 * 400/NOTIFY → UAC_WAIT_NOTIFY → Unsubscribing). Non-finite expires_at —
 * дефолт 600 (подписки без согласованного Expires).
 */
export function subscription_state_value(expires_at: string): string
{
    const exp = Date.parse(expires_at);
    const left =
        Number.isFinite(exp) && exp > Date.now()
            ? Math.ceil((exp - Date.now()) / 1000)
            : 600;
    return `active;expires=${left}`;
}

// ---------- разбор ответов ----------

/** Минимальный разбор ответа станции (транзакций генератору не нужно). */
export interface SipResponseHead
{
    /** Статус-код; 0 — это запрос, а не ответ. */
    status: number;
    /** Метод из CSeq. */
    cseq_method: string;
    call_id: string;
    /** tag из To (пусто, если не выставлен). */
    to_tag: string;
    /** URI из Contact (пусто, если заголовка нет). */
    contact_uri: string;
}

function header_of(lines: string[], name: string): string
{
    for (const l of lines)
    {
        if (l === '') break; // дальше тело
        const m = new RegExp(`^${name}\\s*:\\s*(.*)$`, 'i').exec(l);
        if (m) return m[1].trim();
    }
    return '';
}

/** Разбор ответа; null — не ответ (запрос или мусор). */
export function parse_sip_response(raw: string): SipResponseHead | null
{
    const lines = raw.split('\r\n');
    const res = /^SIP\/2\.0\s+(\d{3})\s*(.*)$/i.exec(lines[0] ?? '');
    if (!res) return null;
    const cseq_method = (header_of(lines, 'cseq').split(/\s+/)[1] ?? '').toUpperCase();
    const to = header_of(lines, 'to');
    return {
        status: Number(res[1]),
        cseq_method,
        call_id: header_of(lines, 'call-id'),
        to_tag: /;tag=([^;>\s]+)/i.exec(to)?.[1] ?? '',
        contact_uri: /<?(sips?:[^\s;>]+)/i.exec(header_of(lines, 'contact'))?.[1] ?? '',
    };
}

/**
 * Разбор хоста и порта из `sip:[user@]host[:port]` (порт по умолчанию
 * default_port; user-часть Contact Contact-а URI абонента отбрасываем).
 */
export function uri_host_port(
    uri: string,
    default_port: number,
): { host: string; port: number } | undefined
{
    // user/параметры срезаем строками: регулярка с жадным префиксом съедала
    // точки голого `sip:10.0.0.1` (user-части в нём нет).
    const body =
        uri
            .trim()
            .replace(/^sips?:/i, '')
            .split(/[;/]/)[0] ?? '';
    const at = body.lastIndexOf('@');
    const m = /^([^:]+)(?::(\d+))?$/.exec(at >= 0 ? body.slice(at + 1) : body);
    if (!m || !m[1]) return undefined;
    const port = m[2] ? Number(m[2]) : default_port;
    return { host: m[1], port };
}

/** Call-ID любого сообщения (и запроса, и ответа) — для диспатча ожидания. */
export function sip_call_id(raw: string): string
{
    return header_of(raw.split('\r\n'), 'call-id');
}

/** Минимальный разбор входящего запроса (генератор отвечает на SUBSCRIBE). */
export interface SipRequestHead
{
    method: string;
    call_id: string;
    from_uri: string;
    from_tag: string;
    to_uri: string;
    /** tag из To (в SUBSCRIBE станции обычно пуст — диалог ещё без него). */
    to_tag: string;
    contact_uri: string;
    /** Число Expires; без заголовка — -1. 0 — снятие подписки. */
    expires: number;
    /** Имя пакета из Event (без параметров); пусто — заголовка нет. */
    event: string;
}

/**
 * Разбор запроса (первая строка `METHOD RURI SIP/2.0`); null — это ответ
 * или мусор. Нужен пассивному UAS: на стенде blf_on_rx_notify/ss_on_rx_notify
 * живут на ИСХОДЯщих подписках станции (её SUBSCRIBE на Contact абонента,
 * res.md «sub_on_rx_notify_uac»), и единственный легальный способ попасть в
 * них — ответить 200 на её SUBSCRIBE и слать NOTIFY в её диалог.
 */
export function parse_sip_request_head(raw: string): SipRequestHead | null
{
    const lines = raw.split('\r\n');
    const req = /^([A-Z]+)\s+\S+\s+SIP\/2\.0$/i.exec(lines[0] ?? '');
    if (!req) return null;
    const from = header_of(lines, 'from');
    const to = header_of(lines, 'to');
    return {
        method: (req[1] ?? '').toUpperCase(),
        call_id: header_of(lines, 'call-id'),
        from_uri: /<?(sips?:[^\s;>]+)/i.exec(from)?.[1] ?? '',
        from_tag: /;tag=([^;>\s]+)/i.exec(from)?.[1] ?? '',
        to_uri: /<?(sips?:[^\s;>]+)/i.exec(to)?.[1] ?? '',
        to_tag: /;tag=([^;>\s]+)/i.exec(to)?.[1] ?? '',
        contact_uri: /<?(sips?:[^\s;>]+)/i.exec(header_of(lines, 'contact'))?.[1] ?? '',
        expires: Number(header_of(lines, 'expires') || '-1'),
        event: (header_of(lines, 'event').split(';')[0] ?? '').trim(),
    };
}

// ---------- Digest (ответ на 401) ----------

/**
 * Разобранный вызов WWW-Authenticate: Digest из 401.
 */
export interface DigestChallenge
{
    realm: string;
    nonce: string;
    opaque?: string;
    /** Защищённый QOP: 'auth', если сервер его предложил; иначе undefined. */
    qop?: string;
}

/**
 * Разбор WWW-Authenticate из ответа; null — заголовка нет или это не Digest.
 * Нужен потому, что SUBSCRIBE с `Event: dialog` станция пропускает только
 * с авторизацией (зонд doc/.probe_losmem_events.ts: 401 на первый запрос).
 */
export function parse_digest_challenge(raw: string): DigestChallenge | null
{
    const h = header_of(raw.split('\r\n'), 'www-authenticate');
    if (!/^digest/i.test(h.trim())) return null;
    // Параметры `name=value` / `name="value, …"` — словарём: значение qop —
    // кавычка+список, частной регуляркой не вынуть стабильно.
    const params = new Map<string, string>();
    const re = /(\w+)\s*=\s*(?:"([^"]*)"|([^",\s]+))/g;
    for (;;)
    {
        const m = re.exec(h);
        if (!m) break;
        params.set(m[1].toLowerCase(), m[2] ?? m[3] ?? '');
    }
    const nonce = params.get('nonce') ?? '';
    if (!nonce) return null;
    // qop — список (`auth,auth-int`); поддерживаем только auth.
    const qops = (params.get('qop') ?? '').split(',').map((q) => q.trim());
    return {
        realm: params.get('realm') ?? '',
        nonce,
        opaque: params.get('opaque') || undefined,
        qop: qops.includes('auth') ? 'auth' : undefined,
    };
}

/** Параметры build_digest_authorization (Digest-учётка и контекст запроса). */
export interface DigestCredentials
{
    /** Digest username — номер абонента на станции. */
    user: string;
    password: string;
    /** Request-URI авторизуемого запроса (входит в HA2). */
    uri: string;
    /** Для воспроизводимости в тестах; по умолчанию — случайный. */
    cnonce?: string;
    /** Счётчик запросов с этим nonce (RFC 2617), по умолчанию 00000001. */
    nc?: string;
}

/**
 * Значение заголовка Authorization: Digest по RFC 2617 (MD5; при qop=auth
 * — с cnonce/nc) для повторной отправки запроса после 401. Возвращает Value
 * без имени заголовка.
 */
export function build_digest_authorization(
    method: string,
    ch: DigestChallenge,
    o: DigestCredentials,
): string
{
    const md5 = (s: string): string =>
        crypto.createHash('md5').update(s, 'utf8').digest('hex');
    const ha1 = md5(`${o.user}:${ch.realm}:${o.password}`);
    const ha2 = md5(`${method}:${o.uri}`);
    const parts = [
        `username="${o.user}"`,
        `realm="${ch.realm}"`,
        `nonce="${ch.nonce}"`,
        `uri="${o.uri}"`,
    ];
    let response: string;
    if (ch.qop === 'auth')
    {
        const cnonce = o.cnonce ?? crypto.randomBytes(8).toString('hex');
        const nc = o.nc ?? '00000001';
        response = md5(`${ha1}:${ch.nonce}:${nc}:${cnonce}:auth:${ha2}`);
        parts.push('qop=auth', `nc=${nc}`, `cnonce="${cnonce}"`);
    }
    else
    {
        response = md5(`${ha1}:${ch.nonce}:${ha2}`);
    }
    parts.push(`response="${response}"`);
    if (ch.opaque) parts.push(`opaque="${ch.opaque}"`);
    return `Digest ${parts.join(', ')}`;
}

// ---------- сырой клиент ----------

/** Параметры RawSipClient: адрес станции и форма сокета. */
export interface RawSipClientOptions
{
    host: string;
    port: number;
    proto?: 'udp' | 'tcp';
    /**
     * Фиксированный локальный порт — «повторное использование src-порта»
     * (план §2.1); занято/нельзя — connect() бросит.
     */
    local_port?: number;
    /**
     * Внешний уже забинженный UDP-сокет (станция-эмулятор отдаёт свой :5060 —
     * стимул обязан уходить с порта станции, иначе keep-alive пира по Contact
     * уходит на эфемерный порт, см. doc/task_25_plan_2.md). connect() такой
     * сокет НЕ биндит и НЕ навешивает свой слушатель — входящие подают через
     * feed(); close() внешний сокет НЕ закрывает (владелец — станция).
     */
    udp_socket?: dgram.Socket;
}

/**
 * Сырой SIP-клиент: UDP (без connect — принимаем от любого пира) или TCP
 * (фрейминг по Content-Length, как в server/sip/sip_node_transport.ts).
 * Веди счётчики отправленного/ответов для сводки прогона; сырьё не парсит —
 * генератору нужны только счётчики и первый ответ на свой Call-ID.
 */
export class RawSipClient
{
    /** Отправлено запросов по методу. */
    readonly sent_by_method = new Map<string, number>();
    /**
     * Ответы станции: ключ `NOTIFY 200` → количество. Считаем только ответы на
     * СВОИ запросы (Call-ID ∈ out_call_ids): при общем сокете станции хук
     * раздаёт входящие всем клиентам, и без разбора один ответ попадал в
     * сводку каждого (t8 суммировал ×3, план 5 п.2/H3).
     */
    readonly answered = new Map<string, number>();
    /** Принято сообщений (запросов и ответов) всего. */
    received_total = 0;
    /**
     * Call-ID всех ОТПРАВЛЕННЫХ запросов — по ним владелец сокета (хук
     * станции, doc/task_27 план 5 п.2/H3) отличает «ответ на запрос этого
     * клиента» от чужого: без разбора станционный 500 на NOTIFY клиента A
     * попадал в сводку клиента B (t8 суммировал три клиента — троекратный
     * счёт одного ответа).
     */
    readonly out_call_ids = new Set<string>();

    private readonly proto: 'udp' | 'tcp';
    /** true, когда сокет внешний (станционный) — close() его не трогает. */
    private readonly external: boolean;
    private handlers: Array<(raw: string, from: { host: string; port: number }) => void> =
        [];
    /** Ожидание первого ответа на Call-ID (SUBSCRIBE → To-tag диалога). */
    private waiters = new Map<string, Array<(raw: string | undefined) => void>>();
    private udp?: dgram.Socket;
    private tcp?: net.Socket;
    private tcp_buf: Buffer = Buffer.alloc(0);
    private closed = false;

    constructor(private readonly opts: RawSipClientOptions)
    {
        this.proto = opts.proto ?? 'udp';
        this.external = opts.udp_socket !== undefined;
    }

    /** Поднять сокет (UDP bind — почти не бросает; TCP connect — может). */
    connect(): Promise<void>
    {
        if (this.proto === 'udp')
        {
            return this.opts.udp_socket ? this.adopt_udp() : this.open_udp();
        }
        return this.open_tcp();
    }

    /** Отправить сообщение (по умолчанию — на адрес станции). */
    send(message: string, host?: string, port?: number): Promise<void>
    {
        if (this.closed) return Promise.reject(new Error('Клиент закрыт'));
        const method = (message.split(' ')[0] ?? '?').toUpperCase();
        this.sent_by_method.set(method, (this.sent_by_method.get(method) ?? 0) + 1);
        // ответ на этот запрос обязан вернуться именно нам — фиксируем Call-ID
        // для адресной раздачи входящих (хук станции, план 5 п.2/H3).
        const cid = sip_call_id(message);
        if (cid) this.out_call_ids.add(cid);
        if (this.proto === 'udp')
        {
            const sock = this.udp;
            if (!sock) return Promise.reject(new Error('UDP-сокет не поднят'));
            const buf = Buffer.from(message, 'utf8');
            // host/port — адрес ответа src-пирy (200 на её SUBSCRIBE уходит на
            // её src-порт, а не на 5060 станции — иначе станция ответ не примет);
            // без них — штатная цель клиента (план §2.1).
            const dst_host = host ?? this.opts.host;
            const dst_port = port ?? this.opts.port;
            return new Promise((resolve, reject) =>
                sock.send(buf, dst_port, dst_host, (e) => (e ? reject(e) : resolve())),
            );
        }
        const sock = this.tcp;
        if (!sock) return Promise.reject(new Error('TCP-соединение не поднято'));
        void host;
        void port; // TCP — один пир, цель переопределить нельзя
        return new Promise((resolve, reject) =>
            sock.write(message, 'utf8', (e) => (e ? reject(e) : resolve())),
        );
    }

    /** Наблюдатель входящих сообщений; возвращает отписку. */
    on_message(
        cb: (raw: string, from: { host: string; port: number }) => void,
    ): () => void
    {
        this.handlers.push(cb);
        return () =>
        {
            this.handlers = this.handlers.filter((h) => h !== cb);
        };
    }

    /**
     * Дождаться первого ответа на Call-ID (до timeout_ms); undefined — таймаут
     * (станция могла не ответить вовсе — сводка прогона это покажет).
     */
    wait_response(call_id: string, timeout_ms: number): Promise<string | undefined>
    {
        return new Promise((resolve) =>
        {
            const done = (raw: string | undefined) =>
            {
                clearTimeout(timer);
                const left = (this.waiters.get(call_id) ?? []).filter((w) => w !== done);
                if (left.length > 0) this.waiters.set(call_id, left);
                else this.waiters.delete(call_id);
                resolve(raw);
            };
            const timer = setTimeout(() => done(undefined), timeout_ms);
            const list = this.waiters.get(call_id) ?? [];
            list.push(done);
            this.waiters.set(call_id, list);
        });
    }

    /**
     * Локальный порт сокета (после connect) — нужен для Contact с эфемерным
     * портом (грабль стенда: порт — в Contact, не в Via).
     */
    local_port(): number
    {
        if (this.udp) return this.udp.address().port;
        const lp = this.tcp?.localPort ?? 0;
        return lp;
    }

    /** Закрыть сокет; повторный close() — no-op. */
    close(): void
    {
        if (this.closed) return;
        this.closed = true;
        for (const list of this.waiters.values())
        {
            for (const w of list) w(undefined);
        }
        this.waiters.clear();
        this.handlers = [];
        if (this.udp && !this.external)
        {
            try
            {
                this.udp.close();
            }
            catch
            {
                /* уже закрыт */
            }
        }
        // внешний (станционный) сокет не закрываем — владелец станции;
        // waiters/handlers выше уже сняты, входящие на нас больше не придут.
        this.udp = undefined;
        if (this.tcp)
        {
            this.tcp.removeAllListeners();
            try
            {
                this.tcp.destroy();
            }
            catch
            {
                /* уже закрыт */
            }
            this.tcp = undefined;
            this.tcp_buf = Buffer.alloc(0);
        }
    }

    // ---------- внутреннее ----------

    /**
     * Принять внешний сокет (уже забинжен владельцем): слушатель НЕ навешиваем —
     * входящие подаёт владелец через feed().
     */
    private adopt_udp(): Promise<void>
    {
        const sock = this.opts.udp_socket;
        if (!sock) return Promise.reject(new Error('Внешний сокет не передан'));
        this.udp = sock;
        return Promise.resolve();
    }

    private open_udp(): Promise<void>
    {
        return new Promise<void>((resolve, reject) =>
        {
            const sock = dgram.createSocket('udp4');
            sock.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) =>
                this.feed(msg.toString('utf8'), {
                    host: rinfo.address,
                    port: rinfo.port,
                }),
            );
            sock.on('error', (err: Error) =>
            {
                if (!this.udp) reject(err);
            });
            sock.once('listening', () =>
            {
                this.udp = sock;
                resolve();
            });
            // bind без connect: ответы станции приходят на тот же порт, а
            // принимаем мы и от других портов станции (скан-тесты T5).
            sock.bind(this.opts.local_port ?? 0);
        });
    }

    private open_tcp(): Promise<void>
    {
        return new Promise<void>((resolve, reject) =>
        {
            const sock = net.connect(this.opts.port, this.opts.host);
            let opened = false;
            sock.once('connect', () =>
            {
                opened = true;
                this.tcp = sock;
                resolve();
            });
            sock.once('error', (err: Error) =>
            {
                if (!opened) reject(err);
            });
            sock.on('data', (chunk: Buffer) => this.feed_tcp(chunk));
        });
    }

    /** Фрейминг SIP/TCP: заголовки до \r\n\r\n + Content-Length (§13.1). */
    private feed_tcp(chunk: Buffer): void
    {
        this.tcp_buf = Buffer.concat([this.tcp_buf, chunk]);
        for (;;)
        {
            const header_end = this.tcp_buf.indexOf('\r\n\r\n');
            if (header_end < 0) return;
            const head = this.tcp_buf.subarray(0, header_end).toString('utf8');
            const m = /content-length:\s*(\d+)/i.exec(head);
            const len = m ? Number(m[1]) : 0;
            const total = header_end + 4 + len;
            if (this.tcp_buf.length < total) return;
            const msg = this.tcp_buf.subarray(0, total).toString('utf8');
            this.tcp_buf = this.tcp_buf.subarray(total);
            this.feed(msg, { host: this.opts.host, port: this.opts.port });
        }
    }

    /**
     * Скормить клиенту входящее сообщение (счётчик ответов, waiters по
     * Call-ID, наблюдатели on_message). Свои слушатели UDP/TCP зовут его сами;
     * для внешнего (станционного) сокета вызывает владелец из хука входящих —
     * один обработчик на сообщение, двойных ответов нет.
     */
    feed(raw: string, from: { host: string; port: number }): void
    {
        this.received_total += 1;
        const res = parse_sip_response(raw);
        const cid = res?.call_id ?? sip_call_id(raw);
        // Ответ засчитываем только «своему» Call-ID (см. out_call_ids): на
        // общем станционном сокете feed получают все клиенты прогона.
        if (res && this.out_call_ids.has(cid))
        {
            const key = `${res.cseq_method || '?'} ${res.status}`;
            this.answered.set(key, (this.answered.get(key) ?? 0) + 1);
        }
        for (const w of this.waiters.get(cid) ?? []) w(raw);
        for (const h of this.handlers) h(raw, from);
    }
}

// ---------- UDP-ресponder (сценарий T4) ----------

/**
 * UDP-сервер на этом хосте: «провайдер», отвечающий 401 с неизвестным realm
 * на запросы станции (T4, план §3). Отделён от клиента: отвечать надо любому
 * пиру, а не только станции.
 */
export class RawUdpResponder
{
    /** Принято запросов по методу (для сводки: 0 — станция сюда не ходит). */
    readonly requests_in = new Map<string, number>();

    private udp?: dgram.Socket;

    constructor(private readonly port: number)
    {}

    /** Поднять сокет на порт (0.0.0.0 — доступен станции с любого адреса). */
    listen(): Promise<void>
    {
        return new Promise<void>((resolve, reject) =>
        {
            const sock = dgram.createSocket('udp4');
            sock.once('error', (err: Error) =>
            {
                if (!this.udp) reject(err);
            });
            sock.once('listening', () =>
            {
                this.udp = sock;
                resolve();
            });
            sock.bind(this.port);
        });
    }

    /** Наблюдатель запросов; возвращает отписку. */
    on_request(
        cb: (raw: string, from: { host: string; port: number }) => void,
    ): () => void
    {
        this.handler = cb;
        return () =>
        {
            if (this.handler === cb) this.handler = undefined;
        };
    }

    private handler:
        ((raw: string, from: { host: string; port: number }) => void) | undefined;

    /** Ответ конкретному пиру (запрос пришёл с его src-порта). */
    send_to(message: string, host: string, port: number): Promise<void>
    {
        const sock = this.udp;
        if (!sock) return Promise.reject(new Error('Ресponder не слушает'));
        return new Promise((resolve, reject) =>
            sock.send(Buffer.from(message, 'utf8'), port, host, (e) =>
                e ? reject(e) : resolve(),
            ),
        );
    }

    close(): void
    {
        const sock = this.udp;
        this.udp = undefined;
        this.handler = undefined;
        if (!sock) return;
        try
        {
            sock.close();
        }
        catch
        {
            /* уже закрыт */
        }
    }
}
