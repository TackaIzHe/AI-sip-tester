// Движок стимулов утечки памяти (T1–T8 из doc/los_mem/plan_test.md, запись
// doc/task_22_plan_2.md) ВНУТРИ нашей импровизированной станции (doc/task_26):
// стимул уходит через UDP-сокет станции (:5060) и с её идентичностью
// (Via/Contact = STATION_HOST) — тогда keep-alive OPTIONS живой пира приходит
// на станцию и отвечается мимикрией (doc/task_25_plan_2.md), её SUBSCRIBE
// принимает пассивный UAS самой станции (план 5 п.4a: 200 сразу, диалог в
// subscriptions()), а NOTIFY уходят строго в эти диалоги — единственный
// вход в blf_on_rx_notify/ss_on_rx_notify (res.md, sub_on_rx_notify_uac).
//
// Контракты:
// - один стимул за раз; запуск только на работающей станции (сокет нужен);
// - сценарии — LOS_SCENARIOS без правок тела: транспорт внедряется через
//   ScenarioCtx.make_client (внешний сокет станции), Via/Contact — через
//   via_host = station_host; дефолты прогона — LOS_QUICK_OPTS (~1 мин);
// - хук входящих станции (add_incoming_hook): всё пьём себе (feed), забираем
//   у станции только ответы на свои запросы; SUBSCRIBE/OPTIONS остаются
//   станции (её пассивный UAS и мимикрия) — двойных ответов нет;
// - CSV-журнал фаз — reports/los_<t>_<UTC>.csv, тот же формат, что у CLI и
//   кейсов реестра (plan_test.md §2.2); вердикта нет (решение оператора,
//   doc/task_22_plan_2.md) — успех = «стимул сгенерирован, сводка получена»;
// - TCP (sip_protocol=tcp или станция без UDP) — обычный клиент к PBX с
//   эфемерного порта, честно помечается в логе.
// related: server/station/station.ts (IncomingHook, udp_socket),
// server/los_mem/scenarios.ts (LOS_SCENARIOS, make_client, LOS_QUICK_OPTS),
// server/los_mem/raw_sip.ts (внешний udp_socket, feed), server/controllers/
// station_controller.ts, doc/task_22_plan_2.md, doc/task_26_plan_2.md.

import path from 'node:path';
import type { AppConfig } from '../config';
import { utc_stamp } from '../journal';
import { CsvLog } from '../los_mem/csv_log';
import { RawSipClient } from '../los_mem/raw_sip';
import {
    BASE_SCENARIO_OPTS,
    LOS_QUICK_OPTS,
    LOS_SCENARIOS,
    type ScenarioCtx,
    type ScenarioOpts,
} from '../los_mem/scenarios';
import type { IncomingHook, SipStation } from './station';

/** Строка списка стимулов для select-а на странице. */
export interface StimulusCaseInfo
{
    id: string;
    title: string;
}

/** Снимок прогона (GET /api/station/stimulus). */
export interface StimulusStatus
{
    state: 'idle' | 'running' | 'stopping';
    /** id последнего/текущего прогона; '' — ни одного не было. */
    id: string;
    /** ISO-время старта текущего прогона; '' — не запущен. */
    started_at: string;
    /** Секунды с старта текущего прогона. */
    uptime_s: number;
    /** Последние строки лога (фазы, старт, итог), newest first. */
    log: string[];
    /** Сводка завершённого прогона (хранится до следующего старта). */
    summary: string;
    /** Ошибка завершённого прогона ('' — чисто). */
    error: string;
    /** Путь CSV-журнала текущего/последнего прогона. */
    csv: string;
}

/**
 * DI-контракт движка для контроллера/страницы (мокируется в api-тестах,
 * по образцу Station п.4.2).
 */
export interface StationStimulusApi
{
    /** Доступные стимулы (id + заголовок из реестра). */
    cases(): StimulusCaseInfo[];
    /** Снимок прогона; только чтение. */
    status(): StimulusStatus;
    /**
     * Запустить короткий прогон id ('t1'..'t8') фоном. Бросает Error с русским
     * текстом: неизвестный id / уже выполняется / станция остановлена —
     * контроллер кодирует в 400/409.
     */
    start(id: string): void;
    /** Досрочная остановка (graceful-зачистка сценария); ожидание финала. */
    stop(): Promise<void>;
}

