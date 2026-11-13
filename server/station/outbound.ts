// Исходящий вызов от станции-эмулятора (doc/task_30_plan_2.md): наша станция
// играет вышестоящую и инициирует INVITE на нижестоящую станцию — пир,
// обращающийся к нам keep-alive OPTIONS / port-register REGISTER / SUBSCRIBE.
// Полный цикл UAC без sip.js: сырые запросы поверх UDP-сокета станции (тот же
// путь доставки, что у SAS-NOTIFY).
//
// Контракты:
// - один активный вызов; dial/cancel/hangup/abort бросают Error с русским
//   текстом (контроллер кодирует 400/409); UDP-only (station.udp_socket()) —
//   на tcp-единственном слушателе dial честно отказывает;
// - адресат по умолчанию — last_downstream_peer() станции (src последнего
//   REGISTER/OPTIONS/SUBSCRIBE пира), переопределение — target 'host[:port]'
//   (порт по умолчанию 5060);
// - origin «откуда пришёл вызов» (doc/task_31_plan_2.md, ретрансляция в
//   SAS-режиме): INVITE собирается «будто принят» с введённого адреса —
//   From = sip:номер@origin, ВТОРОЙ Via = origin (верхний Via/Contact/
//   src-сокет остаётся станцией — ответы возвращаются к нам); CANCEL и ACK
//   на не-2xx зеркалят Via-стек и верхний branch (RFC 3261 §9.1/§17.1.1),
//   ACK на 2xx и BYE — один Via, From из origin-домена (matching диалога);
// - перенаправление входящих INVITE ПО ТАБЛИЦЕ РЕГИСТРАЦИЙ
//   (doc/task_34_plan_2.md, переопределяет doc/task_32_plan_2.md): постоянный
//   хук on_invite_forward активен при флаге станции forward_invite — входящий
//   INVITE `sip:<номер>@…` ищется в таблице регистраций: строка по phone=номер
//   даёт адресат UDP (её address) и идентификатор линии (R-URI исходящего
//   `sip:<identifier>@<адресат:порт>`); caller — по identifier из Contact
//   входящего (fallback — user из From). From/To/Call-ID — наш IP
//   (station_host). Байты исходящего INVITE — по образцу pimer.md
//   (coral_style, doc/task_35_plan_2.md): ОДИН Via с портом в sent-by
//   (src отправителя на проводе не отображается — origin остаётся только в
//   статусе/журнале), Max-Forwards: 69, `;user=phone` в From, Contact после
//   To, Allow из образца; тело — полный SDP-образец (PCMA/PCMU/101, sendrecv),
//   RTP-порт формальный: медиа как и прежде не ходит, порт нужен, чтобы
//   нижестоящая станция приняла offer. Прямой dial (web-форма) собирается
//   по-прежнему build_sip_request (task_30/31 байты не меняются).
//   Маршрут не найден (нет строки / пуст address / таблица не подключена) —
//   INVITE НЕ съедается: мимикрия отвечает прежний 405, причина — в журнал.
//   Ретранслят того же Call-ID (retransmit исходного INVITE) и in-dialog
//   re-INVITE живого вызова новых наборов не поднимают; занятый движок и
//   адресат = сама станция — INVITE съедается без набора (петля); ошибки dial
//   — в журнал вызова, без исключения;
// - игнорирование Trying/Ringing перенаправленного INVITE
//   (doc/task_36_plan_2.md): при флаге станции ignore_provisional ответы
//   100/180 на INVITE, поднятый перенаправлением (DialInit.forwarded),
//   не замечаются вовсе — без перехода calling→ringing, без счётчиков
//   answered/last_code; ответ лишь потребляется хуком (в ignored станции не
//   попадает) и помечается в журнале «игнорирован». Прямой dial и прочие
//   1xx (183 и т.п.) флагом не затрагиваются;
// - умножение перенаправляемого INVITE ×10 (doc/task_37_plan_2.md): при
//   флаге станции multiply_invite перенаправление ретранслирует INVITE
//   десятью копиями разом (FORWARD_MULTIPLY_COPIES) — в один synchronous-
//   проход хука. Копии отличаются Call-ID/branch/From-tag (иначе станция
//   сливает их в одну транзакцию), байты каждой — прежний образец pimer.md
//   (task_35). Первая — обычный dial (состояние, счётчики и кнопки —
//   главный вызов); остальные — «теневые» диалоги (ShadowCall): свои
//   retransmit INVITE (те же T1-таймеры), финал не-2xx → ACK той же веткой,
//   2xx → ACK + немедленный BYE (копия линию не держит), таймаут → снятие;
//   судьба копий — журнал движка, в статусе — multiplied_active. «Отбой»
//   (cancel) и abort/останов гасят и копии (CANCEL/BYE best-effort, финал
//   копия дожидается для ACK); хук входящих держится, пока жива хоть одна
//   копия; ignore_provisional и retransmit-дедуп действуют на фан-аут как
//   на одиночное перенаправление; занятый движок — преветка «съеден без
//   набора»;
// - транзакции RFC 3261 упрощённые: INVITE — retransmit с удвоением шага от
//   T1 до 64·T1 (таймер B), CANCEL — фиксированный T1 до 64 повторов, BYE —
//   удвоение; дубль 2xx → повтор ACK; Challenge (401/407) не обрабатываем:
//   код фиксируется, вызов завершается (доводка по обратной связи стенда);
// - CANCEL — тем же branch и тем же номером CSeq, что INVITE (RFC 3261 §9.1),
//   ACK на не-2xx — тоже тем же branch; ACK на 2xx — в диалоге (To-tag и
//   Contact-адресат из 200); BYE — следующий CSeq в диалоге (2);
// - тело INVITE — NO_MEDIA_SDP (медиа нет никогда), кроме coral_style-
//   перенаправления (полный SDP-образец pimer.md, см. выше); Contact user =
//   номер вызывающего (иначе классическая АТС отвергает INVITE — CLAUDE.md
//   «Грабли»);
// - на время вызова движок берёт хук входящих станции: ест ВСЕ ответы
//   (иначе станция засчитала бы их мусором в ignored) и BYE/ACK своего
//   диалога (BYE пира → 200 + завершение). Запросы (OPTIONS/REGISTER/…)
//   возвращаются хуку-нет — мимикрия станции живёт во время вызова;
// - хуки станции мультикастятся (doc/task_31_plan_2.md): SAS-режим и вызов
//   совместимы в обе стороны — SAS забирает свои ответы NOTIFY, вызов свои;
//   со стимулом пересечение по-прежнему запрещено контроллером (409);
// - останов станции и shutdown гасят вызов abort() (CANCEL/BYE best-effort,
//   хук снимается).
// related: server/station/station.ts (udp_socket, add_incoming_hook,
// last_downstream_peer), server/station/registrations.ts (таблица
// регистраций, attach_registrations), server/los_mem/raw_sip.ts
// (build_sip_request, build_sip_response, parse_sip_request_head,
// parse_sip_response, uri_host_port, sip_call_id),
// server/sip/sip_ua_transport.ts (NO_MEDIA_SDP),
// server/controllers/station_controller.ts, doc/task_30_plan_2.md,
// doc/task_32_plan_2.md, doc/task_34_plan_2.md, doc/task_35_plan_2.md,
// doc/task_36_plan_2.md, doc/task_37_plan_2.md, pimer.md (образец INVITE).

