// Единая точка чтения конфигурации: загрузка .env (dotenv) и валидация.
// Все остальные модули читают настройки ТОЛЬКО отсюда (plan_2.md §1.3).

import dotenv from 'dotenv';

/** Один виртуальный абонент из .env (SIP_NUMBER_N / SIP_PASS_N). */
export interface SubscriberConfig
{
    /** Внутренний номер на станции (SIP-URI + Digest username). */
    number: string;
    /** Digest-пароль абонента. */
    password: string;
    /**
     * Разрешена ли регистрация на станции. Абонент 3 (3203) — только цель
     * вызова в прокси-цепочке 9404→3203→52, НЕ регистрируется.
     */
    can_register: boolean;
}

/** Полная конфигурация сервера (типизированная, валидированная). */
export interface AppConfig
{
    /** HTTP-порт веб-интерфейса и REST API. */
    server_port: number;
    /** Хост/IP живой АТС. */
    pbx_host: string;
    /** Порт классического SIP на АТС. */
    pbx_port: number;
    /** Транспорт SIP: только udp или tcp (мост, режим один). */
    sip_protocol: 'udp' | 'tcp';
    /** Хост WS-моста (адрес этой машины, видимый станции). */
    bridge_host: string;
    /** Порт WS-сервера моста. */
    bridge_port: number;
    /** Виртуальные абоненты: [9404, 52, 3203] по образцу .env.example. */
    subscribers: [SubscriberConfig, SubscriberConfig, SubscriberConfig];
    /** Адрес собственного SIP-UAS «станции» (plan_4.md п.2); дефолт — эта машина. */
    station_host: string;
    /** Порт станции (5060 по умолчанию; привилегированный — см. README). */
    station_port: number;
    /** Транспорт слушателя станции: udp, tcp или оба сразу. */
    station_proto: 'udp' | 'tcp' | 'both';
}

/** Ошибка конфигурации: список всех найденных проблем (не одна наугад). */
export class ConfigError extends Error
{
    constructor(readonly problems: string[])
    {
        super(`Некорректная конфигурация: ${problems.join('; ')}`);
        this.name = 'ConfigError';
    }
}

const HOST_RE = /^[a-zA-Z0-9._-]+$/;
const NUMBER_RE = /^[0-9]+$/;

/** Порт — целое 1–65535; иначе undefined. */
function as_port(raw: string | undefined): number | undefined
{
    if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
    const n = Number(raw);
    return n >= 1 && n <= 65535 ? n : undefined;
}

/**
 * Загрузить и валидировать конфигурацию из окружения.
 * env передан явно (по умолчанию process.env) — ради юнит-тестов
 * без подмены модулей (plan_2.md, критерий п.1).
 * Бросает ConfigError со всеми проблемами сразу; частично валидный
 * конфиг не отдаётся.
 */
export function load_config(env: NodeJS.ProcessEnv = process.env): AppConfig
{
    const problems: string[] = [];

    const server_port = as_port(env.SERVER_PORT);
    if (server_port === undefined) problems.push('SERVER_PORT: целое 1–65535');

    const pbx_host = env.PBX_HOST?.trim() ?? '';
    if (!HOST_RE.test(pbx_host)) problems.push('PBX_HOST: IP или имя хоста обязательны');

    const pbx_port = as_port(env.PBX_PORT);
    if (pbx_port === undefined) problems.push('PBX_PORT: целое 1–65535');

    const sip_protocol = env.SIP_PROTOCOL?.trim().toLowerCase();
    if (sip_protocol !== 'udp' && sip_protocol !== 'tcp')
        problems.push('SIP_PROTOCOL: udp|tcp');

    const bridge_host = env.BRIDGE_HOST?.trim() ?? '';
    if (!HOST_RE.test(bridge_host))
        problems.push('BRIDGE_HOST: IP или имя хоста обязательны');

    const bridge_port = as_port(env.BRIDGE_PORT);
    if (bridge_port === undefined) problems.push('BRIDGE_PORT: целое 1–65535');

    // Станция-эмулятор (plan_4.md п.2): поля необязательны — дефолты
    // 192.168.80.159:5060 both (иначе синтетический env unit/api-тестов
    // падал бы на валидации, а станция заводится только кнопкой).
    const station_host = env.STATION_HOST?.trim() ?? '';
    if (station_host !== '' && !HOST_RE.test(station_host))
        problems.push('STATION_HOST: IP или имя хоста');
    let station_port: number | undefined;
    if (env.STATION_PORT !== undefined && env.STATION_PORT.trim() !== '')
    {
        // 0 допустим только здесь: эфемерный порт (зонды/тесты без root);
        // для SERVER_PORT/PBX_PORT такой смысл не применим.
        station_port = env.STATION_PORT.trim() === '0' ? 0 : as_port(env.STATION_PORT);
        if (station_port === undefined)
            problems.push('STATION_PORT: целое 0–65535 (0 — эфемерный)');
    }
    const station_proto_raw = env.STATION_PROTO?.trim().toLowerCase() ?? '';
    if (
        station_proto_raw !== '' &&
        station_proto_raw !== 'udp' &&
        station_proto_raw !== 'tcp' &&
        station_proto_raw !== 'both'
    )
        problems.push('STATION_PROTO: udp|tcp|both');

    // Индекс 2 (абонент 3, образец — 3203) — вызываемый, не регистрируется.
    const subscribers: SubscriberConfig[] = [];
    for (let i = 1; i <= 3; i++)
    {
        const number = env[`SIP_NUMBER_${i}`]?.trim() ?? '';
        const password = env[`SIP_PASS_${i}`] ?? '';
        if (!NUMBER_RE.test(number)) problems.push(`SIP_NUMBER_${i}: только цифры`);
        if (password === '') problems.push(`SIP_PASS_${i}: обязателен`);
        subscribers.push({ number, password, can_register: i !== 3 });
    }

    if (problems.length > 0) throw new ConfigError(problems);

    // Выше проверены все поля; ниже допустимы `!`/`as`: throw выше гарантирует,
    // что port-ы не undefined, sip_protocol — 'udp'|'tcp', а subscribers
    // содержит ровно 3 элемента (цикл i = 1..3).
    return {
        server_port: server_port!,
        pbx_host,
        pbx_port: pbx_port!,
        sip_protocol: sip_protocol as 'udp' | 'tcp',
        bridge_host,
        bridge_port: bridge_port!,
        subscribers: subscribers as [
            SubscriberConfig,
            SubscriberConfig,
            SubscriberConfig,
        ],
        station_host: station_host === '' ? '192.168.80.159' : station_host,
        station_port: station_port ?? 5060,
        station_proto:
            station_proto_raw === ''
                ? 'both'
                : (station_proto_raw as 'udp' | 'tcp' | 'both'),
    };
}

/**
 * Прочитать .env (не перетирая уже заданные переменные окружения)
 * и вернуть валидную конфигурацию. Вызывается один раз при старте.
 */
export function load_config_from_env(): AppConfig
{
    dotenv.config();
    return load_config();
}
