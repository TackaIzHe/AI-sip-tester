// Движок SAS-режима станции (план 6 п.2, дамп doc/los_mem/new_log/11.log):
// роль SAS/SSW-сервера, которую станция `.157` ищет на нашем :5060 — при
// регистрации линии с SAS=наш адрес она шлёт нам port-register REGISTER
// (R-URI sip:u00sXXpXX@наш) и SUBSCRIBE SSW-пакета (expires 7200); наш
// пассивный UAS (station.ts, SAS-флаг) их принимает — этот движок по
// принятой подписке шлёт инициативные NOTIFY с телом SSInfo (первый сразу,
// далее периодические) строго в диалог подписки (Contact пира = адресат,
// план 5 п.4b). Единственный путь к `ss_info.c : ss_on_rx_notify()` (кейс B):
// NOTIFY вне принятой UAC-подписки станции = 500 «Unknown method» + fail2ban
// (doc/los_mem/act_log_2.157.log).
//
// Контракты:
// - включение только на работающей станции (NOTIFY уходят через её UDP-сокет,
//   своего bind нет); повторное включение/выключение — Error с русским
//   текстом (контроллер кодирует 409); выключение таймер гасит, диалоги
//   станции не трогает (SSW снимает свою подписку сам);
// - пересечение с прогоном стимула запрещено контроллером (409): общий
//   сокет и хук входящих (add_incoming_hook здесь ест только ответы —
//   запросы остаются станции, SAS-приём не ломается); с исходящим вызовом
//   режим совместим (doc/task_31_plan_2.md): хуки мультикастятся, ответы на
//   NOTIFY забираем мы, ответы INVITE — движок вызова;
// - Content-Type SSInfo NOTIFY — application/ss-info+xml (доводка по
//   дампу 12.log); формат тела на проводе неизвестен (внутренний разбор —
//   ipc.c `# SSInfo: '<сервис>' ACTIVE, params N`, doc/los_mem/new_log/
//   10.log): тело — константа модуля, доводится итеративно по обратной
//   связи станции `bad property: … allowed 32` (план 6 п.5);
// - триггеры кейса B (name len 33, value len 137 из res.md/pbx_sip.1.log)
//   в теле по умолчанию — «плохие свойства» и есть цель прогона.
// related: server/station/station.ts (sas_mode, subscriptions,
// take_notify_cseq, udp_socket, IncomingHook), server/los_mem/raw_sip.ts
// (build_sip_request, parse_sip_response), server/los_mem/bodies.ts
// (padded_name/padded_value — байтовые копии триггеров res.md),
// server/controllers/station_controller.ts, doc/plan_6.md,
// doc/task_28_plan_2.md.

import type { Socket } from 'node:dgram';
import type { AppConfig } from '../config';
import { padded_name, padded_value, SSINFO_CONTENT_TYPE } from '../los_mem/bodies';
import {
    build_sip_request,
    parse_sip_response,
    subscription_state_value,
} from '../los_mem/raw_sip';
import type { SipStation, StationSubscription } from './station';
import type { IncomingHook } from './station';

/**
 * Подписка-SAS в статусе (для REST/вкладки): адресат и прогресс NOTIFY.
 */
export interface SasSubscriptionStatus
{
    call_id: string;
    /** Пакет из её SUBSCRIBE (имя SSW-пакета на проводе — план 6 п.1). */
    event: string;
    /** Номер абонента из R-URI/From подписки (u00sXXpXX). */
    number: string;
    remote: { host: string; port: number };
    expires_at: string;
    /** Отправлено наших NOTIFY в этот диалог. */
    sent: number;
    /** ISO-время последнего NOTIFY; '' — ещё не слался. */
    last_notify_at: string;
    /** Код последнего ответа на NOTIFY ('' — ответа не было). */
    last_response: string;
}

/**
 * Снимок SAS-режима (GET /api/station/sas).
 */
