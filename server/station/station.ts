// Эмулятор телефонной станции — SIP-UAS-листок (plan_4.md п.1): входящий
// OPTIONS (keep-alive пира) → 200 как у pa_sip (`keep_alive_reply: cause =
// 200`, doc/los_mem), прочие методы → 405 Method Not Allowed, мусор/не-SIP —
// игнор с счётчиком. Станция НИЧЕГО не отправляет сама — только ответы.
//
// Контракты и проверенное поведение первоисточника:
// - Allow/Allow-Events/User-Agent взяты дословно из сырых дампов doc/los_mem
//   (grep `Allow:`/`Allow-Events:`/`User-Agent:` по traces_normal_load,
//   NOTIFY/call_answer 74101–74102); заголовка Server: в дампах нет — не
//   добавляем (иначе мимикрия расходится с трассой);
// - UDP-ответ уходит на src-порт пира (rinfo — «rport»-семантика), TCP — в то
//   же соединение, фрейминг по Content-Length (тот же алгоритм, что feed_tcp()
//   в server/los_mem/raw_sip.ts:539 — он не экспортируется, повторён ниже);
// - обработчик не бросает: ошибка сокета → state `stopped` + текст ошибки
//   (HTTP-сервер express не роняем, plan_4.md п.1);
// - входящие раньше мимикрии смотрят хуки `add_incoming_hook` (мультикаст:
//   стимул/SAS/вызов забирают свои сообщения параллельно, OPTIONS остаётся
//   станции; doc/task_26, doc/task_31_plan_2.md);
// - пассивный UAS подписок (план 5 п.4a/4c): SUBSCRIBE пакетов
//   event-list/dialog-info/dialog/presence/blf → 200 с Contact станции и
//   To-тегом, ОТВЕТ СРАЗУ (без ожидания живого клиента прогона — иначе пир
//   пишет cause 408 по таймерам pjsip); подписка хранится в `subscriptions()`
//   — из неё генератор шлёт event-list NOTIFY в диалоге принятой подписки
//   (путь sub_on_rx_notify_uac, единственный вход в ss_on_rx_notify);
//   без принятия подписки обработчика на станции нет — любой NOTIFY → 500
//   «Unknown method» (дамп doc/los_mem/act_log_2.157.log, 90/90);
// - `udp_socket()` — станция отдаёт сокет наружу: стимул уходит с порта :5060,
//   keep-alive пира по Contact возвращается на станцию (doc/task_25_plan_2.md);
// - SAS-режим (план 6 п.1, дамп doc/los_mem/new_log/11.log): включаемая роль
//   SAS/SSW-сервера — REGISTER станции (port-register, R-URI u00sXXpXX@наш)
//   → 200 с эхом Contact/Expires, SUBSCRIBE ЛЮБОГО Event → 200 (имя SAS-
//   пакета SSW_SRVM на проводе неизвестно; 405 убивает подписку:
//   `subscribe-status … cause 405`, SAS mode гаснет). Вне режима — прежняя
//   мимикрия (405), автозапуска нет;
// - режим «не отвечать на вызовы» (doc/task_29): включаемый флаг — INVITE
//   от пира (вызов от нижестоящей станции) остаётся СОВСЕМ без ответа:
//   прежний 405 выдаёт станции живость UAS, тишина имитирует зависший/
//   отсутствующий терминал. Ретрансляции того же INVITE молчат тоже;
//   прочие методы (OPTIONS/REGISTER/…) отвечаются как раньше;
// - режим «перенаправлять вызовы по таблице регистраций»
//   (doc/task_34_plan_2.md, переопределяет doc/task_32_plan_2.md):
//   включаемый флаг `forward_invite` — INVITE от пира не получает ответа
//   мимикрии, а ретранслируется движком исходящего вызова по строке таблицы
//   регистраций: адресат — address строки (phone=номер из R-URI), R-URI —
//   identifier линии на нашем IP, From/To/Contact — наш IP (From = номер
//   звонящего, найденный по identifier из Contact), src отправителя —
//   второй Via. Флаг читает постоянный хук StationOutbound, INVITE
//   «съедается» хуком раньше мимикрии — обработчик ниже его не видит
//   (в журнале code 0, как в молчании); маршрут не найден (нет строки /
//   пуст address / таблица не подключена) — хук не съедает: прежний 405.
//   Без движка вызова в процессе флаг ни на что не влияет;
// - режим «игнорировать Trying/Ringing после перенаправленного INVITE»
//   (doc/task_36_plan_2.md): включаемый флаг `ignore_provisional` — движок
//   вызова не замечает 100/180 на INVITE, поднятый перенаправлением: без
//   перехода calling→ringing, без счётчиков (ответ лишь потребляется хуком
//   и помечается в журнале «игнорирован»). Флаг читает StationOutbound;
//   прямой вызов и прочие 1xx не затрагиваются;
// - режим «умножать перенаправляемый INVITE ×10» (doc/task_37_plan_2.md):
//   включаемый флаг `multiply_invite` — при перенаправлении входящий INVITE
//   ретранслируется не одной копией, а десятью разом (разные
//   Call-ID/branch/From-tag, байты — прежний образец pimer.md). Флаг читает
//   StationOutbound в своём хуке; без `forward_invite` ни на что не влияет
//   (INVITE мимикрия отвечает 405/молчание как раньше);
// - адрес нижестоящей станции (`last_downstream_peer`): src последнего
//   REGISTER/OPTIONS/SUBSCRIBE пира — им пользуется движок исходящего вызова
//   (server/station/outbound.ts) как адресат INVITE по умолчанию;
// - таблица регистраций (doc/task_33_plan_2.md): в SAS-режиме REGISTER пира
//   дополнительно пишется в подключённое хранилище (`attach_registrations`)
//   — identifier (user из R-URI, u00sXXpXX) + src-адрес запроса; вне режима
//   (405) регистраций не копится;
// - start()/stop() идемпотентны; слушатель поднимается только кнопкой со
//   страницы (автозапуска нет, plan_4.md «Объём»);
// - DI-контракт Station — по образцу SipPool (api-тесты п.9 подставляют мок).
// related: server/los_mem/raw_sip.ts (parse_sip_request_head,
// build_sip_response, uri_host_port), server/los_mem/scenarios.ts
// (StationSubView — форма записи принятой подписки), server/config.ts
// (station_host/port/proto), server/controllers/station_controller.ts,
// server/station/sas.ts (движок SAS поверх sas_mode/udp_socket),
// server/station/outbound.ts (исходящий INVITE поверх udp_socket/хука),
// server/station/registrations.ts (таблица регистраций, attach_registrations),
// doc/task_24_plan_2.md, doc/task_27_plan_2.md, doc/plan_6.md,
// doc/task_29_plan_2.md, doc/task_30_plan_2.md, doc/task_32_plan_2.md,
// doc/task_33_plan_2.md, doc/task_36_plan_2.md, doc/task_37_plan_2.md.

