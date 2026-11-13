// SIP-мост сервера (перенос task2/bridge/main.ts, plan_2.md §2.3): WebSocket (JSON v:1)
// со стороны UI ↔ классический SIP UDP/TCP со стороны АТС. Отличие от task2 —
// адрес и порт берутся из .env (BRIDGE_HOST/BRIDGE_PORT, единая точка чтения —
// server/config.ts) и должны быть достижимы из сети станции (не 127.0.0.1).
// Один WS-клиент = один SIP-UA (BridgeSession); heartbeat ping вычищает
// «мёртвые» соединения, которые TCP не заметил бы сам.

import { WebSocketServer, WebSocket } from 'ws';
import { load_config_from_env } from './server/config';
import { parse_command } from './server/sip/protocol';
import { BridgeSession } from './server/sip/session';

const config = load_config_from_env();
const HOST = config.bridge_host;
const PORT = config.bridge_port;
/** Период ping для обнаружения «мёртвых» клиентов. */
const PING_MS = 30_000;

const wss = new WebSocketServer({ host: HOST, port: PORT });
const alive = new WeakMap<WebSocket, boolean>();

wss.on('connection', (ws, req) =>
{
    const ip = req.socket.remoteAddress;
    const session = new BridgeSession(ws);
    alive.set(ws, true);
    console.log(`[bridge] клиент ${ip}`);

    ws.on('pong', () => alive.set(ws, true));
    ws.on('message', (data) =>
    {
        const cmd = parse_command(String(data));
        if (!cmd)
        {
            ws.send(
                JSON.stringify({
                    v: 1,
                    type: 'error',
                    code: 0,
                    text: 'Некорректная команда',
                }),
            );
            return;
        }
        void session.handle(cmd).catch((e: Error) =>
        {
            ws.send(
                JSON.stringify({
                    v: 1,
                    type: 'error',
                    code: 0,
                    text: `Ошибка моста: ${e.message}`,
                }),
            );
        });
    });
    ws.on('close', () =>
    {
        console.log(`[bridge] клиент отключился ${ip}`);
        void session.close();
    });
    ws.on('error', () => void session.close());
});

const heartbeat = setInterval(() =>
{
    for (const ws of wss.clients)
    {
        if (!alive.get(ws))
        {
            ws.terminate();
            continue;
        }
        alive.set(ws, false);
        ws.ping();
    }
}, PING_MS);

wss.on('close', () => clearInterval(heartbeat));

console.log(`[bridge] слушает ws://${HOST}:${PORT} (SIP UDP/TCP → станция)`);

// graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM'] as const)
{
    process.on(sig, () =>
    {
        console.log(`[bridge] ${sig}, завершаю…`);
        for (const ws of wss.clients as Set<WebSocket>) ws.close(1001, 'bridge shutdown');
        wss.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
    });
}
