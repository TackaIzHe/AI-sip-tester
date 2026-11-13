// Прогон-зонд: доходят ли пакеты от станции до THIS-машины и на какой порт
// (не тест, не в бандле):
//   npx tsx doc/.probe_incoming.ts
//
// Замеры (каждый — свой UDP-сокет, слушает ВСЕ входящие датаграммы):
//  - phase A: сокет на 0.0.0.0:5060 (как ожидает оператор: .157:5060 -> .159:5060);
//  - phase B: сокет на эфемерном порту (как делает SipNodeTransport.open_udp).
// Из каждого шлём OPTIONS и REGISTER 9404 на станцию; логируем любой входящий
// датаграмм с исходным адресом. Плюс local-шум: своя датаграмма на :5060 —
// индикатор, что INPUT-цепочка файрвола не режет 5060 локально.
// related: server/sip/sip_node_transport.ts (rport, Contact), doc/sip_rfc.md §5.10.

import dgram from 'node:dgram';

const PBX = { host: '192.168.80.157', port: 5060 };
const THIS = '192.168.80.159';
const NUMBER = '9404';

function sip_msg(method: string, cseq: number, branch: string, contact_port: number): string
{
    const via = `Via: SIP/2.0/UDP ${THIS}:5060;branch=${branch};rport`;
    const contact = `Contact: <sip:${NUMBER}@${THIS}:${contact_port}>`;
    const extra = method === 'REGISTER' ? `Expires: 120\r\n${contact}\r\n` : '';
    return [
        `${method} sip:${PBX.host}:${PBX.port} SIP/2.0`,
        via,
        'Max-Forwards: 70',
        `From: <sip:${NUMBER}@${PBX.host}>;tag=probe${cseq}`,
        `To: <sip:${NUMBER}@${PBX.host}>`,
        `Call-ID: probe-incoming-${cseq}@${THIS}`,
        `CSeq: ${cseq} ${method}`,
        ...(method === 'REGISTER' ? ['Allow: INVITE, ACK, CANCEL, BYE, OPTIONS, REGISTER'] : []),
        'User-Agent: probe-incoming',
        'Content-Length: 0',
        ...[extra.replace(/\r\n$/, '')].filter((l) => l !== ''),
        '',
        '',
    ].join('\r\n');
}

function phase(name: string, bind_port: number): Promise<void>
{
    return new Promise((resolve) =>
    {
        const sock = dgram.createSocket('udp4');
        let got = 0;
        sock.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) =>
        {
            got++;
            const first = msg.toString('utf8').split('\r\n')[0];
            console.log(`[${name}] <<< FROM ${rinfo.address}:${rinfo.port} : ${first}`);
        });
        sock.on('error', (e: Error) => console.log(`[${name}] sock error: ${e.message}`));
        sock.once('listening', () =>
        {
            const local = sock.address();
            console.log(`[${name}] слушаю ${local.address}:${local.port}`);
            const send = (m: string, label: string) =>
            {
                const buf = Buffer.from(m, 'utf8');
                sock.send(buf, PBX.port, PBX.host, (e?: Error) =>
                    console.log(`[${name}] >>> ${label}: ${e ? e.message : 'sent'}`));
            };
            send(sip_msg('OPTIONS', 1, 'z9hG4bK-probeA1', local.port), 'OPTIONS');
            setTimeout(() => send(sip_msg('REGISTER', 2, 'z9hG4bK-probeA2', local.port),
                                   'REGISTER'), 500);
            // local-шум на этот же порт: проверит, не режет ли INPUT-файрвол 5060
            if (bind_port === 5060)
            {
                setTimeout(() =>
                {
                    const noise = dgram.createSocket('udp4');
                    noise.send(Buffer.from('LOCAL-NOISE-PROBE'), 5060, THIS,
                              () => noise.close());
                    console.log(`[${name}] >>> local noise -> ${THIS}:5060 sent`);
                }, 1000);
            }
            setTimeout(() =>
            {
                console.log(`[${name}] итог: входящих датаграмм за 8 с = ${got}`);
                sock.close();
                resolve();
            }, 8000);
        });
        sock.bind(bind_port, '0.0.0.0');
    });
}

async function main()
{
    await phase('A:5060', 5060);
    await phase('B:ephemeral', 0);
}

main();