import dgram from 'node:dgram';
import net from 'node:net';
import type { AppConfig } from '../config';
import type { StationSubView } from '../los_mem/scenarios';
import type { RegistrationsApi } from './registrations';
import {
    build_sip_response,
    parse_sip_request_head,
    uri_host_port,
} from '../los_mem/raw_sip';

/**
 * Значение Allow ответа 200 — список из трассы pa_sip (doc/los_mem,
 * `Allow: INVITE, …` в дампах 200-ответов станции).
 */
const OPTIONS_ALLOW =
    'INVITE, ACK, BYE, CANCEL, PRACK, REGISTER, INFO, REFER, NOTIFY, ' +
    'OPTIONS, SUBSCRIBE, MESSAGE, UPDATE, PUBLISH';

/**
 * Allow-Events 200-ответа — точное значение из дампа (`Allow-Events:
 * presence, dialog, …`, pbx_sip.2.log:74102).
 */
const OPTIONS_ALLOW_EVENTS = 'presence, dialog, conference, as-feature-event, keep-alive';

/**
 * User-Agent мимикрии — дамп станции (`User-Agent: Eltex ECSS-10 SIP
 * 3.14.15.27.4`, pbx_sip.2.log:74098).
 */
const STATION_USER_AGENT = 'Eltex ECSS-10 SIP 3.14.15.27.4';

/**
 * Заголовки 200 на OPTIONS — те, что добавляет keep_alive_reply (plan_4.md
 * «Context»).
 */
const OPTIONS_ANSWER_HEADERS = [
    `Allow: ${OPTIONS_ALLOW}`,
    `Allow-Events: ${OPTIONS_ALLOW_EVENTS}`,
    `User-Agent: ${STATION_USER_AGENT}`,
];

/**
 * To-tag ответов (build_sip_response дописывает, если в запросе To без tag).
 */
const STATION_TO_TAG = 'station';

/**
 * Пакеты, на которые пассивный UAS отвечает 200 (план 5 п.4a): имена из
 * трасс/дампов — `event-list` (SSW_SRVM, кейс B), `dialog`/`dialog-info`
 * (BLF), `presence`, `blf`. Прочие события — как раньше (405): мимикрия
 * не обещает станции поддержку, которой нет.
 */
const SUBSCRIBE_EVENTS = ['event-list', 'dialog-info', 'dialog', 'presence', 'blf'];

/**
 * Expires принятой подписки, если запрос его не задал (в SUBSCRIBE станции
 * из дампов — 600..7200; наше значение только для локального протухания).
 */
const SUBSCRIBE_DEFAULT_EXPIRES = 600;

/**
 * Expires ответа на REGISTER в SAS-режиме, если запрос его не задал
 * (port-register станции из 11.log — expires 3600).
 */
const REGISTER_DEFAULT_EXPIRES = 3600;

/**
 * Ёмкость ring-buffer журнала обращений (plan_4.md п.1 — «последние ~200»).
 */
const EVENTS_BUFFER = 200;

/**
 * Хук входящих сообщений станции (doc/task_26: стимулы утечки идут через
 * сокет станции). Вызывается в handle_request ДО разбора/дефолтных ответов:
 * вернуть true — сообщение «съедено» делегатом (он сам ответил/скормил своим
 * клиентам), дефолтный ответ не шлём (иначе SUBSCRIBE станции получил бы
 * и 200 от UAS стимула, и 405 от станции); false — штатная мимикрия
 * (OPTIONS→200, прочее→405). Делегат обязан быть синхронным и не бросать.
 */
export type IncomingHook = (
    raw: string,
    proto: 'udp' | 'tcp',
    peer: { host: string; port: number },
) => boolean;

/**
 * Принятая подписка станции (её SUBSCRIBE к нам, план 5 п.4a): всё, что
 * нужно генератору для event-list NOTIFY в этом диалоге (поля — в
 * StationSubView, там же `expires_at`: ISO-истечение по запрошенному
 * Expires, остаток уходит в `Subscription-State` наших NOTIFY; просроченные
 * записи вычищаются). Поле `cseq` — счётчик наших NOTIFY, двигает его
 * `take_notify_cseq` (монотонность); `remote` — Contact из её SUBSCRIBE
 * (адресат NOTIFY), при пустом Contact — src-адрес запроса.
 */