import { randomBytes } from 'node:crypto';
import type { Socket } from 'node:dgram';
import type { AppConfig } from '../config';
import {
    build_sip_request,
    build_sip_response,
    parse_sip_request_head,
    parse_sip_response,
    sip_call_id,
    uri_host_port,
} from '../los_mem/raw_sip';
import { NO_MEDIA_SDP } from '../sip/sip_ua_transport';
import type { RegistrationsApi } from './registrations';
import type { SipStation } from './station';

/** Состояния исходящего вызова (строка статуса REST/вкладки). */
export type OutboundState =
    'idle' | 'calling' | 'ringing' | 'answered' | 'cancelling' | 'terminating';

/**
 * Снимок движка (GET /api/station/call): состояние текущего (или последнего)
 * вызова + счётчики и сырой лог.
 */
export interface OutboundStatus
{
    state: OutboundState;
    callee: string;
    caller: string;
    /** Адресат `host:port`; '' — вызова ещё не было. */
    target: string;
    /**
     * Адрес «откуда пришёл вызов» (`host:port`, ретрансляция — From и второй
     * Via); '' — прямой вызов от станции (doc/task_31_plan_2.md).
     */
    origin: string;
    call_id: string;
    /** Код последнего ответа станции; 0 — ответов не было. */
    last_code: number;
    last_reason: string;
    /** Текст отказа/таймаута последнего вызова; '' — чисто. */
    error: string;
    /** Отправлено запросов по текущему/последнему вызову. */
    sent: number;
    /** Ответы станции по коду (текущий/последний вызов). */
    answered: { [code_name: string]: number };
    /** Последние строки сырого лога (newest first). */
    log: string[];
    /**
     * Число живых теневых копий режима ×10 (doc/task_37_plan_2.md);
     * 0 — вне умножения (одиночное перенаправление и прямой вызов).
     */
    multiplied_active: number;
}

/**
 * Параметры dial: прямой вызов (web-форма) или ретранслят по таблице
 * регистраций (on_invite_forward, doc/task_34_plan_2.md). Поля ruri/to_uri/
 * ruri_user/origin_via_only/coral_style задаются только перенаправлением —
 * без них байты запросов идентичны doc/task_30_plan_2.md и
 * doc/task_31_plan_2.md.
 */
export interface DialInit
{
    callee: string;
    caller?: string;
    /** Адресат UDP `host[:port]` (порт по умолчанию 5060). */
    target?: string;
    /**
     * Адрес «откуда пришёл вызов» (`host[:port]`): по умолчанию — From и
     * второй Via от него (task_31), при origin_via_only — только второй Via.
     */
    origin?: string;
    /**
     * Полный R-URI INVITE/CANCEL/ACK-на-не-2xx (перенаправление:
     * `sip:<identifier>@<адресат:порт>`, образец pimer.md); по умолчанию
     * `sip:callee@target`.
     */
    ruri?: string;
    /** To во всех запросах вызова; по умолчанию как R-URI этого запроса. */
    to_uri?: string;
    /** User in-dialog R-URI (ACK на 2xx/BYE в адресат из Contact). */
    ruri_user?: string;
    /**
     * true — origin уходит ТОЛЬКО вторым Via, From и домен Call-ID остаются
     * станцией (наш IP, doc/task_34_plan_2.md).
     */
    origin_via_only?: boolean;
    /**
     * true — INVITE собирается по образцу pimer.md (coral_style,
     * doc/task_35_plan_2.md): один Via с портом в sent-by (origin на провод
     * не уходит — остаётся в статусе), Max-Forwards 69, `;user=phone` в From,
     * Contact после To, Allow образца и полный SDP-образец вместо
     * NO_MEDIA_SDP. Ставит только on_invite_forward.
     */
    coral_style?: boolean;
    /**
     * true — вызов поднят перенаправлением (ставит только
     * on_invite_forward): область действия флага станции
     * ignore_provisional — 100/180 на этот INVITE игнорируются
     * (doc/task_36_plan_2.md).
     */
    forwarded?: boolean;
}

/**
 * DI-контракт движка для контроллера/страницы (мокируется в api-тестах,
 * по образцу StationSasApi). dial бросает Error — контроллер кодирует в
 * 400/409; abort идемпотентен и не бросает.
 */
export interface StationOutboundApi
{
    /**
     * Снимок движка; только чтение.
     */
    status(): OutboundStatus;
    /**
     * Отправить INVITE на callee; caller по умолчанию — первый абонент
     * конфига, target — адрес нижестоящей станции (или 'host[:port]');
     * origin — адрес «откуда пришёл вызов» ('host[:port]', ретрансляция:
     * From и второй Via от него, см. шапку файла).
     */
    dial(init: {
        callee: string;
        caller?: string;
        target?: string;
        origin?: string;
    }): void;
    /**
     * CANCEL до финального ответа (calling/ringing); финал дождётся сам.
     */
    cancel(): void;
    /**
     * BYE по соединённому вызову (answered).
     */
    hangup(): void;
    /**
     * Синхронный сброс для остановов: CANCEL/BYE best-effort, таймеры и
     * хук снимаются немедленно; на idle — no-op.
     */
    abort(): void;
}

/** RTT-таймер T1 (RFC 3261 §17.1.1) — шаг retransmit UDP-запросов. */
const T1_MS = 500;

/** Ёмкость ring-лога движка (страница берёт первые ~40). */
const LOG_RING = 200;

/** User-Agent исходящих запросов — НЕ мимикрия станции: здесь мы UAC. */
const OUTBOUND_USER_AGENT = 'station-outcall/1.0';

/** Порт адресата по умолчанию, если target задан без порта. */
const DEFAULT_SIP_PORT = 5060;

/** Allow INVITE-перенаправления — дословно из образца pimer.md (pa_sip). */
const CORAL_ALLOW = 'INVITE, ACK, BYE, CANCEL, UPDATE, PRACK, SUBSCRIBE, NOTIFY, REFER';

/** Max-Forwards образца pimer.md (у нас по умолчанию 70 — здесь 69). */
const CORAL_MAX_FORWARDS = 69;

/**
 * Число копий перенаправляемого INVITE в режиме умножения
 * (doc/task_37_plan_2.md): первая — главный dial (состояние и счётчики),
 * остальные — теневые диалоги.
 */
const FORWARD_MULTIPLY_COPIES = 10;

/**
 * SDP-тело образца pimer.md: PCMA/PCMU/telephone-event, sendrecv. RTP-порт
 * чётный случайный и ФОРМАЛЬНЫЙ: медиа движок не шлёт и не принимает — порт
 * нужен, чтобы нижестоящая станция приняла offer как настоящий (инвариант
 * «медиа нет никогда» при этом не нарушается: RTP уходит в никуда).
 */
function coral_sdp(host: string): string
{
    // Порт и session-id случайны на вызов и фиксируются в call.raw —
    // retransmit INVITE остаётся байт-в-байт; чётность порта — RTP-соглашение
    // (RTP чётный, RTCP следующий).
    const rtp_port = 10000 + 2 * (randomBytes(2).readUInt16BE(0) % 25000);
    const sess_id = randomBytes(4).readUInt32BE(0);
    const sess_ver = randomBytes(4).readUInt32BE(0);
    return (
        'v=0\r\n' +
        `o=mgapp ${sess_id} ${sess_ver} IN IP4 ${host}\r\n` +
        's=-\r\n' +
        `c=IN IP4 ${host}\r\n` +
        't=0 0\r\n' +
        `m=audio ${rtp_port} RTP/AVP 8 0 101\r\n` +
        'a=rtpmap:8 PCMA/8000\r\n' +
        'a=rtpmap:0 PCMU/8000\r\n' +
        'a=rtpmap:101 telephone-event/8000\r\n' +
        'a=fmtp:101 0-15\r\n' +
        'a=ptime:20\r\n' +
        'a=sendrecv\r\n'
    );
}

