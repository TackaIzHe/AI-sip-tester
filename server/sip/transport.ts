// Абстракция транспорта — перенос task2/src/transport.ts (plan_2.md §2.1):
// SipPhoneClient не знает про sip.js, конкретную реализацию подставляет
// фабрика. Из оригинала убраны фабрика createTransport и ветки ws/wss/bridge:
// режим один — классический SIP через ClassicTransport (server/sip/).

/** Классический транспорт станции (doc/sip_rfc.md §13). */
export type SipTransport = 'udp' | 'tcp';

/** Итог регистрации — строго по финальному ответу станции (doc/sip_rfc.md §5.10). */
export interface RegResult
{
    ok: boolean;
    /** Финальный SIP-код отказа (0, если ответа не было). */
    code: number;
    text: string;
}

/** Управление одним вызовом со стороны транспорта. */
export interface CallHandle
{
    /** Принять входящий (200 OK, doc/sip_rfc.md §5.6). */
    answer(): Promise<void>;
    /** Отклонить входящий с кодом (по умолчанию 486 Busy Here). */
    reject(code?: number): Promise<void>;
    /** CANCEL для неотвеченного исходящего (doc/sip_rfc.md §5.9). */
    cancel(): Promise<void>;
    /** BYE для установленного вызова (doc/sip_rfc.md §5.8). */
    bye(): Promise<void>;
    /** Дождаться завершения вызова (для graceful-отключения), с таймаутом. */
    wait_terminated(timeout_ms: number): Promise<void>;
}

export interface TransportEvents
{
    /** Входящий INVITE. */
    incoming: (peer: string, handle: CallHandle) => void;
    /** 180 Ringing на исходящем. */
    ringing: () => void;
    /** Сессия подтверждена (INVITE→200→ACK). */
    established: () => void;
    /** Вызов завершился; code — финальный SIP-код (0 при штатном BYE). */
    terminated: (code: number) => void;
    /** Транспортное соединение потеряно, идёт реконнект. */
    'transport-lost': (text: string) => void;
    /** Станция сняла/не продлила регистрацию после успеха. */
    'registration-lost': (text: string) => void;
    /** Перерегистрация после реконнекта прошла успешно (восстановление связи). */
    registered: () => void;
}

export type TransportEventName = keyof TransportEvents;

export interface Transport
{
    /** Поднять транспорт/UA (без REGISTER). Ошибку — reject. */
    connect(): Promise<void>;
    /** Полностью закрыть всё, завершив активный вызов. */
    disconnect(): Promise<void>;
    /** REGISTER; резолвится ПОСЛЕ финального ответа станции. */
    register(): Promise<RegResult>;
    /** REGISTER expires=0 (UA при этом остаётся до disconnect). */
    unregister(): Promise<void>;
    /** Отправить INVITE на номер; события — через on(). */
    call(target: string): CallHandle;
    /** Подписка на события; возвращает отписку. */
    on<K extends TransportEventName>(event: K, cb: TransportEvents[K]): () => void;
}