export interface StationSubscription extends StationSubView
{}

/**
 * Строка журнала обращений станции (GET /api/station/events, newest first).
 */
export interface StationEvent
{
    /** ISO-время разбора сообщения. */
    ts: string;
    /** Пир `host:port` — src адреса запроса (UDP rinfo / TCP remote). */
    peer: string;
    proto: 'udp' | 'tcp';
    /** Метод запроса; `?` — мусор/не-SIP. */
    method: string;
    /** R-URI из request-line (пусто для мусора). */
    ruri: string;
    /** Значение CSeq целиком (`14 OPTIONS`, '' — нет заголовка). */
    cseq: string;
    call_id: string;
    /** Код отправленного ответа; 0 — ответ не отправлялся (мусор, INVITE
     * в режиме «не отвечать на вызовы» doc/task_29 или INVITE, забранный
     * хуком перенаправления doc/task_32_plan_2.md). */
    code: number;
    /** Имя Event у SUBSCRIBE/NOTIFY ('' — прочих методов нет) — план 6 п.1:
     * в SAS-режиме по нему видно, как станция называет SSW-пакет на проводе. */
    event: string;
}

/**
 * Счётчики станции для статуса и вкладки «Станция».
 */
export interface StationCounters
{
    /** Принято запросов по методу (мусор сюда не входит). */
    requests_in: { [method_name: string]: number };
    /** Отправлено ответов по коду (`{'200': 12, '405': 1}`). */
    answered: { [code_name: string]: number };
    /** Игнорировано не-SIP сообщений (datagram/сообщение после фрейминга). */
    ignored: number;
    /** Пир-адреса (`host:port`), обращавшиеся к станции. */
    peers: string[];
}

/**
 * Снимок состояния сервиса (GET /api/station, GET /api/health блок station).
 */
export interface StationStatus
{
    state: 'stopped' | 'running';
    host: string;
    /** Фактически занятый порт (при порт 0 — эфемерный; в stopped — из конфига). */
    port: number;
    proto: 'udp' | 'tcp' | 'both';
    /** Секунды с успешного start(); в stopped — 0. */
    uptime_s: number;
    counters: StationCounters;
    /** ISO-время последнего OPTIONS; '' — ещё не было. */
    last_keepalive_at: string;
    /** Текст последней ошибки сокета; '' — чисто. */
    error: string;
    /** Режим «не отвечать на вызовы (INVITE)» (doc/task_29). */
    silent_invite: boolean;
    /** Режим «перенаправлять INVITE на адрес из его R-URI»
     * (doc/task_32_plan_2.md). */
    forward_invite: boolean;
    /** Режим «игнорировать Trying/Ringing после перенаправленного INVITE»
     * (doc/task_36_plan_2.md). */
    ignore_provisional: boolean;
    /** Режим «умножать перенаправляемый INVITE ×10»
     * (doc/task_37_plan_2.md). */
    multiply_invite: boolean;
    /** `host:port` последнего обращения нижестоящей станции (REGISTER/
     * OPTIONS/SUBSCRIBE); '' — пир ещё не обращался (doc/task_30_plan_2.md). */
    last_downstream: string;
}

/**
 * DI-контракт станции (plan_4.md п.1, по образцу SipPool п.4.2): контроллеры
 * и страница зависят только от него — в api-тестах подставляется мок.
 */
export interface Station
{
    /**
     * Снимок состояния; только чтение, бросать не может.
     */
    status(): StationStatus;
    /**
     * Флаг SAS-режима (план 6 п.1): true — REGISTER → 200 и SUBSCRIBE любого
     * Event → 200; false — прежняя мимикрия (405).
     */
    sas_mode(): boolean;
    /**
     * Включить/выключить SAS-режим (роль SAS/SSW-сервера для станции-пира);
     * идемпотентно, бросать не может.
     */
    set_sas_mode(on: boolean): void;
    /**
     * Флаг режима «не отвечать на вызовы» (doc/task_29): true — INVITE от
     * пира остаётся без ответа; false — прежний 405.
     */
    silent_invite_mode(): boolean;
    /**
     * Включить/выключить режим молчания на INVITE; идемпотентно, живёт между
     * start/stop (настройка станции, не слушателя), бросать не может.
     */
    set_silent_invite(on: boolean): void;
    /**
     * Флаг режима «перенаправлять INVITE по таблице регистраций»
     * (doc/task_34_plan_2.md): true — входящий INVITE забирается хуком
     * движка вызова и ретранслируется на адрес из строки таблицы (R-URI —
     * identifier линии на нашем IP, From/To/Contact — наш IP); false —
     * прежнее поведение (405 или молчание).
     */
    forward_invite_mode(): boolean;
    /**
     * Включить/выключить перенаправление INVITE; идемпотентно, живёт между
     * start/stop (настройка станции, не слушателя), бросать не может.
     */
    set_forward_invite(on: boolean): void;
    /**
     * Флаг режима «игнорировать Trying/Ringing после перенаправленного
     * INVITE» (doc/task_36_plan_2.md): true — движок вызова не замечает
     * 100/180 на перенаправленный INVITE; false — прежняя обработка.
     */
    ignore_provisional_mode(): boolean;
    /**
     * Включить/выключить игнорирование Trying/Ringing; идемпотентно, живёт
     * между start/stop (настройка станции, не слушателя), бросать не может.
     */
    set_ignore_provisional(on: boolean): void;
    /**
     * Флаг режима «умножать перенаправляемый INVITE ×10»
     * (doc/task_37_plan_2.md): true — при перенаправлении входящий INVITE
     * ретранслируется десятью копиями разом; false — прежняя одиночная
     * ретрансляция.
     */
    multiply_invite_mode(): boolean;
    /**
     * Включить/выключить умножение перенаправляемого INVITE; идемпотентно,
     * живёт между start/stop (настройка станции, не слушателя), бросать не
     * может.
     */
    set_multiply_invite(on: boolean): void;
    /**
     * Журнал обращений, newest first; limit по умолчанию — вся ёмкость буфера.
     */
    events(limit?: number): StationEvent[];
    /**
     * Поднять слушатели; повторный вызов на running — no-op (идемпотентность).
     * Бросает Error с русским текстом при неудачном bind (EACCES/EADDRINUSE) —
     * контроллер кодирует её в 502.
     */
    start(): Promise<void>;
    /**
     * Снять слушатели; на stopped — no-op. Счётчики и журнал сохраняются.
     */
    stop(): Promise<void>;
}