/** Параметры build_coral_invite — INVITE по образцу pimer.md. */
interface CoralInviteInit
{
    ruri: string;
    /** Номер вызывающего — user в From (с user=phone) и Contact. */
    caller: string;
    to_uri: string;
    /** Наш IP станции (H) и её порт (P): Via/From/Contact образца. */
    host: string;
    port: number;
    call_id: string;
    cseq: number;
    branch: string;
    from_tag: string;
    body: string;
}

/**
 * Собирает INVITE по образцу pimer.md (байт-в-байт с нашими адресами):
 * ОДИН Via с портом в sent-by, Max-Forwards 69, From `<sip:номер@H;user=phone>`,
 * Contact сразу после To, затем Allow образца и User-Agent движка (Coral и
 * P-Coral-Info не мимикрируем — решение оператора), Content-* — по телу.
 * Используется только coral_style-перенаправлением; CANCEL/ACK/BYE и прямой
 * dial собирает build_sip_request (байты task_30/31 не меняются).
 */
function build_coral_invite(o: CoralInviteInit): string
{
    const lines: string[] = [
        `INVITE ${o.ruri} SIP/2.0`,
        `Via: SIP/2.0/UDP ${o.host}:${o.port};rport;branch=${o.branch}`,
        `Max-Forwards: ${CORAL_MAX_FORWARDS}`,
        `From: <sip:${o.caller}@${o.host};user=phone>;tag=${o.from_tag}`,
        `To: <${o.to_uri}>`,
        `Contact: <sip:${o.caller}@${o.host}:${o.port}>`,
        `Call-ID: ${o.call_id}`,
        `CSeq: ${o.cseq} INVITE`,
        `Allow: ${CORAL_ALLOW}`,
        `User-Agent: ${OUTBOUND_USER_AGENT}`,
        'Content-Type: application/sdp',
        `Content-Length: ${Buffer.byteLength(o.body, 'utf8')}`,
    ];
    return lines.join('\r\n') + '\r\n\r\n' + o.body;
}

/**
 * Диалог исходящего вызова: всё, чем обмениваются транзакции (теги, branch,
 * адресат ACK/BYE, сырой INVITE для retransmit).
 */
interface OutCall
{
    call_id: string;
    from_tag: string;
    /** Branch INVITE — переиспользуется CANCEL и ACK на не-2xx. */
    branch: string;
    callee: string;
    caller: string;
    /** Сигнальный адресат (src нижестоящей станции). */
    target: { host: string; port: number };
    /**
     * Адрес «откуда пришёл вызов» (ретрансляция, doc/task_31_plan_2.md);
     * undefined — прямой вызов от станции.
     */
    origin?: { host: string; port: number };
    /**
     * From-URI всех запросов вызова: при origin — sip:номер@origin
     * (matching диалога в ACK/BYE обязателен), иначе sip:номер@станция.
     */
    from_uri: string;
    /**
     * Строки Via нижестоящего хопа для INVITE/CANCEL/ACK-на-не-2xx
     * (`Via: SIP/2.0/UDP origin;…`); пустой массив — прямой вызов или
     * coral_style (образец pimer.md: один Via, src на проводе не виден).
     */
    via_extra: string[];
    /** To-tag из 2xx (диалог); '' — ещё нет. */
    to_tag: string;
    /** Адресат ACK/BYE — Contact из 200, иначе target. */
    remote: { host: string; port: number };
    /**
     * INVITE/CANCEL/ACK-на-не-2xx R-URI (перенаправление:
     * `sip:<identifier>@<наш_ip:порт>`, task_34); по умолчанию callee@target.
     */
    ruri: string;
    /**
     * To всех запросов вызова (перенаправление: `sip:<номер>@<наш_ip>`);
     * undefined — прежняя сборка `sip:callee@target` / in-dialog
     * `sip:callee@remote` (task_30/31 байты не меняются).
     */
    to_uri?: string;
    /** User in-dialog R-URI (ACK на 2xx/BYE); по умолчанию callee. */
    ruri_user: string;
    /**
     * Вызов поднят перенаправлением (DialInit.forwarded) — область действия
     * флага станции ignore_provisional (doc/task_36_plan_2.md).
     */
    forwarded: boolean;
    /** INVITE одним сообщением (retransmit — байт-в-байт). */
    raw: string;
    /** Шаг текущего retransmit-таймера INVITE/BYE (удвоение от T1). */
    step: number;
    /** Повторные CANCEL (фиксированный T1, счётчик до 64). */
    cancel_retransmits: number;
}

/**
 * Теневой диалог копии ×10 (doc/task_37_plan_2.md): тот же OutCall и те же
 * транзакции, что у главного вызова, но без видимого состояния — жизнь
 * определяют таймеры и строки журнала. phase: 'calling' — ждём финал
 * INVITE; 'cancelling' — CANCEL отправлен, ждём финал для ACK;
 * 'terminating' — 2xx получен, идёт BYE. invite_done — финал INVITE уже
 * обработан (повтор финала от станции — максимум повторный ACK).
 */
interface ShadowCall
{
    call: OutCall;
    phase: 'calling' | 'cancelling' | 'terminating';
    /** Retransmit INVITE (calling) либо ожидание финала после CANCEL. */
    invite_timer: NodeJS.Timeout | undefined;
    /** Retransmit BYE (terminating). */
    bye_timer: NodeJS.Timeout | undefined;
    invite_done: boolean;
}

// ---------- класс движка ----------

/**
 * Движок исходящего вызова: следит за транзакциями одного активного INVITE
 * (плюс теневые копии ×10, doc/task_37_plan_2.md) и шлёт запросы через
 * UDP-сокет станции (своего bind нет). t1_ms — параметр юнит-теста
 * (урезанный T1 ради проверки таймаута), в бою не передаётся.
 */
export class StationOutbound implements StationOutboundApi
{
    private state: OutboundState = 'idle';
    /** Диалог текущего/последнего вызова (для статуса — после idle тоже). */
    private call: OutCall | undefined;
    private invite_timer: NodeJS.Timeout | undefined;
    private cancel_timer: NodeJS.Timeout | undefined;
    private bye_timer: NodeJS.Timeout | undefined;
    /** Дизпоузер хука входящих (навешан в dial, снимается в finish). */
    private off_hook: (() => void) | undefined;
    private sent = 0;
    private readonly answered = new Map<string, number>();
    private last_code = 0;
    private last_reason = '';
    private error_text = '';
    /** newest first (unshift). */
    private readonly log_ring: string[] = [];
    /**
     * Call-ID последнего перенаправленного INVITE (doc/task_32_plan_2.md):
     * retransmit'ы исходного запроса не поднимают новый набор, пока живёт
     * запись (сбрасывается только новым перенаправлением).
     */
    private last_forward_cid = '';
    /**
     * Таблица регистраций (doc/task_34_plan_2.md) — источник адресата и
     * идентификаторов при перенаправлении; undefined — не подключена
     * (перенаправление честно возвращает INVITE мимикрии, 405).
     */
    private registrations: RegistrationsApi | undefined;
    /**
     * Теневые копии ×10 (doc/task_37_plan_2.md): Call-ID → теневой диалог.
     * Живут и после finish() главного вызова — до своих финалов/таймаутов;
     * хук входящих держится, пока карта непуста (maybe_release_hook).
     */
    private readonly shadows = new Map<string, ShadowCall>();

