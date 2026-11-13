// Прогон-зонд: поймать keep-alive станции на портах СТАРЫХ binding-ов.
// Станция (см. doc/res_term.md) шлёт keep-alive НЕ на :5060, а на Contact
// каждой живой регистрации — эфемерные порты прежних процессов пула
// (cdpn 44..47 -> 60501/34159/34512/45665). Зонд поднимает UDP+TCP слушатели
// на этих портах и печатает любой входящий пакет с источником (не тест,
// не в бандле):
//   npx tsx doc/.probe_keepalive_capture.ts [секунд] [порты...]
// related: doc/res_term.md, server/station/station.ts, doc/task_21_plan_2.md
// (снятие регистрации обязано идти тем же Contact/портом).

import dgram from 'node:dgram';
import net from 'node:net';

const wait_s = Number(process.argv[2] ?? '120');
const ports = process.argv.slice(3).map(Number);
const listen_ports = ports.length ? ports : [5060, 60501, 34159, 34512, 45665];

// Ответ 200 на keep-alive OPTIONS — как ведущая станция (keep_alive_reply pa_sip).
function ok_for(msg: string, this_port: number): string
{
    const pick = (h: RegExp) => msg.match(h)?.[1] ?? '';
    return [
        'SIP/2.0 200 OK',
        `Via: ${pick(/Via: ([^\r]+)/)}`,
        `From: ${pick(/From: ([^\r]+)/)}`,
        `To: ${pick(/To: ([^\r]+)/)};tag=lead${this_port}`,
        `Call-ID: ${pick(/Call-ID: ([^\r]+)/)}`,
        `CSeq: ${pick(/CSeq: ([^\r]+)/)}`,
        'Allow: OPTIONS, SUBSCRIBE, NOTIFY, PUBLISH, MESSAGE, INVITE, ACK, BYE, CANCEL',
        'User-Agent: probe-lead',
        'Content-Length: 0',
        '',
        '',
    ].join('\r\n');
}

for (const p of listen_ports)
{
    const u = dgram.createSocket('udp4');
    u.on('message', (m: Buffer, r: dgram.RemoteInfo) =>
    {
        const text = m.toString('utf8');
        console.log(`<<< UDP :${p} от ${r.address}:${r.port}:\n${text}`);
        if (/^OPTIONS\b/m.test(text))
            u.send(Buffer.from(ok_for(text, p), 'utf8'), r.port, r.address);
    });
    u.on('error', (e: Error) => console.log(`udp ${p}: ${e.message}`));
    u.bind(p, '192.168.80.159');
    const t = net.createServer((s) =>
    {
        console.log(`<<< TCP :${p} соединение от ${s.remoteAddress}:${s.remotePort}`);
        s.on('data', (d: Buffer) =>
        {
            const text = d.toString('utf8');
            console.log(`<<< TCP :${p} данные:\n${text}`);
            if (/^OPTIONS\b/m.test(text)) s.write(ok_for(text, p), 'utf8');
        });
        s.on('error', () => undefined);
    });
    t.on('error', (e: Error) => console.log(`tcp ${p}: ${e.message}`));
    t.listen(p, '192.168.80.159');
}
console.log(`слушаю ${listen_ports.join(', ')} (tcp+udp), жду …`);
setTimeout(() => process.exit(0), wait_s * 1000);