/**
 * Русское описание ошибки bind/сокета с подсказкой про привилегии порта
 * (plan_4.md п.3: 502 обязан нести подсказку про root/setcap).
 */
function bind_error_text(e: unknown, host: string, port: number): string
{
    const code = e instanceof Error ? e.message : String(e);
    const hint =
        e instanceof Error && e.message.includes('EACCES')
            ? ' — порт привилегированный (<1024): нужен root или ' +
              '`sudo setcap cap_net_bind_service=+ep $(which node)`'
            : '';
    const kind =
        e instanceof Error && e.message.includes('EADDRINUSE')
            ? 'порт уже занят'
            : 'ошибка слушателя';
    return `Не поднять станцию ${host}:${port} (${kind}): ${code}${hint}`;
}

/**
 * Собственная станция: UDP (dgram) и/или TCP (net) UAS на адресах из конфига
 * (station_host/port/proto). Счётчики и журнал живут между start/stop —
 * перезапуск не обнуляет накопленное (вкладка показывает историю сессии).
 */
export class SipStation implements Station
{
    private udp: dgram.Socket | undefined;
    private tcp: net.Server | undefined;
    /**
     * Живые TCP-соединения — stop() обязан их destroying, иначе server.close()
     * не завершится, а пир продолжит получать ответы после «остановить».
     */
    private readonly tcp_sockets = new Set<net.Socket>();
    private service_state: StationStatus['state'] = 'stopped';
    /** Фактически занятый порт (0 — слушателей нет; при порт 0 — эфемерный). */
    private bound_port = 0;
    private started_at = 0;
    private readonly requests_in = new Map<string, number>();
    private readonly answered = new Map<string, number>();
    private ignored = 0;
    private readonly peers = new Set<string>();
    private last_keepalive = '';
    private error_text = '';
    /** Ring-buffer обращений: старые сверху, свежие дописываются в конец. */
    private readonly journal_ring: StationEvent[] = [];
    /**
     * Хуки входящих (мультикаст, doc/task_31_plan_2.md): движки стимули/SAS/
     * вызова живут параллельно — сообщение получают ВСЕ, «съедено» если хоть
     * один взял; ни одного — мимикрия.
     */
    private readonly incoming_hooks: IncomingHook[] = [];
    /** Принятые подписки пира (Call-ID → запись, план 5 п.4a). */
    private readonly sub_dialogs = new Map<string, StationSubscription>();
    /** Счётчик To-тегов подписок (уникален между диалогами). */
    private sub_tag_seq = 0;
    /** SAS-режим (план 6 п.1): REGISTER→200, SUBSCRIBE любого Event→200. */
    private sas_enabled = false;
    /** Режим «не отвечать на INVITE» (doc/task_29): вызов пира без ответа. */
    private silent_invite = false;
    /** Режим «перенаправлять INVITE» (doc/task_32_plan_2.md): хук движка
     * вызова ретранслирует INVITE на адрес из R-URI. */
    private forward_invite = false;
    /** Режим «игнорировать Trying/Ringing перенаправленного INVITE»
     * (doc/task_36_plan_2.md): флаг читает StationOutbound. */
    private ignore_provisional = false;
    /** Режим «умножать перенаправляемый INVITE ×10»
     * (doc/task_37_plan_2.md): флаг читает StationOutbound. */
    private multiply_invite = false;
    /**
     * Src последнего REGISTER/OPTIONS/SUBSCRIBE пира — адрес нижестоящей
     * станции для исходящего INVITE (server/station/outbound.ts).
     */
    private last_downstream: { host: string; port: number } | undefined;
    /**
     * Таблица регистраций (doc/task_33_plan_2.md): wire-up из main.ts;
     * undefined — хранилища нет (записи не ведём).
     */
    private registrations: RegistrationsApi | undefined;

    constructor(private readonly config: AppConfig)
    {}

    /**
     * Снимок состояния сервиса (контракт Station).
     */
    status(): StationStatus
    {
        const running = this.service_state === 'running';
        return {
            state: this.service_state,
            host: this.config.station_host,
            port: running ? this.bound_port : this.config.station_port,
            proto: this.config.station_proto,
            uptime_s: running ? Math.round((Date.now() - this.started_at) / 1000) : 0,
            counters: {
                requests_in: Object.fromEntries(this.requests_in),
                answered: Object.fromEntries(this.answered),
                ignored: this.ignored,
                peers: [...this.peers],
            },
            last_keepalive_at: this.last_keepalive,
            error: this.error_text,
            silent_invite: this.silent_invite,
            forward_invite: this.forward_invite,
            ignore_provisional: this.ignore_provisional,
            multiply_invite: this.multiply_invite,
            last_downstream: this.last_downstream
                ? `${this.last_downstream.host}:${this.last_downstream.port}`
                : '',
        };
    }