    /**
     * @param config — адрес/хост станции и абонент по умолчанию для caller.
     * @param station — станция: её UDP-сокет, хук входящих и флаг
     * forward_invite (постоянный хук перенаправления навешивается здесь).
     * @param t1_ms — урезанный T1 для юнит-теста таймаутов; в бою не передаётся.
     */
    constructor(
        private readonly config: AppConfig,
        private readonly station: SipStation,
        private readonly t1_ms: number = T1_MS,
    )
    {
        // Хук перенаправления INVITE живёт всё время движка (флаг — на
        // станции, хук лишь его читает): INVITE забирается у мимикрии,
        // когда режим включён (doc/task_32_plan_2.md).
        this.station.add_incoming_hook((raw, _proto, peer) =>
            this.on_invite_forward(raw, peer),
        );
    }

    /**
     * Потолок retransmit-шага/таймаут транзакций — 64·T1. Геттер (не поле):
     * привязан к t1_ms, который в юнит-тесте урезан — порог живёт за ним,
     * в бою при T1=500 даёт те же 32 с (RFC 3261 §17.1.1, таймер B).
     */
    private get t1_max_ms(): number
    {
        return 64 * this.t1_ms;
    }

    /**
     * Подключает таблицу регистраций — источник маршрута для перенаправления
     * INVITE (doc/task_34_plan_2.md, по образцу SipStation.
     * attach_registrations: вне контракта StationOutboundApi, моки
     * api-тестов не трогается).
     */
    attach_registrations(store: RegistrationsApi): void
    {
        this.registrations = store;
    }

    /**
     * Снимок движка (контракт StationOutboundApi).
     */
    status(): OutboundStatus
    {
        const c = this.call;
        return {
            state: this.state,
            callee: c?.callee ?? '',
            caller: c?.caller ?? '',
            target: c ? `${c.target.host}:${c.target.port}` : '',
            origin: c?.origin ? `${c.origin.host}:${c.origin.port}` : '',
            call_id: c?.call_id ?? '',
            last_code: this.last_code,
            last_reason: this.last_reason,
            error: this.error_text,
            sent: this.sent,
            answered: Object.fromEntries(this.answered),
            log: this.log_ring.slice(0, 80),
            multiplied_active: this.shadows.size,
        };
    }

    /**
     * Отправить INVITE (контракт StationOutboundApi): сборка диалога,
     * захват хука входящих, старт retransmit-таймера INVITE.
     */
    dial(init: DialInit): void
    {
        if (this.state !== 'idle')
        {
            throw new Error(`Вызов уже выполняется (${this.state}) — сначала отбой`);
        }
        if (!/^\+?\d{1,24}$/.test(init.callee))
        {
            throw new Error('Вызываемый номер — цифры (опционально «+»), 1–24');
        }
        const sock = this.station.udp_socket();
        if (this.station.status().state !== 'running' || !sock)
        {
            throw new Error('Станция остановлена — INVITE идёт через её UDP-сокет');
        }
        const target = this.resolve_target(init.target);
        const call = this.build_call(init, target);
        // Счётчики относятся к одному вызову — обнуляем на старте.
        this.sent = 0;
        this.answered.clear();
        this.last_code = 0;
        this.last_reason = '';
        this.error_text = '';
        this.call = call;
        this.state = 'calling';
        // Хук входящих — один на главный вызов и все теневые копии
        // (doc/task_37_plan_2.md): on_incoming читает текущий call и shadows,
        // при живых копиях повторного навешивания на новый dial нет.
        if (!this.off_hook)
        {
            this.off_hook = this.station.add_incoming_hook((raw, proto, peer) =>
                this.on_incoming(raw, proto, peer),
            );
        }
        this.send_raw(call.raw, target, `INVITE → ${call.callee}`);
        this.arm_invite_timer();
    }

    /**
     * Собирает диалог вызова из init без побочных эффектов движка (состояние,
     * счётчики, отправка — на совести вызывающего): общий для dial и
     * теневых копий ×10 (doc/task_37_plan_2.md), чтобы байты копий
     * совпадали с главным вызовом. Каждый диалог получает свои
     * Call-ID/branch/From-tag и SDP (session-id, RTP-порт).
     * @param target — уже разобраный адресат (resolve_target).
     */
    private build_call(init: DialInit, target: { host: string; port: number }): OutCall
    {
        const caller = init.caller?.trim() || this.config.subscribers[0].number;
        // Origin «откуда пришёл вызов» — хост обязателен, порт по умолчанию
        // 5060 (тот же разбор, что у target). При origin_via_only (перенаправ-
        // ление по таблице, task_34) origin идёт ТОЛЬКО вторым Via: From и
        // домен Call-ID остаются нашим адресом.
        const origin_str = init.origin?.trim() ?? '';
        let origin: { host: string; port: number } | undefined;
        if (origin_str !== '')
        {
            origin = uri_host_port(origin_str, DEFAULT_SIP_PORT);
            if (!origin) throw new Error('origin — «host» или «host:порт»');
        }
        const origin_via_only = init.origin_via_only ?? false;
        // coral_style (образец pimer.md): origin остаётся только в статусе —
        // второй Via на провод не уходит.
        const coral_style = init.coral_style ?? false;
        const from_domain =
            origin && !origin_via_only
                ? `${origin.host}:${origin.port}`
                : this.config.station_host;
        const port = this.station.status().port;
        // При origin вызов «ретранслируется»: From и Call-ID несут его домен,
        // второй Via — его адрес (верхний Via и Contact остаются станцией,
        // иначе ответы и диалог уйдут в несуществующий терминал).
        // origin_via_only (task_34): из origin остаётся только второй Via.
        const from_uri = `sip:${caller}@${from_domain}`;
        const call: OutCall = {
            call_id: `${randomBytes(8).toString('hex')}@${
                origin && !origin_via_only ? origin.host : this.config.station_host
            }`,
            from_tag: `ob-${randomBytes(4).toString('hex')}`,
            branch: `z9hG4bK-ob-${randomBytes(6).toString('hex')}`,
            callee: init.callee,
            caller,
            target,
            ...(origin ? { origin } : {}),
            from_uri,
            via_extra:
                origin && !coral_style
                    ? [
                          `Via: SIP/2.0/UDP ${origin.host}:${origin.port};rport;` +
                              `branch=z9hG4bK-ob-relay-${randomBytes(6).toString('hex')}`,
                      ]
                    : [],
            to_tag: '',
            remote: { ...target },
            raw: '',
            step: this.t1_ms,
            cancel_retransmits: 0,
            ruri: init.ruri ?? `sip:${init.callee}@${target.host}:${target.port}`,
            to_uri: init.to_uri,
            ruri_user: init.ruri_user ?? init.callee,
            forwarded: init.forwarded ?? false,
        };
        call.raw = coral_style
            ? build_coral_invite({
                  ruri: call.ruri,
                  caller: call.caller,
                  to_uri: call.to_uri ?? call.ruri,
                  host: this.config.station_host,
                  port,
                  call_id: call.call_id,
                  cseq: 1,
                  branch: call.branch,
                  from_tag: call.from_tag,
                  body: coral_sdp(this.config.station_host),
              })
            : build_sip_request('INVITE', {
                  ruri: call.ruri,
                  from_uri: call.from_uri,
                  to_uri: call.to_uri ?? call.ruri,
                  call_id: call.call_id,
                  cseq: 1,
                  from_tag: call.from_tag,
                  // Contact user = номер вызывающего (грабля классической АТС).
                  contact: `sip:${call.caller}@${this.config.station_host}:${port}`,
                  via_host: this.config.station_host,
                  via_extra: call.via_extra,
                  branch: call.branch,
                  content_type: 'application/sdp',
                  body: NO_MEDIA_SDP,
                  user_agent: OUTBOUND_USER_AGENT,
              });
        return call;
    }