export interface SasStatus
{
    state: 'off' | 'on';
    /** ISO-время включения; '' — не включался (текущий цикл выключен). */
    enabled_at: string;
    subs: SasSubscriptionStatus[];
    /** Всего NOTIFY отправлено за текущий цикл включения. */
    sent: number;
    /** Ответы на NOTIFY по коду (`{'200': 4, '500': 1}`). */
    answered: { [code_name: string]: number };
    /** Последние строки сырого журнала (newest first). */
    log: string[];
}

/**
 * DI-контракт движка для контроллера/страницы (мокируется в api-тестах,
 * по образцу StationStimulusApi).
 */
export interface StationSasApi
{
    /** Снимок режима; только чтение. */
    status(): SasStatus;
    /**
     * Включить: SAS-флаг станции + приём подписок + периодические NOTIFY.
     * Бросает Error с русским текстом: уже включено / станция остановлена —
     * контроллер кодирует в 409/400.
     */
    enable(): void;
    /**
     * Выключить (таймер и хук ответов снимаются, диалоги станции живут
     * дальше). Бросает Error — уже выключено.
     */
    disable(): void;
}

/** Период скана подписок станции (первый NOTIFY — до таймеров pjsip). */
const SAS_POLL_MS = 2000;

/** Интервал периодических NOTIFY (порядок SSW keep-alive, план 6 п.2). */
const SAS_NOTIFY_INTERVAL_MS = 30000;

/** Ёмкость ring-лога сырых NOTIFY (страница берёт первые ~80). */
const LOG_RING = 200;

/** User-Agent наших NOTIFY — НЕ мимикрия станции: мы здесь notifier. */
const SAS_USER_AGENT = 'sas-emul/1.0';

/**
 * SSInfo-триггеры кейса B (res.md, pbx_sip.1.log 2026-08-19): имя 33 симв.,
 * value 137 симв. — JSON с `&quot;` (prefix 67805/67031/67215 из дампа).
 */
const SSINFO_BAD_PREFIXES = [67805, 67031, 67215];

// Content-Type SSInfo NOTIFY — SSINFO_CONTENT_TYPE (bodies.ts):
// application/ss-info+xml, пакет SSW_SRVM (доводка по дампу 12.log, план 6
// п.5; с simple-list+xml станция тело SSInfo не разбирала).

/**
 * Тело SSInfo (первое приближение, план 6 п.2): «хорошие» услуги из
 * разбора станции (10.log: teleconference/count, ml/line_count,
 * ml/line_count_out — в лимит 32 укладываются) + три «плохих» свойства
 * кейса B (33/137) — маркер входа в ss_on_rx_notify.
 */
function ssinfo_body(): string
{
    const item = (name: string, value: string): string =>
        `  <item>\r\n` +
        `    <name>${name}</name>\r\n` +
        `    <value>${value}</value>\r\n` +
        `  </item>\r\n`;
    const good = [
        item('teleconference.count', '0'),
        item('ml.line_count', '3'),
        item('ml.line_count_out', '-1'),
    ];
    const bad = SSINFO_BAD_PREFIXES.map((prefix) =>
        item(padded_name(0, 33), padded_value(String(prefix), 137)),
    );
    return (
        `<?xml version="1.0" encoding="UTF-8"?>\r\n` +
        `<simple-list xmlns="urn:ietf:params:xml:ns:simple-list" version="0">\r\n` +
        good.join('') +
        bad.join('') +
        `</simple-list>`
    );
}

/** Учёт одного диалога подписки между тиками. */
interface SasTrack
{
    sent: number;
    last_sent: number;
    /** Новый диалог — NOTIFY обязан уйти немедленно (до таймеров pjsip). */
    awaiting_first: boolean;
    last_response: string;
}

/**
 * Движок SAS: следит за подписками, принятыми станцией в SAS-режиме, и
 * шлёт в них периодические SSInfo NOTIFY через UDP-сокет станции.
 */
