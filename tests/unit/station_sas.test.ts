// Юнит-тесты SAS-движка (server/station/sas.ts, план 6 п.4) — без внешней
// сети: реальная SipStation на loopback (порт 0) + «пир»-сокет, играющий
// станцию `.157`: SUBSCRIBE неизвестного SSW-пакета с Contact на свой порт →
// SAS-режим его принимает, движок шлёт первый NOTIFY в диалог (адресат —
// Contact, теги/CSeq из подписки, тело — simple-list с триггерами кейса B
// 33/137), ответ пира учитывается в статусе. Проверки: ошибки enable/disable,
// SAS-флаг станции и его снятие, хук ответов (response не попадает в ignored,
// после disable — попадает). Запуск: npm run test:unit.
// related: server/station/sas.ts, server/station/station.ts (SAS-флаг),
// tests/unit/station.test.ts (образец UDP-синтетики), doc/los_mem/new_log/11.log.

import dgram from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../server/config';
import {
    build_sip_request,
    build_sip_response,
    parse_sip_request_head,
    parse_sip_response,
} from '../../server/los_mem/raw_sip';
import { StationSas } from '../../server/station/sas';
import { SipStation } from '../../server/station/station';

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
        station_host: '127.0.0.1',
        station_port: 0,
        station_proto: 'udp',
    };
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () =>
{
    for (const f of cleanup.splice(0)) await f();
});

async function wait_until(pred: () => boolean, timeout_ms: number): Promise<boolean>
{
    const deadline = Date.now() + timeout_ms;
    while (Date.now() < deadline)
    {
        if (pred()) return true;
        await new Promise((r) => setTimeout(r, 50));
    }
    return pred();
}

describe('StationSas: включение/выключение', () =>
{
    it('на остановленной станции — ошибка; повторные enable/disable — ошибки', async () =>
    {
        const st = new SipStation(station_config());
        const sas = new StationSas(station_config(), st);
        expect(() => sas.enable()).toThrowError(/Станция остановлена/);
        await st.start();
        cleanup.push(async () =>
        {
            if (sas.status().state === 'on') sas.disable();
            await st.stop();
        });
        expect(sas.status().state).toBe('off');
        sas.enable();
        expect(sas.status().state).toBe('on');
        expect(st.sas_mode()).toBe(true);
        expect(() => sas.enable()).toThrowError(/уже включён/);
        sas.disable();
        expect(sas.status().state).toBe('off');
        expect(st.sas_mode()).toBe(false);
        expect(() => sas.disable()).toThrowError(/уже выключен/);
    });

    it('хук ответов: после disable ответы станции снова «мусор» в счётчиках', async () =>
    {
        const st = new SipStation(station_config());
        await st.start();
        cleanup.push(async () =>
        {
            if (sas.status().state === 'on') sas.disable();
            await st.stop();
        });
        const sas = new StationSas(station_config(), st);
        sas.enable();
        // ответ ни на что — SAS-хук его съедает (станция не считает мусором)…
        const resp = build_sip_response(200, 'OK', request_stub());
        await udp_send(st.status().port, resp);
        await wait_until(
            () => sas.status().log.some((l) => l.includes('NOTIFY ←')),
            2000,
        );
        expect(st.status().counters.ignored ?? 0).toBe(0);
        // …после выключения хук снят — ответчата станция видит не-запрос.
        sas.disable();
        await udp_send(st.status().port, resp);
        await wait_until(() => (st.status().counters.ignored ?? 0) === 1, 2000);
        expect(st.status().counters.ignored).toBe(1);
    });
});

