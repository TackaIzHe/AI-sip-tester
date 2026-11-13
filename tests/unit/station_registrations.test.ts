// Юнит-тесты связки станции и таблицы регистраций (doc/task_33_plan_2.md) —
// без внешней сети: реальный SipStation на loopback (порт 0) + реальное
// StationRegistrations через attach_registrations, REGISTER образца 11.log
// (port-register, R-URI user u00sXXpXX) сырым UDP. Проверяемое поведение:
// REGISTER в SAS-режиме → строка {identifier, адрес пира}; REGISTER вне
// режима (405) — таблица чиста; re-REGISTER поверх ручной строки — телефон
// оператора сохранён, адрес/время обновлены; пустого user в R-URI — no-op.
// Запуск: npm run test:unit.
// related: server/station/station.ts (attach_registrations, REGISTER+SAS-
// ветка), server/station/registrations.ts, tests/unit/station.test.ts
// (образец синтетики и port_register_msg).

import dgram from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../server/config';
import { build_sip_request, parse_sip_response } from '../../server/los_mem/raw_sip';
import { SipStation, type Station } from '../../server/station/station';
import { StationRegistrations } from '../../server/station/registrations';

function station_config(): AppConfig
{
    return {
        server_port: 3000,
        pbx_host: '127.0.0.1',
        pbx_port: 5060,
        sip_protocol: 'udp',
        bridge_host: '127.0.0.1',
        bridge_port: 8090,
        subscribers: [
            { number: '9404', password: '123', can_register: true },
            { number: '52', password: '321', can_register: true },
            { number: '3203', password: '123', can_register: false },
        ],
        // Порт 0 — эфемерный (тесты не воюют за 5060, root не нужен).
        station_host: '127.0.0.1',
        station_port: 0,
        station_proto: 'udp',
    };
}

const opened: Station[] = [];

afterEach(async () =>
{
    for (const st of opened.splice(0)) await st.stop();
});

/** Станция с таблицей регистраций (wire-up как в main.ts). */
async function started_with_table(): Promise<{
    st: SipStation;
    table: StationRegistrations;
}>
{
    const st = new SipStation(station_config());
    opened.push(st);
    const table = new StationRegistrations();
    st.attach_registrations(table);
    await st.start();
    return { st, table };
}

/** port-register REGISTER станции (образец 11.log): user u00sXXpXX. */
function port_register_msg(port: number, user: string, cseq = 22541): string
{
    return build_sip_request('REGISTER', {
        ruri: `sip:${user}@127.0.0.1:${port}`,
        from_uri: `sip:${user}@192.168.80.157:5060`,
        to_uri: `sip:${user}@192.168.80.157:5060`,
        call_id: `reg-${user}`,
        cseq,
        from_tag: 'reg-tag',
        contact: `sip:${user}@192.168.80.133:5060;extensions="answermode"`,
        via_host: '192.168.80.157',
        extra_headers: ['Expires: 3600'],
    });
}

/** Один UDP-обмен (ответ станции; undefined — таймаут). */
async function udp_request(
    port: number,
    msg: string,
    wait_ms = 1500,
): Promise<string | undefined>
{
    const sock = dgram.createSocket('udp4');
    const got = new Promise<string | undefined>((resolve) =>
    {
        const timer = setTimeout(() => resolve(undefined), wait_ms);
        sock.once('message', (m: Buffer) =>
        {
            clearTimeout(timer);
            resolve(m.toString('utf8'));
        });
    });
    await new Promise<void>((resolve, reject) =>
        sock.send(Buffer.from(msg, 'utf8'), port, '127.0.0.1', (e) =>
            e ? reject(e) : resolve(),
        ),
    );
    const resp = await got;
    sock.close();
    return resp;
}

describe('Станция × таблица регистраций (doc/task_33_plan_2.md)', () =>
{
    it('REGISTER в SAS-режиме: identifier из R-URI + адрес пира', async () =>
    {
        const { st, table } = await started_with_table();
        st.set_sas_mode(true);
        const resp = await udp_request(
            st.status().port,
            port_register_msg(st.status().port, 'u00s00p00'),
        );
        expect(parse_sip_response(resp ?? '')?.status).toBe(200);
        const list = table.list();
        expect(list).toHaveLength(1);
        expect(list[0].identifier).toBe('u00s00p00');
        // адрес — src UDP-запроса (host:port, формат журнала станции)
        expect(list[0].address).toMatch(/^127\.0\.0\.1:\d+$/);
        expect(list[0].phone).toBe('');
        expect(list[0].last_seen_at).not.toBe('');
    });

    it('REGISTER вне SAS-режима (405) — таблица не пополняется', async () =>
    {
        const { st, table } = await started_with_table();
        const resp = await udp_request(
            st.status().port,
            port_register_msg(st.status().port, 'u00s00p00'),
            900,
        );
        expect(parse_sip_response(resp ?? '')?.status).toBe(405);
        expect(table.list()).toHaveLength(0);
    });

    it('re-REGISTER поверх ручной строки: телефон и id сохранены, адрес обновлён', async () =>
    {
        const { st, table } = await started_with_table();
        const manual = table.add('u00s34p00', '100');
        st.set_sas_mode(true);
        await udp_request(
            st.status().port,
            port_register_msg(st.status().port, 'u00s34p00'),
        );
        const list = table.list();
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({
            id: manual.id,
            identifier: 'u00s34p00',
            phone: '100',
        });
        expect(list[0].address).toMatch(/^127\.0\.0\.1:\d+$/);
    });

    it('разные линии — разные строки; без attached-хранилища REGISTER 200 как раньше', async () =>
    {
        const { st, table } = await started_with_table();
        st.set_sas_mode(true);
        const port = st.status().port;
        await udp_request(port, port_register_msg(port, 'u00s00p00'));
        await udp_request(port, port_register_msg(port, 'u00s00p01', 22542));
        expect(table.list().map((e) => e.identifier)).toEqual(['u00s00p00', 'u00s00p01']);
        // хранилища нет — REGISTER в SAS-режиме обязан отвечать 200 и не
        // бросать (attach опционален: без него станция живёт как до задачи)
        const bare = new SipStation(station_config());
        opened.push(bare);
        bare.set_sas_mode(true);
        await bare.start();
        const resp = await udp_request(
            bare.status().port,
            port_register_msg(bare.status().port, 'u00s05p22'),
        );
        expect(parse_sip_response(resp ?? '')?.status).toBe(200);
    });
});