    /**
     * CANCEL активного INVITE (контракт): тот же branch и номер CSeq, ожидание
     * финала (обычно 487) — в on_response. Копии ×10 отменяются вместе с
     * главным вызовом (doc/task_37_plan_2.md): CANCEL каждой ожидающей
     * копии одноразовый (best-effort), её финал копия дожидается для ACK.
     */
    cancel(): void
    {
        if (this.state === 'answered' || this.state === 'terminating')
        {
            throw new Error('Вызов соединён — завершение BYE (hangup)');
        }
        if (this.state === 'cancelling') throw new Error('CANCEL уже отправлен');
        if (this.state === 'idle') throw new Error('Активного вызова нет');
        const call = this.call;
        const sock = this.station.udp_socket();
        if (!call || !sock) throw new Error('Активного вызова нет');
        this.state = 'cancelling';
        this.clear_invite_timer();
        const msg = this.cancel_msg(call);
        call.cancel_retransmits = 0;
        this.send_raw(msg, call.target, 'CANCEL →');
        this.arm_cancel_timer(msg, call);
        for (const shadow of this.shadows.values())
        {
            if (shadow.phase !== 'calling') continue;
            if (shadow.invite_timer) clearTimeout(shadow.invite_timer);
            shadow.phase = 'cancelling';
            this.send_raw(
                this.cancel_msg(shadow.call),
                shadow.call.target,
                'CANCEL → (копия)',
                false,
            );
            // Ожидание финала для ACK — с тем же потолком 64·T1, что и у
            // транзакции; таймер переиспользует слот invite_timer.
            shadow.invite_timer = setTimeout(() =>
            {
                if (shadow.phase !== 'cancelling') return;
                this.remove_shadow(shadow, 'CANCEL: станция не ответила (timeout)');
            }, this.t1_max_ms + this.t1_ms);
            shadow.invite_timer.unref();
        }
    }

    /**
     * CANCEL-сообщение диалога: тот же branch и тот же номер CSeq, что у
     * INVITE (RFC 3261 §9.1); общий для cancel(), abort() и теневых копий.
     */
    private cancel_msg(call: OutCall): string
    {
        return build_sip_request('CANCEL', {
            ruri: call.ruri,
            from_uri: call.from_uri,
            to_uri: call.to_uri ?? call.ruri,
            call_id: call.call_id,
            cseq: 1, // номер CANCEL = номеру INVITE (RFC 3261 §9.1)
            from_tag: call.from_tag,
            ...(call.to_tag ? { to_tag: call.to_tag } : {}),
            via_host: this.config.station_host,
            // CANCEL идёт тем же Via-стеком, что INVITE (RFC 3261 §9.1).
            via_extra: call.via_extra,
            branch: call.branch, // та же ветка транзакции
            user_agent: OUTBOUND_USER_AGENT,
        });
    }

    /**
     * BYE по соединённому вызову (контракт): CSeq 2 в диалоге, адресат —
     * Contact из 200 (или target).
     */
    hangup(): void
    {
        if (this.state !== 'answered')
        {
            throw new Error(
                this.state === 'idle'
                    ? 'Активного вызова нет'
                    : 'Вызов ещё не соединён — отмена CANCEL (cancel)',
            );
        }
        const call = this.call;
        if (!call) throw new Error('Активного вызова нет');
        this.send_bye(call);
    }

    /**
     * Синхронный сброс для stop/shutdown (контракт): CANCEL/BYE best-effort,
     * таймеры и хук снимаются немедленно; на idle — no-op, не бросает.
     */
    abort(): void
    {
        if (this.state === 'idle') return;
        const call = this.call;
        const sock = this.station.udp_socket();
        try
        {
            if (call && sock)
            {
                if (this.state === 'answered' || this.state === 'terminating')
                {
                    this.send_raw(this.bye_msg(call), call.remote, 'BYE → (abort)');
                }
                else
                {
                    // CANCEL без таймеров — доставка best-effort.
                    this.send_raw(this.cancel_msg(call), call.target, 'CANCEL → (abort)');
                }
            }
            // Копии ×10 — тем же порядком: BYE ушедшей в 2xx копии, CANCEL
            // прочим; без таймеров, доставка best-effort
            // (doc/task_37_plan_2.md).
            for (const shadow of this.shadows.values())
            {
                const bye = shadow.phase === 'terminating';
                this.send_raw(
                    bye ? this.bye_msg(shadow.call) : this.cancel_msg(shadow.call),
                    bye ? shadow.call.remote : shadow.call.target,
                    bye ? 'BYE → (копия, abort)' : 'CANCEL → (копия, abort)',
                    false,
                );
            }
        }
        catch
        {
            /* noop: сокет мог лечь раньше — хук и таймеры снимаем в любом случае */
        }
        for (const shadow of this.shadows.values())
        {
            if (shadow.invite_timer) clearTimeout(shadow.invite_timer);
            shadow.invite_timer = undefined;
            if (shadow.bye_timer) clearTimeout(shadow.bye_timer);
            shadow.bye_timer = undefined;
        }
        this.shadows.clear();
        this.finish('вызов сброшен остановом', false);
    }

    // ---------- внутреннее ----------

    /** Адресат INVITE: target 'host[:port]' или адрес нижестоящей станции. */
    private resolve_target(target?: string): { host: string; port: number }
    {
        if (target)
        {
            const parsed = uri_host_port(target, DEFAULT_SIP_PORT);
            if (!parsed) throw new Error('target — «host» или «host:порт»');
            return parsed;
        }
        const peer = this.station.last_downstream_peer();
        if (!peer)
        {
            throw new Error(
                'адрес нижестоящей станции неизвестен (пир ещё не обращался) ' +
                    '— укажите host:port',
            );
        }
        return peer;
    }

    /**
     * Один UDP-пакет + строка лога; ошибки сокета — в статус (abort-путь).
     * @param count — false (теневые копии ×10) не двигает счётчик `sent`
     * (он относится к главному вызову); строка журнала остаётся.
     */
    private send_raw(
        msg: string,
        to: { host: string; port: number },
        what: string,
        count = true,
    ): void
    {
        const sock = this.station.udp_socket();
        if (!sock) throw new Error('UDP-сокет станции недоступен');
        sock.send(Buffer.from(msg, 'utf8'), to.port, to.host);
        if (count) this.sent += 1;
        this.log(`${what} ${to.host}:${to.port}`);
    }

    /**
     * BYE-сообщение диалога (CSeq 2, To-tag из 200). Via один (наш): BYE —
     * in-dialog запрос, Our-сторона диалога — станция; From остаётся
     * origin-домена (matching диалога, RFC 3261 §19.1.1).
     */
    private bye_msg(call: OutCall): string
    {
        return build_sip_request('BYE', {
            ruri: `sip:${call.ruri_user}@${call.remote.host}:${call.remote.port}`,
            from_uri: call.from_uri,
            to_uri:
                call.to_uri ??
                `sip:${call.callee}@${call.remote.host}:${call.remote.port}`,
            call_id: call.call_id,
            cseq: 2,
            from_tag: call.from_tag,
            to_tag: call.to_tag,
            contact: `sip:${call.caller}@${this.config.station_host}:${this.station.status().port}`,
            via_host: this.config.station_host,
            user_agent: OUTBOUND_USER_AGENT,
        });
    }