export class StationSas implements StationSasApi
{
    private on = false;
    private enabled_at = 0;
    private timer: NodeJS.Timeout | undefined;
    /** Диалог (Call-ID) → учёт NOTIFY; baseline-диалоги на enable не ждём. */
    private readonly tracked = new Map<string, SasTrack>();
    private total_sent = 0;
    /** Дизпоузер хука ответов (навешан в enable, снимается в disable). */
    private off_hook: (() => void) | undefined;
    private readonly answered = new Map<string, number>();
    /** newest first (unshift). */
    private readonly log_ring: string[] = [];

    constructor(
        private readonly config: AppConfig,
        private readonly station: SipStation,
    )
    {}

    /**
     * Снимок режима (контракт StationSasApi): живой список подписок станции
     * плюс учёт NOTIFY из tracked.
     */
    status(): SasStatus
    {
        const subs: SasSubscriptionStatus[] = this.station.subscriptions().map((s) =>
        {
            const st = this.tracked.get(s.call_id);
            return {
                call_id: s.call_id,
                event: s.event,
                number: /^sips?:([^@:]+)@/i.exec(s.from_uri)?.[1] ?? '',
                remote: s.remote,
                expires_at: s.expires_at,
                sent: st?.sent ?? 0,
                last_notify_at:
                    st && st.last_sent > 0 ? new Date(st.last_sent).toISOString() : '',
                last_response: st?.last_response ?? '',
            };
        });
        return {
            state: this.on ? 'on' : 'off',
            enabled_at: this.on ? new Date(this.enabled_at).toISOString() : '',
            subs,
            sent: this.total_sent,
            answered: Object.fromEntries(this.answered),
            log: this.log_ring.slice(0, 80),
        };
    }

    /**
     * Включить режим (контракт StationSasApi). Идемпотентность по состоянию:
     * повторное включение и включение на остановленной станции — ошибка.
     */
    enable(): void
    {
        if (this.on) throw new Error('SAS-режим уже включён');
        if (this.station.status().state !== 'running')
        {
            throw new Error('Станция остановлена — SAS-NOTIFY идут через её сокет');
        }
        this.on = true;
        this.enabled_at = Date.now();
        this.total_sent = 0;
        this.answered.clear();
        this.tracked.clear();
        // baseline: подписки, принятые до включения, своих NOTIFY не ждут —
        // шлём только в новые (или после refresh: диалог пересоздаётся).
        for (const sub of this.station.subscriptions())
        {
            this.tracked.set(sub.call_id, {
                sent: 0,
                last_sent: 0,
                awaiting_first: false,
                last_response: '',
            });
        }
        this.station.set_sas_mode(true);
        this.off_hook = this.station.add_incoming_hook((raw, _proto, _peer) =>
            this.on_response(raw),
        );
        this.timer = setInterval(() =>
        {
            this.tick();
        }, SAS_POLL_MS);
        this.timer.unref();
        const line = this.station.udp_socket()
            ? 'SAS-режим включён: REGISTER→200, SUBSCRIBE любого Event→200'
            : 'SAS-режим включён (UDP-сокета нет — NOTIFY доставляться не будут)';
        this.log(line);
    }

    /**
     * Выключить режим: таймер и хук ответов снимаются, SAS-флаг станции
     * гаснет (мимикрия 405 восстанавливается), диалоги не трогаем.
     */
    disable(): void
    {
        if (!this.on) throw new Error('SAS-режим уже выключен');
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        this.on = false;
        this.off_hook?.();
        this.off_hook = undefined;
        this.station.set_sas_mode(false);
        this.log('SAS-режим выключён');
    }

    // ---------- внутреннее ----------