describe('StationSas: NOTIFY в принятую SAS-подписку (e2e на loopback)', () =>
{
    it('первый NOTIFY — в Contact подписки, теги/CSeq/тело — по образцу 10.log', async () =>
    {
        const st = new SipStation(station_config());
        await st.start();
        const sas = new StationSas(station_config(), st);
        cleanup.push(async () =>
        {
            if (sas.status().state === 'on') sas.disable();
            await st.stop();
        });
        sas.enable();
        // «Станция-пир»: свой сокет, Contact подписки — на него же (как
        // sip:u00sXXpXX@192.168.80.133:5060 в 11.log).
        const peer = dgram.createSocket('udp4');
        cleanup.push(() =>
        {
            peer.close();
            return Promise.resolve();
        });
        await new Promise<void>((resolve) => peer.bind(0, '127.0.0.1', resolve));
        const peer_port = peer.address().port;
        const received: string[] = [];
        peer.on('message', (m: Buffer) => received.push(m.toString('utf8')));
        // enable ДО подписки → диалог не baseline, первый NOTIFY немедленен.
        peer.send(
            build_sip_request('SUBSCRIBE', {
                ruri: `sip:u00s00p00@127.0.0.1:${st.status().port}`,
                from_uri: 'sip:u00s00p00@127.0.0.1',
                to_uri: 'sip:u00s00p00@127.0.0.1',
                call_id: 'sas-e2e-1',
                cseq: 22542,
                from_tag: 'trunk-tag',
                contact: `sip:u00s00p00@127.0.0.1:${peer_port}`,
                via_host: '127.0.0.1',
                extra_headers: ['Event: ssw-srvm', 'Expires: 7200'],
            }),
            st.status().port,
            '127.0.0.1',
        );
        // SAS_POLL_MS = 2 с + запас на доставку; первый пакет пира — его же
        // 200 на SUBSCRIBE, ждём именно NOTIFY.
        const is_notify = (m: string): boolean => /^NOTIFY\s/i.test(m);
        const got = await wait_until(() => received.some(is_notify), 4000);
        expect(got).toBe(true);
        const notify = received.find(is_notify) ?? '';
        const head = parse_sip_request_head(notify);
        expect(head?.method).toBe('NOTIFY');
        expect(head?.call_id).toBe('sas-e2e-1');
        // Зеркало диалога (план 5 п.4b): From — её To + наш To-тег, To — её
        // From + её тег; R-URI — Contact подписки; пакет — как прислала.
        expect(notify).toMatch(/^NOTIFY sip:u00s00p00@127\.0\.0\.1:/);
        expect(notify).toContain(`;tag=stasub-1`);
        expect(notify).toContain('To: <sip:u00s00p00@127.0.0.1>;tag=trunk-tag');
        expect(notify).toContain('CSeq: 1 NOTIFY');
        expect(notify).toContain('Event: ssw-srvm');
        // Subscription-State обязателен (RFC 3265 §4.1.4): без него pjsip
        // отвечает 400/NOTIFY и отписывается по UAC_WAIT_NOTIFY (12.log).
        expect(notify).toMatch(/Subscription-State: active;expires=\d+/);
        expect(notify).toContain('Content-Type: application/ss-info+xml');
        // Тело: услуги из 10.log + триггеры кейса B (name 33, value 137).
        expect(notify).toContain('<name>ml.line_count</name>');
        expect(notify).toContain('<name>replace_category_from_redirection</name>');
        expect(notify).toContain('{&quot;prefix&quot;:&quot;67805&quot;');
        expect(sas.status().subs[0].number).toBe('u00s00p00');
        expect(sas.status().subs[0].sent).toBe(1);
        expect(sas.status().sent).toBe(1);
        // Ответ пира уходит в статус и НЕ становится мусором станции.
        peer.send(build_sip_response(200, 'OK', notify), st.status().port, '127.0.0.1');
        const answered = await wait_until(() => sas.status().answered['200'] === 1, 2000);
        expect(answered).toBe(true);
        expect(sas.status().subs[0].last_response).toBe('200');
        expect(st.status().counters.ignored ?? 0).toBe(0);
        // 200 на NOTIFY не должен рождать и SAS-диалог/подписку заново.
        expect(sas.status().subs).toHaveLength(1);
    }, 15000);
});

// Запрос-заглушка для build_sip_response (важны Via/From/Call-ID/CSeq/To).
function request_stub(): string
{
    return build_sip_request('NOTIFY', {
        ruri: 'sip:x@127.0.0.1:5060',
        from_uri: 'sip:x@127.0.0.1',
        to_uri: 'sip:x@127.0.0.1',
        call_id: 'stub-1',
        cseq: 1,
        from_tag: 't',
        to_tag: 'p',
        via_host: '127.0.0.1',
    });
}

async function udp_send(port: number, msg: string): Promise<void>
{
    const sock = dgram.createSocket('udp4');
    await new Promise<void>((resolve, reject) =>
        sock.send(Buffer.from(msg, 'utf8'), port, '127.0.0.1', (e) =>
        {
            sock.close();
            e ? reject(e) : resolve();
        }),
    );
}
