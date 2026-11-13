// SipNodeTransport — классический SIP по UDP/TCP для Node
// (перенос task2/bridge/sipNodeTransport.ts без смены логики, plan_2.md §2.2).
//
// Это НЕ SIP-стек: разбор/сборка сообщений, транзакции, диалоги и Digest
// остаются в sip.js — здесь только сокет-слой, подключаемый через штатную
// опцию UserAgentOptions.transportConstructor (doc/sip_rfc.md §13 — транспорты,
// §8 — транзакции). Машина состояний и точки событий 1-в-1 повторяют эталонный
// Web-транспорт sip.js (platform/web/transport/transport.js): UA зависит именно
// от такой семантики (onConnect на входе в Connected, onDisconnect при уходе
// из Connected).

import dgram from 'node:dgram';
import net from 'node:net';
import { TransportState } from 'sip.js/lib/api/transport-state.js';
import { EmitterImpl } from 'sip.js/lib/api/emitter.js';

export interface SipNodeTransportOptions
{
    /** sip:host:port, host:port или host — порт по умолчанию 5060. */
    server: string;
    /** Классический транспорт станции. */
    transport?: 'udp' | 'tcp';
}

/**
 * RFC 3581: клиент на эфемерном порту обязан поставить в Via `rport` — иначе
 * станция по RFC 3261 §18.2.2 (doc/sip_rfc.md §8.2, §6 поле Via) отправит ответ
 * на порт из Via, а при его отсутствии на дефолтный 5060, и на эфемерный порт
 * сокета ответ не придёт (проверено на живой АТС: без rport REGISTER молча
 * теряется). sip.js rport в Via не добавляет, правим исходящий заголовок здесь.
 */
function ensure_rport(message: string): string
{
    const lines = message.split('\r\n');
    for (let i = 0; i < lines.length; i++)
    {
        if (/^via\s*:/i.test(lines[i]))
        {
            if (!/;rport\b/i.test(lines[i])) lines[i] += ';rport';
            return lines.join('\r\n');
        }
        if (lines[i] === '') break; // тело: Via-заголовков больше нет
    }
    return message;
}

interface MinimalLogger
{
    log(message?: string, ...rest: unknown[]): void;
    warn(message?: string, ...rest: unknown[]): void;
    error(message?: string, ...rest: unknown[]): void;
}