    /**
     * Адрес последнего обращения нижестоящей станции (REGISTER/OPTIONS/
     * SUBSCRIBE); undefined — пир ещё не обращался. Движок исходящего вызова
     * использует его как адресат INVITE по умолчанию (doc/task_30_plan_2.md).
     */
    last_downstream_peer(): { host: string; port: number } | undefined
    {
        return this.last_downstream;
    }

    /**
     * Журнал обращений, newest first (контракт Station).
     */
    events(limit = EVENTS_BUFFER): StationEvent[]
    {
        return this.journal_ring.slice(-Math.max(0, limit)).reverse();
    }

    /**
     * UDP-сокет слушателя (null — остановлена): станция отдаёт его движку
     * стимулов, чтобы тот слал от адреса станции (:5060) и keep-alive пира
     * возвращался на неё же (doc/task_25_plan_2.md). Владелец сокета —
     * станция; close() чужих клиентов его не закрывает.
     */
    udp_socket(): dgram.Socket | undefined
    {
        return this.udp;
    }

    /**
     * Повесить хук входящих (движок стимула/SAS/вызова на время своей работы).
     * Хуки мультикастятся (doc/task_31_plan_2.md): SAS и вызов забирают свои
     * ответы параллельно, порядок навешивания не важен.
     * @return дизпоузер — снимает только этот хук (идемпотентен).
     */
    add_incoming_hook(hook: IncomingHook): () => void
    {
        this.incoming_hooks.push(hook);
        return (): void =>
        {
            const i = this.incoming_hooks.indexOf(hook);
            if (i >= 0) this.incoming_hooks.splice(i, 1);
        };
    }

    /**
     * Повесить хранилище таблицы регистраций (wire-up из main.ts,
     * doc/task_33_plan_2.md). НЕ часть контракта Station: REGISTER+SAS-ветка
     * зовёт только record(), идемпотентный upsert (retransmit REGISTER —
     * повторный вызов, дедуп не нужен).
     */
    attach_registrations(store: RegistrationsApi): void
    {
        this.registrations = store;
    }

    /**
     * Флаг SAS-режима (контракт Station, план 6 п.1).
     */
    sas_mode(): boolean
    {
        return this.sas_enabled;
    }

    /**
     * Включить/выключить SAS-режим; идемпотентно. Само по себе ничего не
     * шлёт — инициативные NOTIFY живут в StationSas (server/station/sas.ts).
     */
    set_sas_mode(on: boolean): void
    {
        this.sas_enabled = on;
    }

    /**
     * Флаг режима «не отвечать на вызовы» (контракт Station, doc/task_29).
     */
    silent_invite_mode(): boolean
    {
        return this.silent_invite;
    }

    /**
     * Включить/выключить молчание на INVITE; идемпотентно. Флаг живёт между
     * start/stop — это настройка поведения станции, а не слушателя.
     */
    set_silent_invite(on: boolean): void
    {
        this.silent_invite = on;
    }

    /**
     * Флаг режима «перенаправлять INVITE по таблице регистраций»
     * (контракт Station, doc/task_34_plan_2.md).
     */
    forward_invite_mode(): boolean
    {
        return this.forward_invite;
    }

    /**
     * Включить/выключить перенаправление INVITE; идемпотентно. Сам флаг —
     * только настройка: INVITE забирает постоянный хук StationOutbound,
     * без движка в процессе флаг ни на что не влияет.
     */
    set_forward_invite(on: boolean): void
    {
        this.forward_invite = on;
    }

    /**
     * Флаг режима «игнорировать Trying/Ringing после перенаправленного
     * INVITE» (контракт Station, doc/task_36_plan_2.md).
     */
    ignore_provisional_mode(): boolean
    {
        return this.ignore_provisional;
    }

    /**
     * Включить/выключить игнорирование Trying/Ringing; идемпотентно. Сам
     * флаг — только настройка: 100/180 фильтрует StationOutbound в своём
     * хуке ответов, без движка в процессе флаг ни на что не влияет.
     */
    set_ignore_provisional(on: boolean): void
    {
        this.ignore_provisional = on;
    }

    /**
     * Флаг режима «умножать перенаправляемый INVITE ×10» (контракт Station,
     * doc/task_37_plan_2.md).
     */
    multiply_invite_mode(): boolean
    {
        return this.multiply_invite;
    }

    /**
     * Включить/выключить умножение перенаправляемого INVITE; идемпотентно.
     * Сам флаг — только настройка: фан-аут делает StationOutbound в хуке
     * перенаправления, без движка и без `forward_invite` флаг ни на что не
     * влияет.
     */
    set_multiply_invite(on: boolean): void
    {
        this.multiply_invite = on;
    }

    /**
     * Живые принятые подписки (просроченные вычищаются): источник NOTIFY для
     * генератора (t1/t2/t8 через ctx.station_subs, зонд doc/.probe_case_b.ts).
     * Копии записей — менять cseq напрямую нельзя (только take_notify_cseq).
     */
    subscriptions(): StationSubscription[]
    {
        this.prune_subs();
        return [...this.sub_dialogs.values()].map((s) => ({ ...s }));
    }

    /**
     * Следующий монотонный CSeq для нашего NOTIFY в диалог call_id;
     * undefined — диалога нет (истёк/снят).
     */
    take_notify_cseq(call_id: string): number | undefined
    {
        this.prune_subs();
        const sub = this.sub_dialogs.get(call_id);
        if (!sub) return undefined;
        sub.cseq += 1;
        return sub.cseq;
    }