    /** Отправка BYE + переход в terminating + retransmit-таймер. */
    private send_bye(call: OutCall): void
    {
        const msg = this.bye_msg(call);
        call.step = this.t1_ms;
        this.state = 'terminating';
        this.send_raw(msg, call.remote, 'BYE →');
        const arm = (): void =>
        {
            const delay = call.step;
            call.step = Math.min(call.step * 2, this.t1_max_ms + this.t1_ms);
            this.bye_timer = setTimeout(() =>
            {
                if (this.state !== 'terminating') return;
                if (delay > this.t1_max_ms)
                {
                    this.finish('BYE: нет ответа (timeout)', true);
                    return;
                }
                this.send_raw(msg, call.remote, 'BYE ↻');
                arm();
            }, delay);
            this.bye_timer.unref();
        };
        arm();
    }

    /** INVITE — retransmit с удвоением шага от T1 до потолка (таймер B). */
    private arm_invite_timer(): void
    {
        const call = this.call;
        if (!call) return;
        const delay = call.step;
        call.step = Math.min(call.step * 2, this.t1_max_ms + this.t1_ms);
        this.invite_timer = setTimeout(() =>
        {
            if (this.state !== 'calling' && this.state !== 'ringing') return;
            if (delay > this.t1_max_ms)
            {
                this.finish(
                    `INVITE: нет ответа (${Math.round(this.t1_max_ms / 1000)} с)`,
                    true,
                );
                return;
            }
            this.send_raw(call.raw, call.target, 'INVITE ↻');
            this.arm_invite_timer();
        }, delay);
        this.invite_timer.unref();
    }

    /** CANCEL — retransmit фиксированным T1 до 64 повторов (RFC 3261 §17.1.2). */
    private arm_cancel_timer(msg: string, call: OutCall): void
    {
        this.cancel_timer = setTimeout(() =>
        {
            if (this.state !== 'cancelling') return;
            call.cancel_retransmits += 1;
            if (call.cancel_retransmits >= 64)
            {
                this.finish('CANCEL: станция не ответила (timeout)', true);
                return;
            }
            this.send_raw(msg, call.target, 'CANCEL ↻');
            this.arm_cancel_timer(msg, call);
        }, this.t1_ms);
        this.cancel_timer.unref();
    }

    private clear_invite_timer(): void
    {
        if (this.invite_timer) clearTimeout(this.invite_timer);
        this.invite_timer = undefined;
    }

    /**
     * Постоянный хук перенаправления INVITE ПО ТАБЛИЦЕ РЕГИСТРАЦИЙ
     * (doc/task_34_plan_2.md, байты INVITE — образец pimer.md,
     * doc/task_35_plan_2.md): при флаге станции входящий `INVITE
     * sip:<номер>@…` ищется в таблице — строка по phone=номер даёт адресат
     * UDP (address) и идентификатор линии (R-URI `sip:<identifier>@<адресат
     * :порт>`, To `sip:<номер>@<наш>`); caller — по identifier из Contact
     * (fallback — user из From). src отправителя на провод не уходит
     * (coral_style: один Via), From/To/Contact/Call-ID — наш IP.
     * Маршрут не найден (нет строки /
     * пуст address / таблица не подключена) — false: мимикрия отвечает
     * прежний 405, причина — в журнал вызова. re-INVITE живого диалога и
     * retransmit — прежние ветки; занятый движок и адресат = сама станция
     * — INVITE съедается без набора. При флаге станции multiply_invite
     * ретрансляция уходит десятью копиями разом (главный dial + девять
     * теневых диалогов, doc/task_37_plan_2.md). Ошибки dial — только в
     * журнал.
     * @return true — INVITE съеден, мимикрия не отвечает.
     */
    private on_invite_forward(
        raw: string,
        peer: { host: string; port: number },
    ): boolean
    {
        if (!this.station.forward_invite_mode()) return false;
        if (/^SIP\/2\.0\s/i.test(raw)) return false; // ответы — не INVITE
        const m = /^INVITE\s+(\S+)\s+SIP\/2\.0$/im.exec(raw);
        if (!m) return false;
        const cid = sip_call_id(raw);
        const live = this.call;
        // re-INVITE нашего активного диалога — не новый вызов (назад, к
        // мимикрии: прежний 405 этого диалога нас не касается).
        if (live && cid === live.call_id) return false;
        // retransmit перенаправленного INVITE — повторного набора нет.
        if (cid === this.last_forward_cid) return true;
        const callee = /^sips?:([^@;>]+)/i.exec(m[1])?.[1] ?? '';
        const store = this.registrations;
        if (this.state !== 'idle')
        {
            this.log('перенаправление: движок занят — INVITE съеден без набора');
            return true;
        }
        if (!store)
        {
            this.log('перенаправление: таблица регистраций не подключена — 405');
            return false;
        }
        const row = store.list().find((e) => e.phone !== '' && e.phone === callee);
        if (!row)
        {
            this.log(`перенаправление: номер «${callee}» не в таблице — 405`);
            return false;
        }
        if (row.address === '')
        {
            this.log(
                `перенаправление: линия «${row.identifier}» без адреса ` +
                    '(REGISTER не приходил, адрес не задан) — 405',
            );
            return false;
        }
        const target = uri_host_port(row.address, DEFAULT_SIP_PORT);
        if (!target)
        {
            this.log(
                `перенаправление: битый адрес «${row.address}» ` +
                    `строки ${row.id} — 405`,
            );
            return false;
        }
        const sp = this.station.status();
        if (target.host === sp.host && target.port === sp.port)
        {
            // адресат — сама станция: dial ушёл бы в наш же UAS (петля).
            this.log('перенаправление: адресат — сама станция — без набора');
            return true;
        }
        // Инициатор: user из Contact входящего = identifier линии строки
        // таблицы, её phone — номер звонящего (по нему From); fallback —
        // user из From, пусто — первый абонент конфига (как в dial).
        const head = parse_sip_request_head(raw);
        const contact_id = /^sips?:([^@;>]+)/i.exec(head?.contact_uri ?? '')?.[1] ?? '';
        const from_id = /^sips?:([^@;>]+)/i.exec(head?.from_uri ?? '')?.[1] ?? '';
        const caller =
            this.resolve_caller(store, contact_id) ??
            this.resolve_caller(store, from_id) ??
            (/^\+?\d+$/.test(from_id) ? from_id : '');
        try
        {
            const init: DialInit = {
                callee,
                ...(caller ? { caller } : {}),
                target: `${target.host}:${target.port}`,
                origin: `${peer.host}:${peer.port}`,
                origin_via_only: true,
                // Байты INVITE — образец pimer.md (task_35): R-URI линии на
                // адресате, один Via (src — только в статусе/журнале).
                coral_style: true,
                ruri: `sip:${row.identifier}@${target.host}:${target.port}`,
                to_uri: `sip:${callee}@${sp.host}`,
                ruri_user: row.identifier,
                // Область игнорирования Trying/Ringing (task_36).
                forwarded: true,
            };
            this.dial(init);
            // Флаг уже выставлен: retransmit исходного INVITE не поднимет
            // повторного фан-аута, даже если копии ещё рассылаются.
            this.last_forward_cid = cid;
            // Умножение ×10 (doc/task_37_plan_2.md): остальные копии уходят
            // «разом» — в этом же synchronous-проходе хука; каждая со своим
            // Call-ID/branch/From-tag (build_call), байты — образец.
            let copies = 0;
            if (this.station.multiply_invite_mode())
            {
                for (let i = 1; i < FORWARD_MULTIPLY_COPIES; i += 1)
                {
                    this.start_shadow(init);
                    copies += 1;
                }
            }
            this.log(
                `перенаправление INVITE ${callee}: линия ${row.identifier} → ` +
                    `${row.address}, от ${caller || from_id || '—'} ` +
                    `(src ${peer.host}:${peer.port})` +
                    (copies > 0 ? `, ×${copies + 1} (умножение)` : ''),
            );
        }
        catch (e: unknown)
        {
            const err = e instanceof Error ? e.message : String(e);
            this.log(`перенаправление не удалось: ${err}`);
        }
        return true;
    }