/** Ёмкость ring-лога прогона (страница берёт первые ~80). */
const LOG_RING = 200;

/**
 * Движок стимулов при станции: прогоняет LOS_SCENARIOS поверх сокета станции,
 * ведёт ring-лог, CSV и состояние для REST/вкладки «Станция».
 */
export class StationStimulus implements StationStimulusApi
{
    private run_state: StimulusStatus['state'] = 'idle';
    private current_id = '';
    private started_at = 0;
    /** newest first (unshift). */
    private readonly log_ring: string[] = [];
    private summary_text = '';
    private error_text = '';
    private csv: CsvLog | undefined;
    private readonly clients = new Set<RawSipClient>();
    private stopped_flag = false;
    /** Дизпоузер хука входящих (навешан в start, снимается в cleanup). */
    private off_hook: (() => void) | undefined;
    /** Промис фонового прогона (для await в stop()). */
    private run_done: Promise<void> | undefined;
    /** Путь CSV прошлого прогона — статус отдаёт его и в idle. */
    private last_csv = '';

    constructor(
        private readonly config: AppConfig,
        private readonly station: SipStation,
    )
    {}

    /**
     * Список стимулов реестра (id + заголовок, порядок LOS_SCENARIOS).
     */
    cases(): StimulusCaseInfo[]
    {
        return Object.entries(LOS_SCENARIOS).map(([id, def]) => ({
            id,
            title: def.title,
        }));
    }

    /**
     * Снимок прогона (контракт StationStimulusApi).
     */
    status(): StimulusStatus
    {
        const running = this.run_state !== 'idle';
        return {
            state: this.run_state,
            id: this.current_id,
            started_at: running ? new Date(this.started_at).toISOString() : '',
            uptime_s: running ? Math.round((Date.now() - this.started_at) / 1000) : 0,
            log: this.log_ring.slice(0, 80),
            summary: this.summary_text,
            error: this.error_text,
            csv: this.csv?.file_path ?? this.last_csv,
        };
    }