    /**
     * Число живых принятых подписок (сводки/тесты без копирования записей).
     */
    subscriptions_count(): number
    {
        this.prune_subs();
        return this.sub_dialogs.size;
    }

    /**
     * Поднять слушатели по station_proto (udp|tcp|both, plan_4.md п.1).
     * При порт 0 UDP занимает эфемерный порт первым, TCP binds на тот же номер
     * — иначе status().port двусмысленен (у двух слушателей разные порты).
     */
    async start(): Promise<void>
    {
        if (this.service_state === 'running') return;
        const host = this.config.station_host;
        const port = this.config.station_port;
        const want_udp = this.config.station_proto !== 'tcp';
        const want_tcp = this.config.station_proto !== 'udp';
        let bound = port;
        try
        {
            if (want_udp)
            {
                this.udp = await this.listen_udp(host, port);
                bound = this.udp.address().port;
            }
            if (want_tcp)
            {
                this.tcp = await this.listen_tcp(host, bound);
                // tcp-only: номер порта занимает сам TCP-сервер, с него и берём.
                if (!want_udp) bound = (this.tcp.address() as net.AddressInfo).port;
            }
        }
        catch (e: unknown)
        {
            this.close_sockets();
            throw new Error(bind_error_text(e, host, port));
        }
        this.bound_port = bound;
        this.error_text = '';
        this.started_at = Date.now();
        this.service_state = 'running';
    }

    /**
     * Снять слушатели и разорвать TCP-соединения; идемпотентно.
     */
    async stop(): Promise<void>
    {
        this.close_sockets();
        this.service_state = 'stopped';
    }

    // ---------- слушатели ----------