    /**
     * Номер звонящего по identifier из Contact/From входящего INVITE —
     * phone строки таблицы (doc/task_34_plan_2.md); undefined — строки нет
     * или телефон не заполнен.
     */
    private resolve_caller(
        store: RegistrationsApi,
        identifier: string,
    ): string | undefined
    {
        if (identifier === '') return undefined;
        const row = store.list().find((e) => e.identifier === identifier);
        return row?.phone !== '' ? row?.phone : undefined;
    }

    /**
     * Хук входящих на время вызова: все ответы — наши (иначе станция считала
     * бы их мусором); BYE/ACK своего диалога — тоже; запросы — мимо (false).
     */
    private on_incoming(
        raw: string,
        proto: 'udp' | 'tcp',
        peer: { host: string; port: number },
    ): boolean
    {
        if (/^SIP\/2\.0\s/i.test(raw)) return this.on_response(raw);
        const method = /^([A-Z]+)\s+\S+\s+SIP\/2\.0$/im.exec(raw)?.[1] ?? '';
        const cid = sip_call_id(raw);
        const call = this.call;
        if (call && cid === call.call_id && method === 'BYE')
        {
            // Нижестоящая станция вешает трубку: 200 + завершение диалога.
            const sock = this.station.udp_socket();
            const resp = build_sip_response(200, 'OK', raw, [], 'outcall');
            if (sock && proto === 'udp')
                sock.send(Buffer.from(resp, 'utf8'), peer.port, peer.host);
            this.finish('завершён станцией (BYE)', false);
            return true;
        }
        // Диалог теневой копии ×10 (doc/task_37_plan_2.md): её BYE — 200 и
        // снятие, её ACK — потребление; прочее — мимо.
        const shadow = this.shadows.get(cid);
        if (shadow && method === 'BYE')
        {
            const sock = this.station.udp_socket();
            const resp = build_sip_response(200, 'OK', raw, [], 'outcall');
            if (sock && proto === 'udp')
                sock.send(Buffer.from(resp, 'utf8'), peer.port, peer.host);
            this.remove_shadow(shadow, 'завершён станцией (BYE)');
            return true;
        }
        if (shadow && method === 'ACK') return true;
        return call !== undefined && cid === call.call_id && method === 'ACK';
    }

    /**
     * Обработка ответа на наш запрос (INVITE/CANCEL/BYE) и терминации;
     * диспетч по Call-ID: главный вызов → тень ×10 → «не на наш вызов»
     * (doc/task_37_plan_2.md).
     */
    private on_response(raw: string): boolean
    {
        const call = this.call;
        const head = parse_sip_response(raw);
        if (!head)
        {
            this.log('ответ не на наш вызов — проигнорирован');
            return true;
        }
        if (!call || head.call_id !== call.call_id)
        {
            const shadow = this.shadows.get(head.call_id);
            if (shadow) this.on_shadow_response(shadow, raw, head);
            else this.log('ответ не на наш вызов — проигнорирован');
            return true;
        }
        const reason = /^SIP\/2\.0\s+\d{3}\s*(.*)$/i.exec(raw)?.[1]?.trim() ?? '';
        // Игнорирование Trying/Ringing перенаправленного INVITE
        // (doc/task_36_plan_2.md): флаг станции — 100/180 на вызов, поднятый
        // перенаправлением, будто не приходили (ни ringing, ни answered/
        // last_code). Ответ при этом потреблён хуком — в ignored станции не
        // попадёт; в журнале честная пометка «игнорирован».
        if (
            call.forwarded &&
            this.station.ignore_provisional_mode() &&
            head.cseq_method === 'INVITE' &&
            (head.status === 100 || head.status === 180)
        )
        {
            this.log(`← ${head.status} ${reason} (игнорирован: Trying/Ringing)`);
            return true;
        }
        this.last_code = head.status;
        this.last_reason = reason;
        this.answered.set(
            String(head.status),
            (this.answered.get(String(head.status)) ?? 0) + 1,
        );
        this.log(`← ${head.status} ${reason} (${head.cseq_method})`);
        if (head.cseq_method === 'INVITE') this.on_invite_response(call, head, reason);
        else if (head.cseq_method === 'BYE')
        {
            if (this.bye_timer) clearTimeout(this.bye_timer);
            this.bye_timer = undefined;
            if (this.state === 'terminating')
                this.finish(
                    head.status < 300 ? 'завершён (BYE 200)' : `BYE: ${head.status}`,
                    head.status >= 300,
                );
        }
        // Ответ на CANCEL сам по себе ничего не решает — ждём финал INVITE.
        return true;
    }

    /** Терминал INVITE-транзакции: 1xx/2xx (ACK, диалог) / финальный отказ. */
    private on_invite_response(
        call: OutCall,
        head: { status: number; to_tag: string; contact_uri: string },
        reason: string,
    ): void
    {
        if (head.status < 200)
        {
            if (this.state === 'calling') this.state = 'ringing';
            return;
        }
        if (head.status >= 300)
        {
            this.clear_invite_timer();
            // ACK на финальный не-2xx ОБЯЗАТЕЛЕН (RFC 3261 §17.1.1) и идёт
            // той же веткой транзакции, что INVITE, — иначе станция шлёт
            // финал повторно до 64·T1, а без хука дубли падают в ignored.
            this.send_ack(call, head.to_tag, call.branch);
            this.finish(`станция ответила ${head.status} ${reason}`, true);
            return;
        }
        // 2xx: диалог подтверждён; повторный 200 (потеря ACK) — повтор ACK.
        if (this.state === 'answered' || this.state === 'terminating')
        {
            this.send_ack(call, call.to_tag, undefined);
            return;
        }
        this.clear_invite_timer();
        call.to_tag = head.to_tag || call.to_tag;
        call.remote = uri_host_port(head.contact_uri, call.target.port) ?? call.target;
        this.state = 'answered';
        this.send_ack(call, call.to_tag, undefined);
        // Гонка CANCEL↔200: соединение уже есть — отбой невозможен, кладём BYE.
        if (this.cancel_timer)
        {
            clearTimeout(this.cancel_timer);
            this.cancel_timer = undefined;
            this.send_bye(call);
        }
    }

    /**
     * ACK: в диалоге (на 2xx) — новый branch, To-tag и адресат remote;
     * на не-2xx после CANCEL — тот же branch, что у INVITE.
     * @param count — false для теневых копий (счётчик `sent` главного
     * вызова не двигается, doc/task_37_plan_2.md).
     */
    private send_ack(
        call: OutCall,
        to_tag: string,
        branch: string | undefined,
        count = true,
    ): void
    {
        // ACK на не-2xx — транзакция INVITE: тот же Via-стек и branch.
        // ACK на 2xx — новый in-dialog транзакт: ОДИН Via (чужой Via в нём
        // уводит ответы станции), From — origin-домена (matching диалога).
        const msg = build_sip_request('ACK', {
            ruri: `sip:${call.ruri_user}@${call.remote.host}:${call.remote.port}`,
            from_uri: call.from_uri,
            to_uri:
                call.to_uri ??
                `sip:${call.callee}@${call.remote.host}:${call.remote.port}`,
            call_id: call.call_id,
            cseq: 1,
            from_tag: call.from_tag,
            ...(to_tag ? { to_tag } : {}),
            contact: `sip:${call.caller}@${this.config.station_host}:${this.station.status().port}`,
            via_host: this.config.station_host,
            ...(branch ? { branch, via_extra: call.via_extra } : {}),
            user_agent: OUTBOUND_USER_AGENT,
        });
        this.send_raw(msg, call.remote, 'ACK →', count);
    }