    /**
     * Запуск короткого прогона фоном (грабли: сокет станции занят только на
     * время прогона; повторный старт — ошибка, станция обязана быть running).
     */
    start(id: string): void
    {
        const def = LOS_SCENARIOS[id];
        if (!def) throw new Error(`Неизвестный стимул «${id}» (ждутся t1..t8)`);
        if (this.run_state !== 'idle')
        {
            throw new Error(`Стимул «${this.current_id}» уже выполняется`);
        }
        if (this.station.status().state !== 'running')
        {
            throw new Error('Станция остановлена — стимул идёт через её сокет');
        }
        const sock = this.station.udp_socket();
        // UDP: клиент поверх станционного сокета (:5060); иначе — обычный
        // TCP-клиент к PBX (эфемерный src; keep-alive пира при этом живёт на
        // слушателе станции, стимул — отдельно).
        const via_station = this.config.sip_protocol !== 'tcp' && sock !== undefined;
        const target = { host: this.config.pbx_host, port: this.config.pbx_port };
        const make_client = async (): Promise<RawSipClient> =>
        {
            const client =
                via_station && sock
                    ? new RawSipClient({
                          host: target.host,
                          port: target.port,
                          proto: 'udp',
                          udp_socket: sock,
                      })
                    : new RawSipClient({
                          host: target.host,
                          port: target.port,
                          proto: 'tcp',
                      });
            await client.connect();
            this.clients.add(client);
            return client;
        };
        // Хук входящих станции: всё пьём своим клиентам (ответы на свои
        // запросы приходят на станционный сокет); забираем у станции только
        // ответы — мимикрия их трогать не должна. SUBSCRIBE НЕ забираем:
        // пассивный UAS живёт в самой станции (план 5 п.4a) — 200 уходит
        // сразу, диалог попадает в subscriptions() (из него строятся NOTIFY,
        // п.4b); двойных ответов нет — наши клиенты UAS не отвечают.
        const hook: IncomingHook = (raw, proto, peer) =>
        {
            if (!via_station || proto !== 'udp') return false;
            for (const c of this.clients) c.feed(raw, peer);
            return /^SIP\/2\.0\s/i.test(raw); // только ответы на наши запросы
        };
        const opts: ScenarioOpts = {
            ...BASE_SCENARIO_OPTS,
            ...def.defaults,
            ...(LOS_QUICK_OPTS[id] ?? {}),
        };
        const reports_dir = path.resolve('reports');
        const csv = new CsvLog(
            path.join(reports_dir, `los_${id}_${utc_stamp(Date.now())}.csv`),
            id,
        );
        const line = (text: string): void =>
        {
            this.log_ring.unshift(`[${new Date().toISOString()}] ${text}`);
            if (this.log_ring.length > LOG_RING) this.log_ring.length = LOG_RING;
        };
        const ctx: ScenarioCtx = {
            config: this.config,
            target,
            // идентичность станции в Via/Contact: Contact = sip:номер@станция:
            // 5060 — keep-alive пира по нему возвращается на станцию
            // (грабль task_25 с эфемерными Contact).
            via_host: this.config.station_host,
            reports_dir,
            opts,
            log: line,
            phase: (name) =>
            {
                line(`фаза: ${name}`);
                csv.row('phase', name);
            },
            tick: (sent) => csv.row('tick', String(sent)),
            stopped: () => this.stopped_flag,
            make_client,
            // Принятые станцией подписки — источник диалогов для NOTIFY
            // (план 5 п.4a/4b): CSeq диалогов ведёт станция, монотонно.
            station_subs: {
                list: () => this.station.subscriptions(),
                take_cseq: (call_id) => this.station.take_notify_cseq(call_id),
            },
            // Сырой журнал отправленных NOTIFY в CSV (план 5 п.2): адресат,
            // Call-ID/CSeq/теги — сшивка с трассой станции по времени строки.
            log_raw: (text) => csv.row('notify', text),
        };
        this.off_hook = this.station.add_incoming_hook(hook);
        this.csv = csv;
        this.current_id = id;
        this.started_at = Date.now();
        this.stopped_flag = false;
        this.summary_text = '';
        this.error_text = '';
        this.run_state = 'running';
        line(
            `стимул ${id}: цель ${target.host}:${target.port}, ` +
                (via_station
                    ? `от адреса станции ${this.config.station_host}:` +
                      `${this.station.status().port}`
                    : 'TCP-клиент от эфемерного порта (UDP-сокета станции нет)'),
        );
        this.run_done = def
            .run(ctx)
            .then((summary) =>
            {
                csv.row('summary', summary);
                this.summary_text = summary;
                line(`итог: ${summary}`);
            })
            .catch((e: unknown) =>
            {
                this.error_text = e instanceof Error ? e.message : String(e);
                line(`ошибка: ${this.error_text}`);
            })
            .finally(() =>
            {
                this.cleanup();
            });
    }

    /**
     * Досрочная остановка: флаг stopped (сценарии замечают его за ≤500 мс и
     * делают зачистку — unsubscribe/unreg), ожидание финала прогона.
     */
    async stop(): Promise<void>
    {
        if (this.run_state === 'idle')
        {
            throw new Error('Стимул не выполняется');
        }
        this.stopped_flag = true;
        this.run_state = 'stopping';
        await this.run_done;
    }

    // ---------- внутреннее ----------

    /**
     * Снять хук, закрыть клиентов (внешний сокет станции close() не трогает)
     * и CSV; состояние idle — сводка/ошибка/путь CSV остаются в статусе.
     */
    private cleanup(): void
    {
        this.off_hook?.();
        this.off_hook = undefined;
        for (const c of this.clients) c.close();
        this.clients.clear();
        this.csv?.close();
        this.last_csv = this.csv?.file_path ?? this.last_csv;
        this.csv = undefined;
        this.run_state = 'idle';
    }
}