    private listen_udp(host: string, port: number): Promise<dgram.Socket>
    {
        return new Promise<dgram.Socket>((resolve, reject) =>
        {
            const sock = dgram.createSocket('udp4');
            let up = false;
            sock.on('error', (e: Error) =>
            {
                // до 'listening' ошибка bind — в старт; после — штатная
                // runtime-ошибка: честный stopped, процесс не роняем.
                if (up) this.on_socket_error(e);
                else reject(e);
            });
            sock.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) =>
            {
                const resp = this.handle_request(msg.toString('utf8'), 'udp', {
                    host: rinfo.address,
                    port: rinfo.port,
                });
                // ответ на src-порт пира — rport-семантика (plan_4.md п.1);
                // ошибки отправки придут в 'error' того же сокета.
                if (resp) sock.send(Buffer.from(resp, 'utf8'), rinfo.port, rinfo.address);
            });
            sock.once('listening', () =>
            {
                up = true;
                resolve(sock);
            });
            sock.bind(port, host);
        });
    }

    private listen_tcp(host: string, port: number): Promise<net.Server>
    {
        return new Promise<net.Server>((resolve, reject) =>
        {
            const srv = net.createServer((sock) =>
            {
                this.serve_tcp(sock);
            });
            let up = false;
            srv.on('error', (e: Error) =>
            {
                if (up) this.on_socket_error(e);
                else reject(e);
            });
            srv.listen(port, host, () =>
            {
                up = true;
                resolve(srv);
            });
        });
    }

    /**
     * Обработчик TCP-соединения: буфер + фрейминг по Content-Length — тот же
     * алгоритм, что feed_tcp() (server/los_mem/raw_sip.ts:539, не экспортируется
     * → повтор здесь, plan_4.md п.1); ответ — в то же соединение.
     */
    private serve_tcp(sock: net.Socket): void
    {
        this.tcp_sockets.add(sock);
        let buf = Buffer.alloc(0);
        sock.on('data', (chunk: Buffer) =>
        {
            buf = Buffer.concat([buf, chunk]);
            for (;;)
            {
                const header_end = buf.indexOf('\r\n\r\n');
                if (header_end < 0) return;
                const head = buf.subarray(0, header_end).toString('utf8');
                const m = /content-length:\s*(\d+)/i.exec(head);
                const len = m ? Number(m[1]) : 0;
                const total = header_end + 4 + len;
                if (buf.length < total) return;
                const msg = buf.subarray(0, total).toString('utf8');
                buf = buf.subarray(total);
                const resp = this.handle_request(msg, 'tcp', {
                    host: sock.remoteAddress ?? '?',
                    port: sock.remotePort ?? 0,
                });
                if (resp) sock.write(resp, 'utf8');
            }
        });
        // пир мог оборвать соединение в любой момент — это не ошибка станции.
        sock.on('error', () =>
        {
            /* noop: разрыв пира штатен (keep-alive ходит короткими сессиями) */
        });
        sock.on('close', () =>
        {
            this.tcp_sockets.delete(sock);
        });
    }

    // ---------- разбор и ответы ----------

    /**
     * Обработать одно message: сначала хук входящих (стимул), затем 200 на
     * OPTIONS, 405 на прочие методы, '' на мусор (счётчик ignored). Не бросает:
     * любой исход — только счётчики и журнал.
     * @return текст ответа или '' (мусор/не-SIP/съедено хуком — слать нечего).
     */
    private handle_request(
        raw: string,
        proto: 'udp' | 'tcp',
        peer: { host: string; port: number },
    ): string
    {
        const peer_str = `${peer.host}:${peer.port}`;
        // Хуки раньше разбора (мультикаст, doc/task_31): сообщение получают
        // ВСЕ движки — SAS забирает ответы на свои NOTIFY, вызов — свои
        // ответы/BYE/ACK, стимул — всё своим клиентам; «съедено» если хоть
        // один взял, мимикрия только для незабранных (doc/task_26). Снимок
        // массива: хук вправе отписаться во время обхода (BYE-ветка вызова).
        let eaten = false;
        for (const hook of [...this.incoming_hooks])
        {
            if (hook(raw, proto, peer)) eaten = true;
        }
        if (eaten)
        {
            // флаг m: request-line — первая строка, но $ обязан ловить конец
            // строки, а не конца всего сообщения (иначе метод всегда '').
            const req_method = /^([A-Z]+)\s+\S+\s+SIP\/2\.0$/im.exec(raw)?.[1] ?? '';
            this.peers.add(peer_str);
            this.push_event(proto, peer_str, req_method, '', '', '', 0);
            return '';
        }
        const head = parse_sip_request_head(raw);
        if (!head)
        {
            this.ignored += 1;
            this.push_event(proto, peer_str, '?', '', '', '', 0);
            return '';
        }
        this.requests_in.set(head.method, (this.requests_in.get(head.method) ?? 0) + 1);
        this.peers.add(peer_str);
        // Адрес нижестоящей станции — src её служебных обращений (keep-alive/
        // port-register/подписка); INVITE не учитываем: звонить может любой
        // терминал за станцией, а исходящий INVITE идёт на сигнальный адрес
        // самой станции (doc/task_30_plan_2.md).
        if (['REGISTER', 'OPTIONS', 'SUBSCRIBE'].includes(head.method))
            this.last_downstream = { host: peer.host, port: peer.port };
        // R-URI и CSeq в parse_sip_request_head не возвращаются (генератору не
        // нужны) — достаём отсюда же, из сырья (plan_4.md п.1, журнал).
        const ruri = (raw.split('\r\n', 1)[0] ?? '').split(' ')[1] ?? '';
        const cseq = /^cseq\s*:\s*(.*)$/im.exec(raw)?.[1]?.trim() ?? '';
        let code: number;
        let reason: string;
        let extras: string[];
        let to_tag = STATION_TO_TAG;
        if (head.method === 'OPTIONS')
        {
            code = 200;
            reason = 'OK';
            extras = OPTIONS_ANSWER_HEADERS;
            this.last_keepalive = new Date().toISOString();
        }
        else if (head.method === 'REGISTER' && this.sas_enabled)
        {
            // SAS-режим (план 6 п.1, 11.log): port-register станции
            // (R-URI sip:u00sXXpXX@наш:5060, Contact телефона с параметрами
            // ;extensions="answermode"). 405 здесь = `port-register-status
            // NOK` и гаснет SAS mode. Эхо Contact — СЫРОЙ строкой заголовка
            // запроса (parse_sip_request_head режет параметры `;…` — без них
            // пир теряет extensions); Challenge не требуем: запросы станции
            // приходят без Authorization (11.log).
            // Учёт в таблице регистраций (doc/task_33_plan_2.md): user из
            // R-URI (fallback — To) = идентификатор линии u00sXXpXX, адрес —
            // src запроса; retransmit = повторный идемпотентный record(),
            // expires=0 строку не снимает (справочник линий, не живое
            // состояние).
            const line_user =
                /^sips?:([^@:]+)@/i.exec(ruri)?.[1] ??
                /^sips?:([^@:]+)@/i.exec(head.to_uri)?.[1] ??
                '';
            this.registrations?.record(line_user, peer_str);
            const raw_contact = /^contact\s*:\s*(.*)$/im.exec(raw)?.[1]?.trim() ?? '';
            const ttl = head.expires < 0 ? REGISTER_DEFAULT_EXPIRES : head.expires;
            extras = [
                ...(raw_contact ? [`Contact: ${raw_contact}`] : []),
                `Expires: ${ttl}`,
                `User-Agent: ${STATION_USER_AGENT}`,
            ];
            code = 200;
            reason = 'OK';
        }
        else if (head.method === 'SUBSCRIBE' && this.accepts_event(head.event))
        {
            // Пассивный UAS (план 5 п.4a/4c): диалог запоминается, 200 уходит
            // СРАЗУ из этого же обработчика — без ожидания движка прогона
            // (иначе пир фиксирует cause 408 по таймерам pjsip, дамп №1).
            // To-тег диалога не меняется и при снятии (expires=0 запись
            // удаляется — тег берём из прежней, иначе pjsip не узнает диалог).
            const prior_tag = this.sub_dialogs.get(head.call_id)?.our_tag;
            extras = this.accept_subscription(head, ruri, peer);
            to_tag =
                this.sub_dialogs.get(head.call_id)?.our_tag ??
                prior_tag ??
                STATION_TO_TAG;
            code = 200;
            reason = 'OK';
        }
        else if (head.method === 'INVITE' && this.silent_invite)
        {
            // Режим «не отвечать на вызовы» (doc/task_29): вызов от
            // нижестоящей станции залипает без ответа — ни 405 (он выдаёт
            // станции живость UAS), ни 180/486. Ретрансляции того же INVITE
            // проходят этой же веткой — молчат тоже. Запрос учтён в
            // requests_in; в журнале код 0 — ответ не отправлялся.
            this.push_event(
                proto,
                peer_str,
                head.method,
                ruri,
                cseq,
                head.call_id,
                0,
                head.event,
            );
            return '';
        }
        else
        {
            // прочее — только запрет метода (plan_4.md «Объём»: UAS ни чего
            // не делает, регистрация/вызовы — следующие фазы).
            code = 405;
            reason = 'Method Not Allowed';
            extras = [`Allow: OPTIONS`, `User-Agent: ${STATION_USER_AGENT}`];
        }
        const resp = build_sip_response(code, reason, raw, extras, to_tag);
        this.answered.set(String(code), (this.answered.get(String(code)) ?? 0) + 1);
        this.push_event(
            proto,
            peer_str,
            head.method,
            ruri,
            cseq,
            head.call_id,
            code,
            head.event,
        );
        return resp;
    }

    /**
     * Пакет подписки принимается (event-list/dialog-info/dialog/presence/blf,
     * без учёта регистра — станции разные транки пишут по-разному). В
     * SAS-режиме — ЛЮБОЙ Event (план 6 п.1): имя SSW-пакета на проводе нам
     * неизвестно, а 405 убивает подписку станции (`cause 405`, 11.log).
     */
    private accepts_event(event: string): boolean
    {
        if (this.sas_enabled) return true;
        return SUBSCRIBE_EVENTS.includes(event.toLowerCase());
    }

    /**
     * Принять/обновить/снять подписку пира; вернуть доп. заголовки 200
     * (Contact станции, эхо Event, согласованный Expires). Запись диалога —
     * источник адресата/тегов для event-list NOTIFY (план 5 п.4b).
     */
    private accept_subscription(
        head: {
            call_id: string;
            event: string;
            from_uri: string;
            to_uri: string;
            from_tag: string;
            contact_uri: string;
            expires: number;
        },
        ruri: string,
        peer: { host: string; port: number },
    ): string[]
    {
        const ttl = head.expires < 0 ? SUBSCRIBE_DEFAULT_EXPIRES : head.expires;
        const host = this.config.station_host;
        const port = this.bound_port || this.config.station_port;
        // user для Contact/From: тот, на кто подписались (R-URI), иначе — из
        // To-uri запроса (u00s34p00 из дампа №2).
        const ruri_user = /^sips?:([^@:]+)@/i.exec(ruri)?.[1] ?? '';
        const user =
            (ruri_user || /^sips?:([^@:]+)@/i.exec(head.to_uri)?.[1]) ?? 'station';
        const contact = `sip:${user}@${host}:${port}`;
        if (ttl === 0)
        {
            this.sub_dialogs.delete(head.call_id);
            return [
                `Contact: <${contact}>`,
                `Event: ${head.event}`,
                'Expires: 0',
                `User-Agent: ${STATION_USER_AGENT}`,
            ];
        }
        const remote = uri_host_port(head.contact_uri, peer.port) ?? peer;
        const prev = this.sub_dialogs.get(head.call_id);
        this.sub_dialogs.set(head.call_id, {
            call_id: head.call_id,
            event: head.event,
            // From/To наших NOTIFY — зеркало подписки (п.4b).
            from_uri: head.to_uri,
            to_uri: head.from_uri,
            contact_uri: head.contact_uri,
            remote: { host: remote.host, port: remote.port },
            // наш To-тег диалога — From-tag NOTIFY (стабилен при refresh).
            our_tag: prev?.our_tag ?? `stasub-${(this.sub_tag_seq += 1)}`,
            peer_tag: head.from_tag,
            // CSeq наших NOTIFY не перенумеровываем при refresh (монотонность).
            cseq: prev?.cseq ?? 0,
            expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
        });
        return [
            `Contact: <${contact}>`,
            `Event: ${head.event}`,
            `Expires: ${ttl}`,
            `User-Agent: ${STATION_USER_AGENT}`,
        ];
    }

    /**
     * Вычистить истёкшие подписки — иначе «висящие» диалоги переживают
     * штатный refresh и генератор слал бы NOTIFY в мёртвый диалог.
     */
    private prune_subs(): void
    {
        const now = Date.now();
        for (const [call_id, sub] of this.sub_dialogs)
        {
            const exp = Date.parse(sub.expires_at);
            if (Number.isFinite(exp) && exp < now) this.sub_dialogs.delete(call_id);
        }
    }

    private push_event(
        proto: 'udp' | 'tcp',
        peer: string,
        method: string,
        ruri: string,
        cseq: string,
        call_id: string,
        code: number,
        event = '',
    ): void
    {
        this.journal_ring.push({
            ts: new Date().toISOString(),
            peer,
            proto,
            method,
            ruri,
            cseq,
            call_id,
            code,
            event,
        });
        if (this.journal_ring.length > EVENTS_BUFFER)
            this.journal_ring.splice(0, this.journal_ring.length - EVENTS_BUFFER);
    }

    // ---------- служебное ----------

    /**
     * Runtime-ошибка слушателя (после успешного start): статус stopped + текст,
     * сокеты за собой убираем; бросать не можем — события сокета асинхронны.
     */
    private on_socket_error(e: Error): void
    {
        this.error_text = e.message;
        this.close_sockets();
        this.service_state = 'stopped';
    }

    private close_sockets(): void
    {
        for (const sock of this.tcp_sockets)
        {
            sock.removeAllListeners();
            try
            {
                sock.destroy();
            }
            catch
            {
                /* noop: сокет уже мёртв */
            }
        }
        this.tcp_sockets.clear();
        const tcp = this.tcp;
        this.tcp = undefined;
        if (tcp)
        {
            tcp.removeAllListeners();
            try
            {
                tcp.close();
            }
            catch
            {
                /* noop: не слушал */
            }
        }
        const udp = this.udp;
        this.udp = undefined;
        if (udp)
        {
            udp.removeAllListeners();
            try
            {
                udp.close();
            }
            catch
            {
                /* noop: уже закрыт */
            }
        }
        this.bound_port = 0;
    }
}