    // ---------- теневые копии ×10 (doc/task_37_plan_2.md) ----------

    /**
     * Теневая копия перенаправленного INVITE: тот же диалог, что у главного
     * вызова (build_call — те же байты, свои Call-ID/branch/From-tag), но
     * без видимого состояния: свой retransmit INVITE и снятие по финалу/
     * таймауту, судьба — строки журнала. Вызывается только после удачного
     * dial (движок уже занят, хук навешан главным).
     */
    private start_shadow(init: DialInit): void
    {
        const target = this.resolve_target(init.target);
        const call = this.build_call(init, target);
        const shadow: ShadowCall = {
            call,
            phase: 'calling',
            invite_timer: undefined,
            bye_timer: undefined,
            invite_done: false,
        };
        this.shadows.set(call.call_id, shadow);
        this.send_raw(call.raw, target, `INVITE → ${call.callee} (копия)`, false);
        this.shadow_arm_invite(shadow);
    }

    /** Retransmit INVITE копии — те же параметры, что у главного (удвоение
     * от T1 до 64·T1, затем таймаут и снятие). */
    private shadow_arm_invite(shadow: ShadowCall): void
    {
        const call = shadow.call;
        const delay = call.step;
        call.step = Math.min(call.step * 2, this.t1_max_ms + this.t1_ms);
        shadow.invite_timer = setTimeout(() =>
        {
            if (shadow.phase !== 'calling') return;
            if (delay > this.t1_max_ms)
            {
                this.remove_shadow(shadow, 'INVITE: нет ответа (timeout)');
                return;
            }
            this.send_raw(call.raw, call.target, 'INVITE ↻ (копия)', false);
            this.shadow_arm_invite(shadow);
        }, delay);
        shadow.invite_timer.unref();
    }

    /**
     * Ответ на запрос теневой копии: ignore_provisional действует как у
     * главного (call.forwarded); финал не-2xx — ACK той же веткой и снятие;
     * 2xx — ACK в диалог и немедленный BYE (копия линию не держит — иначе
     * десять соединённых вызовов без кнопок); BYE — снятие; повтор финала
     * 2xx (потеря ACK) — повтор ACK. Счётчики answered/last_code — за
     * главным вызовом, здесь только журнал.
     */
    private on_shadow_response(
        shadow: ShadowCall,
        raw: string,
        head: {
            status: number;
            to_tag: string;
            contact_uri: string;
            cseq_method: string;
        },
    ): void
    {
        const call = shadow.call;
        const tag = `копия ${call.call_id.slice(0, 8)}`;
        const reason = /^SIP\/2\.0\s+\d{3}\s*(.*)$/i.exec(raw)?.[1]?.trim() ?? '';
        if (
            call.forwarded &&
            this.station.ignore_provisional_mode() &&
            head.cseq_method === 'INVITE' &&
            (head.status === 100 || head.status === 180)
        )
        {
            this.log(`← ${head.status} ${reason} (${tag}, игнорирован)`);
            return;
        }
        if (head.cseq_method === 'BYE')
        {
            this.remove_shadow(shadow, `BYE: ${head.status} ${reason}`.trim());
            return;
        }
        // Ответ на CANCEL сам по себе ничего не решает — ждём финал INVITE.
        if (head.cseq_method !== 'INVITE') return;
        if (head.status < 200) return; // промежуточные копии не интересуют
        if (shadow.invite_done)
        {
            // Станция повторила финал (наш ACK потерян) — повторный ACK 2xx.
            if (head.status < 300) this.send_ack(call, call.to_tag, undefined, false);
            return;
        }
        shadow.invite_done = true;
        if (shadow.invite_timer) clearTimeout(shadow.invite_timer);
        shadow.invite_timer = undefined;
        if (head.status >= 300)
        {
            // ACK на финальный не-2xx обязателен (RFC 3261 §17.1.1), той же
            // веткой транзакции — иначе станция шлёт финал до 64·T1.
            this.send_ack(call, head.to_tag, call.branch, false);
            this.remove_shadow(shadow, `станция ответила ${head.status} ${reason}`);
            return;
        }
        // 2xx: ACK в диалог и сразу BYE — копия не занимает линию.
        call.to_tag = head.to_tag || call.to_tag;
        call.remote = uri_host_port(head.contact_uri, call.target.port) ?? call.target;
        shadow.phase = 'terminating';
        this.send_ack(call, call.to_tag, undefined, false);
        this.shadow_send_bye(shadow);
    }

    /** BYE копии (после 2xx): retransmit с удвоением; таймаут — снятие
     * всё равно (зачистка диалога best-effort). */
    private shadow_send_bye(shadow: ShadowCall): void
    {
        const call = shadow.call;
        const msg = this.bye_msg(call);
        call.step = this.t1_ms;
        this.send_raw(msg, call.remote, 'BYE → (копия)', false);
        const arm = (): void =>
        {
            const delay = call.step;
            call.step = Math.min(call.step * 2, this.t1_max_ms + this.t1_ms);
            shadow.bye_timer = setTimeout(() =>
            {
                if (shadow.phase !== 'terminating') return;
                if (delay > this.t1_max_ms)
                {
                    this.remove_shadow(shadow, 'BYE: нет ответа (timeout)');
                    return;
                }
                this.send_raw(msg, call.remote, 'BYE ↻ (копия)', false);
                arm();
            }, delay);
            shadow.bye_timer.unref();
        };
        arm();
    }

    /**
     * Снятие копии: таймеры гасятся, запись уходит из карты, строка журнала;
     * хук станции отпускается через maybe_release_hook (главный вызов мог
     * завершиться раньше копий).
     */
    private remove_shadow(shadow: ShadowCall, text: string): void
    {
        if (shadow.invite_timer) clearTimeout(shadow.invite_timer);
        shadow.invite_timer = undefined;
        if (shadow.bye_timer) clearTimeout(shadow.bye_timer);
        shadow.bye_timer = undefined;
        this.shadows.delete(shadow.call.call_id);
        this.log(`копия ${shadow.call.call_id.slice(0, 8)}: ${text}`);
        this.maybe_release_hook();
    }

    /**
     * Хук входящих отпускается только когда главный вызов в idle И живых
     * копий не осталось: копии продолжают транзакции после finish() главного
     * (doc/task_37_plan_2.md). Идемпотентен.
     */
    private maybe_release_hook(): void
    {
        if (this.state !== 'idle' || this.shadows.size > 0) return;
        this.off_hook?.();
        this.off_hook = undefined;
    }

    /** Переход в idle: таймеры главного вызова гасятся; хук станции
     * снимается, только если и теневые копии завершены (maybe_release_hook). */
    private finish(text: string, is_error: boolean): void
    {
        this.clear_invite_timer();
        if (this.cancel_timer) clearTimeout(this.cancel_timer);
        this.cancel_timer = undefined;
        if (this.bye_timer) clearTimeout(this.bye_timer);
        this.bye_timer = undefined;
        this.state = 'idle';
        this.maybe_release_hook();
        if (is_error) this.error_text = text;
        this.log(`вызов: ${text}`);
    }

    private log(text: string): void
    {
        this.log_ring.unshift(`[${new Date().toISOString()}] ${text}`);
        if (this.log_ring.length > LOG_RING) this.log_ring.length = LOG_RING;
    }
}
