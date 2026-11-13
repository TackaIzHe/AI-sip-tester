// SipUaTransport — машина UserAgent поверх sip.js: перенос task2/src/wsTransport.ts
// (plan_2.md §2.1) в классический режим. Механизм UA/регистраций/сессий перенесён
// 1-в-1 (включая P0-фиксы bug_report_1 task2); убрана только WS-ветка: реальный
// транспорт (UDP/TCP-сокет) всегда инжектируется ClassicTransport через
// ua_overrides.transportConstructor, а transportOptions.server — служебная строка.
// Digest 401/407 и транзакции — внутри sip.js (doc/sip_rfc.md §5.4, §8).

import {
    Invitation,
    Inviter,
    Registerer,
    RegistererState,
    Session,
    SessionState,
    URI,
    UserAgent,
} from 'sip.js';
import type { UserAgentDelegate } from 'sip.js';
import type { IncomingResponse } from 'sip.js/lib/core/messages/incoming-response.js';
import { DEBUG } from './debug';
import type { PhoneConfig } from './config';
import { sip_status_text } from './sip_text';
import type {
    CallHandle,
    RegResult,
    Transport,
    TransportEventName,
    TransportEvents,
} from './transport';

// Порт 9 (discard) + inactive: кодек согласуется (иначе АТС отвечает 488),
// но RTP никуда не отправляется и не принимается — чистая сигнализация.
export const NO_MEDIA_SDP =
    'v=0\r\n' +
    'o=- 3700000000 3700000000 IN IP4 127.0.0.1\r\n' +
    's=sip-webphone\r\n' +
    'c=IN IP4 127.0.0.1\r\n' +
    't=0 0\r\n' +
    'm=audio 9 RTP/AVP 0\r\n' +
    'a=inactive\r\n';

/** Заглушка медиа: без getUserMedia/RTCPeerConnection, только SDP-заглушка. */
export class NoMediaSessionDescriptionHandler
{
    close(): void
    {}
    getDescription(): Promise<{ body: string; contentType: string }>
    {
        return Promise.resolve({ body: NO_MEDIA_SDP, contentType: 'application/sdp' });
    }
    hasDescription(contentType: string): boolean
    {
        return contentType === 'application/sdp';
    }
    setDescription(): Promise<void>
    {
        return Promise.resolve();
    }
    sendDtmf(): boolean
    {
        return false;
    }
}

// Фабрика SDH для UserAgent: sip.js зовёт её как обычную функцию
// factory(session, options) (api/session.js:1143), не через new.
function no_media_factory(): NoMediaSessionDescriptionHandler
{
    return new NoMediaSessionDescriptionHandler();
}

/** сколько ждём финальный ответ на REGISTER, если станция «молчит». */
export const REGISTER_TIMEOUT_MS = 15_000;

/**
 * Ждёт финального итога регистрации из registerer.stateChange.
 * sip.js дёргает stateChange до requestDelegate.onReject в том же тике —
 * финальный код (в т.ч. повторный 401 при неверном пароле) подхватывается
 * на следующем тике (BUG-1/2/3 из bug_report_1.md, task2).
 */
export function await_register_result(registerer: Registerer): Promise<RegResult>
{
    return new Promise<RegResult>((resolve) =>
    {
        let last_code = 0;
        let settled = false;
        function finish(ok: boolean, code: number, text: string): void
        {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            registerer.stateChange.removeListener(listener);
            resolve({ ok, code, text });
        }
        function listener(s: RegistererState): void
        {
            if (s === RegistererState.Registered)
            {
                finish(true, 0, '');
            }
            else if (
                s === RegistererState.Unregistered ||
                s === RegistererState.Terminated
            )
            {
                setTimeout(
                    () =>
                        finish(
                            false,
                            last_code,
                            sip_status_text(last_code, 'Станция отвергла регистрацию'),
                        ),
                    0,
                );
            }
        }
        const timer = setTimeout(
            () => finish(false, 0, 'Станция не ответила на REGISTER (тайм-аут)'),
            REGISTER_TIMEOUT_MS,
        );
        registerer.stateChange.addListener(listener);
        registerer
            .register({
                requestDelegate: {
                    // 401/407 sip.js отрабатывает сам (повтор с паролем); в onReject
                    // попадает только финальный отказ, включая 401 после auth-loop.
                    onReject: (response: IncomingResponse) =>
                    {
                        last_code = response.message.statusCode ?? 0;
                    },
                },
            })
            .catch((e: unknown) =>
            {
                if (DEBUG) console.error('register send error:', e);
                setTimeout(
                    () =>
                        finish(
                            false,
                            last_code,
                            sip_status_text(last_code, 'Не удалось отправить REGISTER'),
                        ),
                    0,
                );
            });
    });
}

interface ActiveCall
{
    session: Session;
    /** Финальный SIP-код отказа, если был (для terminated). */
    last_code: number;
}

