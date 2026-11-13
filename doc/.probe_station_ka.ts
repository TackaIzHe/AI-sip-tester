// Прогон-зонд для проверки мимикрии станции-эмулятора (не тест, не в бандле):
//   npx tsx doc/.probe_station_ka.ts [host:port]
//
// Без аргумента поднимает собственную SipStation из .env (STATION_HOST/PORT/
// PROTO; для 5060 нужен root/setcap — при EACCES зонд честно печатает текст
// ошибки) и гоняет по UDP и TCP три стимула: OPTIONS (ожидаем 200 с Allow/
// Allow-Events/User-Agent — дословно из дампов pa_sip), REGISTER (405 Allow:
// OPTIONS) и мусор (ответа нет, счётчик ignored). С аргументом `host:port`
// ничего не поднимает и шлёт те же стимулы на чужой UAS — так зонд проверяет
// живой эмулятор или станцию, не занимая порт.
// related: server/station/station.ts, server/los_mem/raw_sip.ts
// (RawSipClient, build_sip_request, parse_sip_response), doc/plan_4.md п.6.

import { load_config_from_env } from '../server/config';
import {
    build_sip_request,
    parse_sip_response,
    RawSipClient,
} from '../server/los_mem/raw_sip';
import { SipStation } from '../server/station/station';

/** Один стимул: отправить, дождаться ответа, напечатать его целиком. */
async function probe(
    client: RawSipClient,
    method: string,
    call_id: string,
    raw?: string,
): Promise<void>
{
    const msg = raw ?? build_sip_request(method, {
        ruri: 'sip:probe@station',
        from_uri: 'sip:probe@probe',
        to_uri: 'sip:probe@station',
        call_id,
        cseq: 1,
        from_tag: 'probe-tag',
        via_host: '127.0.0.1',
    });
    const tag = raw ? 'мусор' : method;
    await client.send(msg);
    const resp = await client.wait_response(call_id, 2000);
    if (resp === undefined)
    {
        console.log(`--- ${tag}: ответа нет (ожидаем именно этого при мусоре)`);
        return;
    }
    const head = parse_sip_response(resp);
    console.log(`--- ${tag} → ${head ? head.status : '?'}:\n${resp.trimEnd()}`);
}

async function probe_proto(
    host: string,
    port: number,
    proto: 'udp' | 'tcp',
): Promise<void>
{
    console.log(`\n===== ${proto.toUpperCase()} ${host}:${port} =====`);
    const client = new RawSipClient({ host, port, proto });
    await client.connect();
    const n = Math.floor(Date.now() / 1000); // уникальный Call-ID между запусками
    await probe(client, 'OPTIONS', `probe-ka-${n}`);
    await probe(client, 'REGISTER', `probe-reg-${n}`);
    await probe(client, '', `probe-junk-${n}`, 'ЭТО НЕ SIP ???\r\n');
    client.close();
}

async function main(): Promise<void>
{
    const arg = process.argv[2];
    let host: string;
    let port: number;
    let station: SipStation | undefined;
    if (arg)
    {
        const i = arg.lastIndexOf(':');
        host = arg.slice(0, i);
        port = Number(arg.slice(i + 1));
        if (!host || !Number.isInteger(port) || port <= 0 || port > 65535)
        {
            console.error(`не понимаю адрес «${arg}» — жду host:port`);
            process.exit(1);
        }
        console.log(`стимулы на внешний UAS ${host}:${port} (свою не поднимаем)`);
    }
    else
    {
        const config = load_config_from_env();
        station = new SipStation(config);
        try
        {
            await station.start();
        }
        catch (e: unknown)
        {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`свою станцию не поднял: ${msg}`);
            process.exit(1);
        }
        const st = station.status();
        host = st.host;
        port = st.port;
        console.log(`своя станция: ${host}:${port} (${st.proto})`);
    }

    await probe_proto(host, port, 'udp');
    await probe_proto(host, port, 'tcp');

    if (station)
    {
        const st = station.status();
        console.log(
            `\nсчётчики: in=${JSON.stringify(st.counters.requests_in)} ` +
                `answered=${JSON.stringify(st.counters.answered)} ` +
                `ignored=${st.counters.ignored} peers=${st.counters.peers.length}`,
        );
        await station.stop();
    }
}

void main();
