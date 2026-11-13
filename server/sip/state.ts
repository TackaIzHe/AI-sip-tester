// Стейт-машина телефона — перенос task2/src/state.ts без смены логики
// (plan_2.md §2.1). Виртуальный абонент сервера — «телефон»: состояния
// общие для пула, сессий моста и e2e-раннера. Тесты — tests/unit/state.test.ts.

/** Состояния телефона; таблица переходов ниже, тесты — tests/unit/state.test.ts. */
export type PhoneState =
    'UNREGISTERED' | 'REGISTERED' | 'CALL_OUT' | 'CALL_IN' | 'IN_CALL';

/** Единственное состояние абонента: снапшот рендерится/публикуется только из него. */
export interface PhoneSnapshot
{
    state: PhoneState;
    /** Номер собеседника (для вызовов). */
    peer: string;
    /** Текст ошибки/причины (SIP-код + описание). */
    error: string;
    /** Начало разговора, мс (для таймера), 0 если не в разговоре. */
    call_started_at: number;
    /** Регистрация выполняется (REGISTER отправлен, ответа нет). */
    registering: boolean;
    /** Получен 180 Ringing на исходящем вызове («гудки»). */
    ringing: boolean;
}

// Разрешённые переходы; IN_CALL -> REGISTERED = завершение вызова.
const TRANSITIONS: Record<PhoneState, PhoneState[]> = {
    UNREGISTERED: ['REGISTERED', 'UNREGISTERED'],
    REGISTERED: ['UNREGISTERED', 'CALL_OUT', 'CALL_IN', 'REGISTERED'],
    CALL_OUT: ['REGISTERED', 'IN_CALL', 'UNREGISTERED', 'CALL_OUT'],
    CALL_IN: ['REGISTERED', 'IN_CALL', 'UNREGISTERED', 'CALL_IN'],
    IN_CALL: ['REGISTERED', 'UNREGISTERED', 'IN_CALL'],
};

/** Подписчик на изменения снапшота. */
export type Listener = (s: PhoneSnapshot) => void;

/**
 * Машина состояний телефона: хранит PhoneSnapshot, отсекает запрещённые
 * переходы и уведомляет подписчиков. Используется и в сессиях моста
 * (server/sip/session.ts), и в пуле виртуальных абонентов (server/sip_pool.ts) —
 * отсюда 1:1 состояний протокола v:1.
 */
export class PhoneStateMachine
{
    private snap: PhoneSnapshot = {
        state: 'UNREGISTERED',
        peer: '',
        error: '',
        call_started_at: 0,
        registering: false,
        ringing: false,
    };
    private listeners = new Set<Listener>();

    /** Текущий снапшот; set()/patch() заменяют объект целиком, старые ссылки валидны. */
    get snapshot(): Readonly<PhoneSnapshot>
    {
        return this.snap;
    }

    /** Подписка: вызывает fn сразу и на каждое изменение; возвращает отписку. */
    subscribe(fn: Listener): () => void
    {
        this.listeners.add(fn);
        fn(this.snap);
        return () => this.listeners.delete(fn);
    }

    /** Смена состояния; возвращает false, если переход запрещён. */
    set(next: PhoneState, patch: Partial<Omit<PhoneSnapshot, 'state'>> = {}): boolean
    {
        if (next !== this.snap.state && !TRANSITIONS[this.snap.state].includes(next))
        {
            return false;
        }
        this.snap = {
            ...this.snap,
            ...patch,
            state: next,
            peer:
                next === 'CALL_OUT' || next === 'CALL_IN' || next === 'IN_CALL'
                    ? (patch.peer ?? (next === 'IN_CALL' ? this.snap.peer : ''))
                    : '',
            error: patch.error ?? '',
            ringing: next === 'CALL_OUT' ? (patch.ringing ?? false) : false,
            call_started_at:
                next === 'IN_CALL'
                    ? this.snap.call_started_at || patch.call_started_at || Date.now()
                    : 0,
        };
        this.emit();
        return true;
    }

    /** Обновление доп. полей без смены состояния (например, текст ошибки). */
    patch(patch: Partial<Omit<PhoneSnapshot, 'state'>>): void
    {
        this.snap = { ...this.snap, ...patch };
        this.emit();
    }

    private emit(): void
    {
        for (const fn of this.listeners) fn(this.snap);
    }
}