export class SipUaTransport implements Transport
{
    private ua?: UserAgent;
    private registerer?: Registerer;
    private active?: ActiveCall;
    private registered_ok = false;
    private manual_stop = false;
    private transport_lost = false;
    private listeners = new Map<TransportEventName, Set<(...args: unknown[]) => void>>();

    /**
     * @param ua_overrides — дополнительные UserAgentOptions: ClassicTransport передаёт
     * transportConstructor/transportOptions (уже подключённый UDP/TCP-сокет),
     * viaHost и contactParams — чтобы sip.js говорил со станцией по классическому SIP.
     */
    constructor(
        private readonly cfg: PhoneConfig,
        private readonly ua_overrides: Record<string, unknown>,
    )
    {}

    /** sip.js UA — нужен мосту, чтобы поправить Contact после поднятия сокета. */
    get user_agent(): UserAgent | undefined
    {
        return this.ua;
    }

    // ---------- события ----------

    on<K extends TransportEventName>(event: K, cb: TransportEvents[K]): () => void
    {
        const set: Set<(...args: unknown[]) => void> =
            this.listeners.get(event) ?? new Set();
        if (!this.listeners.has(event)) this.listeners.set(event, set);
        const fn = cb as unknown as (...args: unknown[]) => void;
        set.add(fn);
        return () => set.delete(fn);
    }

    private emit(event: TransportEventName, ...args: unknown[]): void
    {
        for (const cb of this.listeners.get(event) ?? [])
        {
            try
            {
                cb(...args);
            }
            catch (e)
            {
                if (DEBUG) console.error('transport listener error:', e);
            }
        }
    }

    // ---------- жизненный цикл ----------

    async connect(): Promise<void>
    {
        const { host, number, password, sip_port } = this.cfg;
        const delegate: UserAgentDelegate = {
            onInvite: (inv) => this.on_invite(inv),
            onConnect: () => this.onTransportConnect(),
            onDisconnect: () => this.onTransportDisconnect(),
        };
        const ua = new UserAgent({
            uri: new URI('sip', number, host, sip_port),
            // Сервер не используется: реальный транспорт приходит из
            // ua_overrides.transportConstructor (ClassicTransport). Строка служебная.
            transportOptions: { server: `sip:${host}:${sip_port}` },
            authorizationUsername: number,
            authorizationPassword: password,
            // as never: заглушка — частичная реализация SessionDescriptionHandler
            // (медиа нет намеренно), структурно full-контракт не удовлетворяет.
            sessionDescriptionHandlerFactory: no_media_factory as never,
            reconnectionAttempts: 8,
            reconnectionDelay: 3,
            logLevel: DEBUG ? 'debug' : 'warn',
            delegate,
            ...this.ua_overrides,
        });
        this.ua = ua;
        try
        {
            await ua.start();
        }
        catch (e)
        {
            await this.stop_ua();
            throw new Error(
                `Не подключается к станции ${host}:${sip_port}: ${(e as Error).message}`,
            );
        }
        // Классические АТС авторизуют исходящие по совпадению user-части Contact
        // регистрации с номером абонента. sip.js пишет туда случайный токен, и
        // станция начинает слать 401 на INVITE (а Digest с «декоративным» паролем
        // станция отвергает — 403). Ставим номер абонента в user-часть Contact
        // (тот же механизм, что дописывание порта в classic_transport.ts).
        // ПРИМЕР: вызов 1199->52 на станции 192.168.80.157.
        ua.contact.uri.user = number;
    }

    async register(): Promise<RegResult>
    {
        if (!this.ua) throw new Error('connect() не вызван');
        const registerer = new Registerer(this.ua, { expires: 600 });
        this.registerer = registerer;
        // Станция сняла/не продлила регистрацию после успеха (BUG-2: отслеживаем
        // Unregistered, а не только Terminated).
        registerer.stateChange.addListener((s) =>
        {
            if (!this.registered_ok || this.manual_stop || this.transport_lost) return;
            if (s === RegistererState.Unregistered || s === RegistererState.Terminated)
            {
                this.emit(
                    'registration-lost',
                    'Регистрация истекла или отменена станцией',
                );
            }
        });
        const res = await await_register_result(registerer);
        this.registered_ok = res.ok;
        return res;
    }

    async unregister(): Promise<void>
    {
        this.registered_ok = false;
        try
        {
            await this.registerer?.unregister();
        }
        catch
        {
            /* игнорируем — закрытие всё равно принудительное */
        }
    }

    async disconnect(): Promise<void>
    {
        this.manual_stop = true;
        // Сначала штатно завершаем активный вызов (BYE/CANCEL), иначе удалённый
        // абонент продолжает вызванивать до таймаута станции (BUG-7).
        const active = this.active;
        if (active)
        {
            try
            {
                if (active.session instanceof Inviter) await active.session.cancel();
                else await active.session.bye();
            }
            catch
            {
                /* не удалось штатно — закроем транспортом */
            }
            await this.wait_active_terminated(2000);
        }
        await this.unregister();
        await this.stop_ua();
    }

