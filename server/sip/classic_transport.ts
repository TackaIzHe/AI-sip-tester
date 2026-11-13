// ClassicTransport — верхнеуровневый Transport сервера: SIP UDP/TCP
// (перенос task2/bridge/classicTransport.ts без смены логики, plan_2.md §2.2).
//
// Порядок сборки нетривиален: sip.js web-UA пишет в Contact/Via хост
// `<random>.invalid` (браузер не знает свой адрес) — для классической АТС
// это смертельно (INVITE на .invalid → Asterisk отвечает congestion).
// Поэтому сначала поднимаем сокет и узнаём реальный локальный адрес:
// viaHost = адрес сокета (без порта — иначе sip.js режет ответы,
// doc/sip_rfc.md §6 поле Via / §20.42), а эфемерный порт дописываем
// в Contact + transport-параметр (doc/sip_rfc.md §9.1.1 Contact).

import type { PhoneConfig } from './config';
import type {
    CallHandle,
    RegResult,
    Transport,
    TransportEventName,
    TransportEvents,
} from './transport';
import { DEBUG } from './debug';
import { SipNodeTransport } from './sip_node_transport';
import { SipUaTransport } from './sip_ua_transport';

export class ClassicTransport implements Transport
{
    private inner?: SipUaTransport;
    /**
     * SipPhoneClient подписывается на события ДО connect() (а inner появляется
     * только в connect) — буферизуем подписки и навешиваем их на inner позже.
     */
    private pending: Array<{
        event: TransportEventName;
        cb: (...args: unknown[]) => void;
    }> = [];

    /**
     * @param on_trace — необязательный наблюдатель сырых SIP-сообщений для
     * журнала автотестов (plan_2.md п.3.1); навешивается на сокет в connect().
     */
    constructor(
        private readonly cfg: PhoneConfig,
        private readonly on_trace?: (direction: 'in' | 'out', message: string) => void,
    )
    {}

    async connect(): Promise<void>
    {
        function noop(): void
        {}
        const node_transport = new SipNodeTransport(
            DEBUG
                ? { log: console.log, warn: console.warn, error: console.error }
                : { log: noop, warn: noop, error: noop },
            {
                server: `sip:${this.cfg.host}:${this.cfg.sip_port}`,
                transport: this.cfg.transport,
            },
        );
        if (this.on_trace) node_transport.on_trace = this.on_trace;
        // Сокет поднимаем ДО UserAgent: адрес сокета отправляется в Via/Contact.
        await node_transport.connect();
        const addr = node_transport.local_address;
        if (!addr) throw new Error('Не удалось определить локальный адрес транспорта');
        // В Via — только хост: sip.js принципиально отбрасывает ответы, где в
        // sent-by есть порт (SanityCheck rfc3261_18_1_2). Ответы и так приходят на
        // порт источника UDP, а in-dialog запросы АТС шлёт строго в Contact —
        // эфемерный порт дописываем в Contact после создания UA.
        this.inner = new SipUaTransport(this.cfg, {
            viaHost: addr.address,
            contactParams: { transport: this.cfg.transport },
            // transportConstructor вызывается внутри UserAgent как new options
            // .transportConstructor(...) — возвращаем уже подключённый экземпляр
            // (connect() у него тогда no-op). Функция обязана быть expression-видом
            // с keyword `function`: стрелочная не вызывается через new, а возврат
            // объекта из конструктора подменяет собой this.
            transportConstructor: function ()
            {
                return node_transport;
            },
        });
        // as never: в pending колбэки лежат стёртыми до (...args) => void,
        // конкретика события K здесь уже неизвестна (была сохранена в event).
        for (const p of this.pending) this.inner.on(p.event, p.cb as never);
        this.pending = [];
        await this.inner.connect();
        const ua = this.inner.user_agent;
        if (ua) ua.contact.uri.port = addr.port;
    }

    disconnect(): Promise<void>
    {
        return this.inner?.disconnect() ?? Promise.resolve();
    }

    register(): Promise<RegResult>
    {
        if (!this.inner) return Promise.reject(new Error('connect() не вызван'));
        return this.inner.register();
    }

    unregister(): Promise<void>
    {
        return this.inner?.unregister() ?? Promise.resolve();
    }

    call(target: string): CallHandle
    {
        if (!this.inner) throw new Error('connect() не вызван');
        return this.inner.call(target);
    }

    on<K extends TransportEventName>(event: K, cb: TransportEvents[K]): () => void
    {
        if (this.inner) return this.inner.on(event, cb);
        const entry = { event, cb: cb as unknown as (...args: unknown[]) => void };
        this.pending.push(entry);
        return () =>
        {
            const i = this.pending.indexOf(entry);
            if (i >= 0) this.pending.splice(i, 1);
        };
    }
}