/** Разбор 'sip:1.2.3.4:5060' / '1.2.3.4:5060' / '1.2.3.4'. */
function parse_server(server: string): { host: string; port: number }
{
    const s = server
        .replace(/^sips?:\/\//, '')
        .replace(/^sip:/, '')
        .split(';')[0];
    const m = /^(.+?)(?::(\d+))?$/.exec(s);
    if (!m || !m[1]) throw new Error(`Некорректный адрес станции: ${server}`);
    const port = m[2] ? Number(m[2]) : 5060;
    if (!Number.isInteger(port) || port < 1 || port > 65535)
    {
        throw new Error(`Некорректный порт станции: ${server}`);
    }
    return { host: m[1], port };
}

export class SipNodeTransport
{
    // Имена onConnect/onDisconnect/onMessage/stateChange/isConnected/protocol/
    // server/state/dispose фиксированы контрактом транспорта sip.js
    // (UserAgentOptions.transportConstructor) — это заимствованные имена
    // платформы, они не переводятся в snake_case.
    onConnect: (() => void) | undefined;
    onDisconnect: ((error?: Error) => void) | undefined;
    onMessage: ((message: string) => void) | undefined;
    /**
     * Наблюдатель сырых SIP-сообщений для журнала автотестов (plan_2.md п.3.1):
     * direction 'out' — отправлено станции, 'in' — получено от неё. Логик
     * транспорта не касается — только копирует байты в журнал (ошибки глотаются).
     */
    on_trace: ((direction: 'in' | 'out', message: string) => void) | undefined;

    private current_state: TransportState = TransportState.Disconnected;
    private readonly state_emitter = new EmitterImpl<TransportState>();
    private readonly logger: MinimalLogger;
    private readonly host: string;
    private readonly port: number;
    private readonly proto: 'udp' | 'tcp';
    private udp?: dgram.Socket;
    private tcp?: net.Socket;
    private tcp_buf: Buffer = Buffer.alloc(0);
    private connect_promise?: Promise<void>;
    private last_error?: Error;
    private closing = false;

    /** Сигнатура конструктора UserAgentOptions.transportConstructor. */
    constructor(logger: MinimalLogger, options: SipNodeTransportOptions)
    {
        this.logger = logger;
        const { host, port } = parse_server(options?.server ?? '');
        this.host = host;
        this.port = port;
        this.proto = options?.transport === 'tcp' ? 'tcp' : 'udp';
    }

    /** Via sent-protocol transport (RFC 3261 §20.42, doc/sip_rfc.md §6). */
    get protocol(): string
    {
        return this.proto === 'tcp' ? 'TCP' : 'UDP';
    }

    get server(): string
    {
        return `${this.proto}:${this.host}:${this.port}`;
    }

    get state(): TransportState
    {
        return this.current_state;
    }

    get stateChange(): EmitterImpl<TransportState>
    {
        return this.state_emitter;
    }

    isConnected(): boolean
    {
        return this.current_state === TransportState.Connected;
    }

    /** Локальный адрес сокета — идёт в Via/Contact (мосту нужен реальный адрес). */
    get local_address(): { address: string; port: number } | undefined
    {
        if (this.udp)
        {
            const a = this.udp.address();
            return { address: a.address, port: a.port };
        }
        if (this.tcp?.localAddress)
        {
            return { address: this.tcp.localAddress, port: this.tcp.localPort ?? 0 };
        }
        return undefined;
    }

    connect(): Promise<void>
    {
        if (this.current_state === TransportState.Connected) return Promise.resolve();
        if (this.current_state === TransportState.Connecting && this.connect_promise)
            return this.connect_promise;
        this.closing = false; // разрешаем будущие «нежданные» разрывы
        this.set_state(TransportState.Connecting);
        this.connect_promise = this.open()
            .then(() =>
            {
                this.connect_promise = undefined;
                this.set_state(TransportState.Connected);
            })
            .catch((e: Error) =>
            {
                this.connect_promise = undefined;
                this.close_sockets();
                this.set_state(TransportState.Disconnected);
                this.logger.warn(`Не удалось открыться ${this.server}: ${e.message}`);
                throw e;
            });
        return this.connect_promise;
    }

    disconnect(): Promise<void>
    {
        if (this.current_state === TransportState.Disconnected) return Promise.resolve();
        this.closing = true;
        this.close_sockets();
        // уход из Connected → onDisconnect() без error — «своё»
        this.set_state(TransportState.Disconnected);
        return Promise.resolve();
    }

    async dispose(): Promise<void>
    {
        await this.disconnect();
        this.state_emitter.removeAllListeners();
    }

    send(message: string): Promise<void>
    {
        if (this.current_state !== TransportState.Connected)
        {
            return Promise.reject(new Error('Транспорт не подключен к станции'));
        }
        if (this.proto === 'udp')
        {
            const sock = this.udp;
            if (!sock) return Promise.reject(new Error('UDP-сокет не поднят'));
            const buf = Buffer.from(ensure_rport(message), 'utf8');
            this.logger.log(`>>> ${buf.toString('utf8').replace(/\r\n/g, ' | ')}`);
            this.trace('out', buf.toString('utf8'));
            // UDP-сокет «connected» (см. open_udp) — цель implicit, иначе Node
            // бросает ERR_ALREADY_CONNECTED.
            return new Promise((resolve, reject) =>
                sock.send(buf, (e) => (e ? reject(e) : resolve())),
            );
        }
        this.trace('out', message);
        const sock = this.tcp;
        if (!sock) return Promise.reject(new Error('TCP-соединение не поднято'));
        return new Promise((resolve, reject) =>
            sock.write(message, 'utf8', (e) => (e ? reject(e) : resolve())),
        );
    }

    // ---------- внутреннее ----------

    /** Вызов наблюдателя журнала; ошибка наблюдателя не должна ронять транспорт. */
    private trace(direction: 'in' | 'out', message: string): void
    {
        if (!this.on_trace) return;
        try
        {
            this.on_trace(direction, message);
        }
        catch
        {
            /* журнал не вправе ломать передачу SIP */
        }
    }

    private open(): Promise<void>
    {
        return this.proto === 'udp' ? this.open_udp() : this.open_tcp();
    }

    private open_udp(): Promise<void>
    {
        return new Promise<void>((resolve, reject) =>
        {
            const sock = dgram.createSocket('udp4');
            sock.on('message', (msg: Buffer) =>
            {
                const text = msg.toString('utf8');
                this.logger.log(`<<< ${text.replace(/\r\n/g, ' | ')}`);
                this.trace('in', text);
                if (this.current_state === TransportState.Connected)
                    this.onMessage?.(text);
            });
            sock.on('error', (err: Error) =>
            {
                if (this.connect_promise) reject(err);
                else this.fail(err);
            });
            sock.once('listening', () =>
            {
                // «connect» UDP-сокета к станции: адрес() начинает возвращать реальный
                // локальный IP (а не 0.0.0.0), и принимается трафик только от станции.
                this.udp = sock;
                sock.connect(this.port, this.host, () => resolve());
            });
            sock.bind(0); // эфемерный локальный порт — адресат известен из URL станции
        });
    }

    private open_tcp(): Promise<void>
    {
        return new Promise<void>((resolve, reject) =>
        {
            const sock = net.connect(this.port, this.host);
            let opened = false;
            sock.once('connect', () =>
            {
                opened = true;
                this.tcp = sock;
                resolve();
            });
            sock.once('error', (err: Error) =>
            {
                if (!opened && this.connect_promise) reject(err);
                else if (!opened) reject(err);
                else this.fail(err);
            });
            sock.on('close', () =>
            {
                if (!this.closing && this.current_state === TransportState.Connected)
                {
                    this.fail(new Error('TCP-соединение со станцией закрыто'));
                }
            });
            sock.on('data', (chunk: Buffer) => this.feed_tcp(chunk));
        });
    }

    /**
     * Фрейминг SIP/TCP: заголовки до \r\n\r\n + Content-Length
     * (doc/sip_rfc.md §13.1).
     */
    private feed_tcp(chunk: Buffer): void
    {
        this.tcp_buf = Buffer.concat([this.tcp_buf, chunk]);
        for (;;)
        {
            const headerEnd = this.tcp_buf.indexOf('\r\n\r\n');
            if (headerEnd < 0) return;
            const header = this.tcp_buf.subarray(0, headerEnd).toString('utf8');
            const m = /content-length:\s*(\d+)/i.exec(header);
            const len = m ? Number(m[1]) : 0;
            const total = headerEnd + 4 + len;
            if (this.tcp_buf.length < total) return;
            const msg = this.tcp_buf.subarray(0, total).toString('utf8');
            this.tcp_buf = this.tcp_buf.subarray(total);
            this.trace('in', msg);
            if (this.current_state === TransportState.Connected) this.onMessage?.(msg);
        }
    }

    /** Внезапная потеря соединения: Connected → Disconnected с ошибкой. */
    private fail(error: Error): void
    {
        if (this.current_state !== TransportState.Connected || this.closing) return;
        this.close_sockets();
        this.last_error = error; // set_state передаст её в onDisconnect(error)
        this.set_state(TransportState.Disconnected);
    }

    private set_state(next: TransportState): void
    {
        const old = this.current_state;
        if (old === next) return;
        this.current_state = next;
        this.state_emitter.emit(next);
        if (next === TransportState.Connected)
        {
            this.onConnect?.();
        }
        if (old === TransportState.Connected)
        {
            const err = this.last_error;
            this.last_error = undefined;
            if (err) this.onDisconnect?.(err);
            else this.onDisconnect?.();
        }
    }

    private close_sockets(): void
    {
        if (this.udp)
        {
            try
            {
                this.udp.close();
            }
            catch
            {
                /* уже закрыт */
            }
            this.udp = undefined;
        }
        if (this.tcp)
        {
            this.tcp.removeAllListeners();
            try
            {
                this.tcp.destroy();
            }
            catch
            {
                /* уже закрыт */
            }
            this.tcp = undefined;
            this.tcp_buf = Buffer.alloc(0);
        }
    }
}