    private async stop_ua(): Promise<void>
    {
        this.registerer = undefined;
        this.registered_ok = false;
        try
        {
            await this.ua?.stop();
        }
        catch
        {
            /* noop */
        }
        this.ua = undefined;
    }

    // ---------- транспорт ----------

    private onTransportConnect(): void
    {
        if (!this.transport_lost) return;
        this.transport_lost = false;
        // После реконнекта перерегистрируемся; успех/неуспех — событиями.
        if (this.registerer && !this.manual_stop && this.registered_ok)
        {
            this.registerer
                .register()
                .then(() => this.emit('registered'))
                .catch(() =>
                    this.emit('registration-lost', 'Перерегистрация не удалась'),
                );
        }
    }

    private onTransportDisconnect(): void
    {
        if (this.manual_stop) return;
        this.transport_lost = true;
        this.emit('transport-lost', 'Соединение потеряно, переподключение…');
    }

    // ---------- вызовы ----------

    call(target: string): CallHandle
    {
        if (!this.ua) throw new Error('connect() не вызван');
        const uri = new URI('sip', target, this.cfg.host, this.cfg.sip_port);
        const inviter = new Inviter(this.ua, uri);
        const rec: ActiveCall = { session: inviter, last_code: 0 };
        this.active = rec;
        this.watch_session(rec, inviter);
        inviter
            .invite({
                requestDelegate: {
                    onProgress: () => this.emit('ringing'),
                    onReject: (response: IncomingResponse) =>
                    {
                        rec.last_code = response.message.statusCode ?? 0;
                    },
                },
            })
            .catch((e: unknown) =>
            {
                if (DEBUG) console.error('invite error:', e);
            });
        return this.make_handle(inviter);
    }

    private on_invite(invitation: Invitation): void
    {
        // Занят (есть активная сессия): второй INVITE не становится «активным»
        // вызовом телефона — клиент его отклонит (486), и его завершение НЕ должно
        // влиять на текущий разговор.
        const busy = !!this.active;
        const rec: ActiveCall = { session: invitation, last_code: 0 };
        if (!busy) this.active = rec;
        this.watch_session(rec, invitation, !busy);
        const peer = invitation.remoteIdentity.uri.user ?? 'неизвестно';
        this.emit('incoming', peer, this.make_handle(invitation));
    }

    /**
     * Единая подписка на состояние сессии: established/terminated.
     * Финальные коды (487 на CANCEL, 486 на reject после 180) sip.js пишет в
     * requestDelegate ПОСЛЕ stateChange(Terminated) — код читаем на следующем
     * тике (BUG-5 на стороне клиента).
     * @param report false — фоновая сессия (второй входящий в занятого): её
     * завершение не транслируем стейт-машине телефона, только убираем за собой.
     */
    private watch_session(
        rec: ActiveCall,
        session: Invitation | Inviter,
        report = true,
    ): void
    {
        const listener = (st: SessionState) =>
        {
            if (st === SessionState.Established)
            {
                if (report) this.emit('established');
            }
            else if (st === SessionState.Terminated)
            {
                session.stateChange.removeListener(listener);
                if (this.active?.session === session) this.active = undefined;
                try
                {
                    session.dispose();
                }
                catch
                {
                    /* noop */
                }
                if (report) setTimeout(() => this.emit('terminated', rec.last_code), 0);
            }
        };
        session.stateChange.addListener(listener);
    }

    private wait_active_terminated(timeout_ms: number): Promise<void>
    {
        const session = this.active?.session;
        if (!session) return Promise.resolve();
        return new Promise<void>((resolve) =>
        {
            const t = setTimeout(resolve, timeout_ms);
            const listener = (st: SessionState) =>
            {
                if (st === SessionState.Terminated)
                {
                    clearTimeout(t);
                    session.stateChange.removeListener(listener);
                    resolve();
                }
            };
            session.stateChange.addListener(listener);
        });
    }

    private make_handle(session: Session): CallHandle
    {
        return {
            answer: () =>
                session instanceof Invitation
                    ? session.accept().then(() => undefined)
                    : Promise.reject(new Error('answer только для входящего вызова')),
            reject: (code = 486) =>
                session instanceof Invitation
                    ? session
                          .reject({ statusCode: code, reasonPhrase: 'Busy Here' })
                          .then(() => undefined)
                    : Promise.reject(new Error('reject только для входящего вызова')),
            cancel: () =>
                session instanceof Inviter
                    ? session.cancel().then(() => undefined)
                    : Promise.reject(new Error('cancel только для исходящего вызова')),
            bye: () => session.bye().then(() => undefined),
            wait_terminated: (timeout_ms) => this.wait_active_terminated(timeout_ms),
        };
    }
}
