// Один WS-клиент моста = один SIP-UA (перенос task2/bridge/session.ts,
// plan_2.md §2.2): сессия держит собственную стейт-машину и SipPhoneClient
// поверх классического UDP/TCP транспорта, публикуя snapshots как события
// протокола v:1 (server/sip/protocol.ts). Инвариант task2 сохранён:
// один WS-клиент = один SIP-UA, один активный вызов.

import type { WebSocket } from 'ws';
import type { PhoneConfig } from './config';
import { PhoneStateMachine, type PhoneSnapshot } from './state';
import { SipPhoneClient } from './sip_client';
import {
    BRIDGE_V,
    type BridgeCommand,
    type BridgeEvent,
    type BridgeStateName,
} from './protocol';
import { ClassicTransport } from './classic_transport';

const STATE_MAP: Record<string, BridgeStateName> = {
    UNREGISTERED: 'unregistered',
    REGISTERED: 'registered',
    CALL_OUT: 'call_out',
    CALL_IN: 'call_in',
    IN_CALL: 'in_call',
};

export class BridgeSession
{
    private readonly sm = new PhoneStateMachine();
    private readonly client: SipPhoneClient;
    private readonly unsub: () => void;
    private last_sig = '';
    private dead = false;

    constructor(private readonly ws: WebSocket)
    {
        // Тот же клиент и та же машина состояний, что в браузере task2, но транспорт —
        // классический SIP (UDP/TCP) с реальным адресом в Via/Contact. Транспорт
        // станции (udp|tcp) приезжает в cfg вместе с командой register.
        this.client = new SipPhoneClient(this.sm, (cfg) => new ClassicTransport(cfg));
        this.unsub = this.sm.subscribe((s) => this.publish(s));
    }

    private send(e: BridgeEvent): void
    {
        if (this.dead || this.ws.readyState !== this.ws.OPEN) return;
        this.ws.send(JSON.stringify(e));
    }

    private publish(s: PhoneSnapshot): void
    {
        let name = STATE_MAP[s.state];
        // 180 → отдельное состояние протокола
        if (s.state === 'CALL_OUT' && s.ringing) name = 'ringing';
        const sig = `${name}|${s.peer}|${s.error}`;
        if (sig === this.last_sig) return;
        const was_call_in = this.last_sig.startsWith('call_in');
        this.last_sig = sig;
        this.send({
            v: BRIDGE_V,
            type: 'state',
            state: name,
            peer: s.peer || undefined,
            error: s.error || undefined,
        });
        if (name === 'call_in' && !was_call_in)
        {
            this.send({ v: BRIDGE_V, type: 'incoming', from: s.peer });
        }
    }

    /** Обработать команду клиента; ошибки — событиями error{code}, не исключениями. */
    async handle(cmd: BridgeCommand): Promise<void>
    {
        switch (cmd.type)
        {
            case 'register':
            {
                // PhoneConfig упрощён (plan_2.md §2.1):
                // host/sip_port/number/password/transport,
                // SIP-порт берётся из команды моста.
                const cfg: PhoneConfig = {
                    host: cmd.host,
                    sip_port: cmd.port,
                    number: cmd.number,
                    password: cmd.password,
                    transport: cmd.transport,
                };
                await this.client.register(cfg);
                // Финальный код отказа — отдельным событием (контракт error{code,text}).
                if (this.client.last_reg && !this.client.last_reg.ok)
                {
                    this.send({
                        v: BRIDGE_V,
                        type: 'error',
                        code: this.client.last_reg.code,
                        text: this.client.last_reg.text,
                    });
                }
                break;
            }
            case 'unregister':
                await this.client.unregister();
                break;
            case 'call':
                this.client.call(cmd.target);
                break;
            case 'answer':
                this.client.answer();
                break;
            case 'reject':
                this.client.reject_incoming();
                break;
            case 'hangup':
                this.client.hangup();
                break;
            case 'keepalive':
                this.send({ v: BRIDGE_V, type: 'pong' });
                break;
            default:
                // parse_command впускает только перечисленные команды — ветка пуста.
                break;
        }
    }

    /** Закрытие WS-клиента: graceful unregister (BYE + expires=0), идемпотентно. */
    async close(): Promise<void>
    {
        if (this.dead) return;
        this.dead = true;
        this.unsub();
        try
        {
            // graceful: BYE при разговоре, REGISTER expires=0, закрытие UA
            await this.client.unregister();
        }
        catch
        {
            /* шнур уже мог оборваться */
        }
    }
}
