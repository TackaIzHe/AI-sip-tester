// Контракт «UI ↔ мост» — перенос task2/bridge/protocol.ts без смены логики
// (plan_2.md §2.2): JSON поверх WebSocket, версия v:1. Состояния 1:1 со
// стейт-машиной server/sip/state.ts; коды/тексты ошибок — общая карта
// server/sip/sip_text.ts (коды RFC 3261 §21, doc/sip_rfc.md §7.2).

export const BRIDGE_V = 1 as const;

export type BridgeSipProto = 'udp' | 'tcp';

// ---------- команды (UI → мост) ----------

export type BridgeCommand =
    | {
          v: 1;
          type: 'register';
          /** хост/порт классической АТС, transport udp|tcp */
          host: string;
          port: number;
          transport: BridgeSipProto;
          number: string;
          password: string;
      }
    | { v: 1; type: 'unregister' }
    | { v: 1; type: 'call'; target: string }
    | { v: 1; type: 'answer' }
    | { v: 1; type: 'reject'; code?: number }
    | { v: 1; type: 'hangup' }
    | { v: 1; type: 'keepalive' };

// ---------- события (мост → UI) ----------

/** 1:1 с PhoneState; ringing — подсостояние CALL_OUT (180). */
export type BridgeStateName =
    'unregistered' | 'registered' | 'call_out' | 'ringing' | 'call_in' | 'in_call';

/** pong — ответ на keepalive; bye — мост закрывает сессию (задание клиента). */
export type BridgeEvent =
    | { v: 1; type: 'state'; state: BridgeStateName; peer?: string; error?: string }
    | { v: 1; type: 'incoming'; from: string }
    | { v: 1; type: 'error'; code: number; text: string }
    | { v: 1; type: 'pong' }
    | { v: 1; type: 'bye'; reason?: string };

/**
 * Валидный разбор команды; null — на битый JSON/версию/поля (клиенту шлётся
 * общая ошибка).
 */
export function parse_command(raw: string): BridgeCommand | null
{
    try
    {
        const o = JSON.parse(raw) as Record<string, unknown>;
        if (o?.v !== BRIDGE_V || typeof o.type !== 'string') return null;
        switch (o.type)
        {
            case 'register':
                if (
                    typeof o.host === 'string' &&
                    typeof o.port === 'number' &&
                    (o.transport === 'udp' || o.transport === 'tcp') &&
                    typeof o.number === 'string' &&
                    typeof o.password === 'string'
                )
                    return o as unknown as BridgeCommand;
                return null;
            case 'unregister':
            case 'answer':
            case 'hangup':
            case 'keepalive':
                return { v: 1, type: o.type };
            case 'call':
                return typeof o.target === 'string'
                    ? { v: 1, type: 'call', target: o.target }
                    : null;
            case 'reject':
                return {
                    v: 1,
                    type: 'reject',
                    code: typeof o.code === 'number' ? o.code : 486,
                };
            default:
                return null;
        }
    }
    catch
    {
        return null;
    }
}
