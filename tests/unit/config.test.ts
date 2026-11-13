// Юнит-тест server/config.ts: валидация конфига на подменённом process.env
// (критерий plan_2.md п.1 — тест зелёный без сети и без .env на диске).

import { describe, expect, it } from 'vitest';
import { ConfigError, load_config, type SubscriberConfig } from '../../server/config';

/** Корректное окружение по образцу .env.example. */
function valid_env(
    overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv
{
    return {
        SERVER_PORT: '3000',
        PBX_HOST: '192.168.80.157',
        PBX_PORT: '5060',
        SIP_PROTOCOL: 'udp',
        BRIDGE_HOST: '192.168.80.159',
        BRIDGE_PORT: '8090',
        SIP_NUMBER_1: '9404',
        SIP_PASS_1: '123',
        SIP_NUMBER_2: '52',
        SIP_PASS_2: '321',
        SIP_NUMBER_3: '3203',
        SIP_PASS_3: '123',
        ...overrides,
    };
}

/** Собрать ошибки ConfigError в один текст для удобных проверок. */
function problems_of(fn: () => unknown): string[]
{
    try
    {
        fn();
    }
    catch (e)
    {
        if (e instanceof ConfigError) return e.problems;
        throw e;
    }
    return [];
}

describe('load_config', () =>
{
    it('разбирает корректное окружение (образец .env.example)', () =>
    {
        const cfg = load_config(valid_env());
        expect(cfg.server_port).toBe(3000);
        expect(cfg.pbx_host).toBe('192.168.80.157');
        expect(cfg.pbx_port).toBe(5060);
        expect(cfg.sip_protocol).toBe('udp');
        expect(cfg.bridge_host).toBe('192.168.80.159');
        expect(cfg.bridge_port).toBe(8090);
        expect(cfg.subscribers.map((s) => s.number)).toEqual(['9404', '52', '3203']);
        expect(cfg.subscribers.map((s) => s.password)).toEqual(['123', '321', '123']);
    });

    it('абонент 3 (3203) — только вызываемый, не регистрируется', () =>
    {
        const cfg = load_config(valid_env());
        const [first, second, third]: [
            SubscriberConfig,
            SubscriberConfig,
            SubscriberConfig,
        ] = cfg.subscribers;
        expect(first.can_register).toBe(true);
        expect(second.can_register).toBe(true);
        expect(third.can_register).toBe(false);
    });

    it('принимает tcp и отбрасывает неизвестный протокол', () =>
    {
        expect(load_config(valid_env({ SIP_PROTOCOL: 'tcp' })).sip_protocol).toBe('tcp');
        expect(load_config(valid_env({ SIP_PROTOCOL: 'TCP' })).sip_protocol).toBe('tcp');
        expect(
            problems_of(() => load_config(valid_env({ SIP_PROTOCOL: 'sctp' }))),
        ).toContain('SIP_PROTOCOL: udp|tcp');
    });

    it.each(['0', '65536', 'abc', '', '3000.5'])('отклоняет SERVER_PORT=%s', (port) =>
    {
        expect(
            problems_of(() => load_config(valid_env({ SERVER_PORT: port }))),
        ).toContain('SERVER_PORT: целое 1–65535');
    });

    it('отклоняет некорректный PBX_PORT (тот же контроль портов)', () =>
    {
        expect(
            problems_of(() => load_config(valid_env({ PBX_PORT: '99999' }))),
        ).toContain('PBX_PORT: целое 1–65535');
    });

    it('отклоняет нечисловой номер и пустой пароль', () =>
    {
        const problems = problems_of(() =>
            load_config(valid_env({ SIP_NUMBER_2: '52a', SIP_PASS_2: '' })),
        );
        expect(problems).toContain('SIP_NUMBER_2: только цифры');
        expect(problems).toContain('SIP_PASS_2: обязателен');
    });

    it('отклоняет пустой/мусорный PBX_HOST и BRIDGE_HOST', () =>
    {
        const problems = problems_of(() =>
            load_config(valid_env({ PBX_HOST: '', BRIDGE_HOST: 'bad host!' })),
        );
        expect(problems).toContain('PBX_HOST: IP или имя хоста обязательны');
        expect(problems).toContain('BRIDGE_HOST: IP или имя хоста обязательны');
    });

    it('на пустом окружении собирает все проблемы сразу (частичного конфига нет)', () =>
    {
        const problems = problems_of(() => load_config({}));
        // 4 порта/протокола + 2 хоста + 3 номера + 3 пароля → не меньше 12.
        expect(problems.length).toBeGreaterThanOrEqual(12);
    });

    it('STATION_* необязательны: дефолты 192.168.80.159:5060 both (plan_4.md п.2)', () =>
    {
        const cfg = load_config(valid_env());
        expect(cfg.station_host).toBe('192.168.80.159');
        expect(cfg.station_port).toBe(5060);
        expect(cfg.station_proto).toBe('both');
        const over = load_config(
            valid_env({
                STATION_HOST: '127.0.0.1',
                STATION_PORT: '0',
                STATION_PROTO: 'TCP',
            }),
        );
        expect(over.station_host).toBe('127.0.0.1');
        expect(over.station_port).toBe(0); // эфемерный порт — зонд/тесты без root
        expect(over.station_proto).toBe('tcp');
    });

    it('отклоняет STATION_PORT вне 0–65535 и неизвестный STATION_PROTO', () =>
    {
        const problems = problems_of(() =>
            load_config(valid_env({ STATION_PORT: 'abc', STATION_PROTO: 'sctp' })),
        );
        expect(problems).toContain('STATION_PORT: целое 0–65535 (0 — эфемерный)');
        expect(problems).toContain('STATION_PROTO: udp|tcp|both');
    });

    it('не читает process.env при явном env (изоляция юнит-теста)', () =>
    {
        process.env.SERVER_PORT = 'не-порт';
        try
        {
            expect(load_config(valid_env()).server_port).toBe(3000);
        }
        finally
        {
            delete process.env.SERVER_PORT;
        }
    });
});