    /**
     * Хук входящих станции: забираем только SIP-ответы (наши NOTIFY); запросы
     * возвращаем станции — SAS-приём REGISTER/SUBSCRIBE живёт в ней.
     */
    private on_response(raw: string): boolean
    {
        if (!/^SIP\/2\.0\s/i.test(raw)) return false;
        const head = parse_sip_response(raw);
        if (head && head.cseq_method === 'NOTIFY')
        {
            const code = String(head.status);
            this.answered.set(code, (this.answered.get(code) ?? 0) + 1);
            const st = this.tracked.get(head.call_id);
            if (st) st.last_response = code;
            this.log(`NOTIFY ← ответ ${code} (CID ${head.call_id})`);
        }
        return true;
    }

    /** Виток таймера: новые/периодические NOTIFY по живым подпискам. */
    private tick(): void
    {
        if (!this.on) return;
        const sock = this.station.udp_socket();
        if (!sock) return; // станция легла — ждём, NOTIFY некому слать
        const live = this.station.subscriptions();
        const live_ids = new Set(live.map((s) => s.call_id));
        for (const call_id of [...this.tracked.keys()])
        {
            if (!live_ids.has(call_id)) this.tracked.delete(call_id);
        }
        for (const sub of live)
        {
            let st = this.tracked.get(sub.call_id);
            if (!st)
            {
                st = { sent: 0, last_sent: 0, awaiting_first: true, last_response: '' };
                this.tracked.set(sub.call_id, st);
            }
            const due =
                st.awaiting_first || Date.now() - st.last_sent >= SAS_NOTIFY_INTERVAL_MS;
            if (due) this.send_notify(sub, st, sock);
        }
    }

    /**
     * Один NOTIFY в диалог подписки: адресат/теги — строго из записи
     * принятой подписки (план 5 п.4b), CSeq монотонен (take_notify_cseq).
     */
    private send_notify(sub: StationSubscription, st: SasTrack, sock: Socket): void
    {
        const cseq = this.station.take_notify_cseq(sub.call_id);
        if (cseq === undefined)
        {
            this.tracked.delete(sub.call_id);
            return;
        }
        // user notifier'а = номер из подписки (From наших NOTIFY — её To).
        const user = /^sips?:([^@:]+)@/i.exec(sub.from_uri)?.[1] ?? 'sas';
        const port = this.station.status().port;
        const body = ssinfo_body();
        const msg = build_sip_request('NOTIFY', {
            ruri: sub.contact_uri || `sip:${user}@${sub.remote.host}:${sub.remote.port}`,
            from_uri: sub.from_uri,
            to_uri: sub.to_uri,
            call_id: sub.call_id,
            cseq,
            from_tag: sub.our_tag,
            to_tag: sub.peer_tag,
            contact: `sip:${user}@${this.config.station_host}:${port}`,
            via_host: this.config.station_host,
            content_type: SSINFO_CONTENT_TYPE,
            body,
            // Subscription-State обязателен в NOTIFY (RFC 3265 §4.1.4):
            // без него pjsip-evsub станции отвечает 400 и через 5 с
            // отписывается (UAC_WAIT_NOTIFY, дамп 12.log) — до
            // ss_on_rx_notify сообщение не доходит.
            extra_headers: [
                ...(sub.event ? [`Event: ${sub.event}`] : []),
                `Subscription-State: ${subscription_state_value(sub.expires_at)}`,
            ],
            user_agent: SAS_USER_AGENT,
        });
        sock.send(Buffer.from(msg, 'utf8'), sub.remote.port, sub.remote.host);
        st.sent += 1;
        st.last_sent = Date.now();
        st.awaiting_first = false;
        this.total_sent += 1;
        this.log(
            `NOTIFY → ${sub.remote.host}:${sub.remote.port} cseq=${cseq} ` +
                `CID=${sub.call_id} tags=${sub.our_tag}/${sub.peer_tag} ` +
                `Event=${sub.event} CT=${SSINFO_CONTENT_TYPE} ` +
                `body=${Buffer.byteLength(body, 'utf8')}`,
        );
    }

    private log(text: string): void
    {
        this.log_ring.unshift(`[${new Date().toISOString()}] ${text}`);
        if (this.log_ring.length > LOG_RING) this.log_ring.length = LOG_RING;
    }
}
