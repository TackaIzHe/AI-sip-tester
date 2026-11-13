// SipPhoneClient — тонкая машина состояний поверх абстракции Transport
// (перенос task2/src/sipClient.ts, plan_2.md §2.1). Про sip.js здесь ничего
// не известно: транспорт подставляет фабрика. Фабрика теперь обязательна —
// дефолтной ws/bridge-фабрики из task2 больше нет (режим один, ClassicTransport).

import type { PhoneConfig } from './config';
import { sip_status_text } from './sip_text';
import type { PhoneStateMachine } from './state';
import type { CallHandle, RegResult, Transport } from './transport';

export { SIP_STATUS_TEXT, sip_status_text } from './sip_text';

export class SipPhoneClient
{
    private transport?: Transport;
    private handle?: CallHandle;
    private manual_stop = false;
    private transport_lost = false;
    /** Мы сами отменили исходящий (cancel) — 487/491 не считается ошибкой (BUG-5). */
    private locally_cancelled = false;
    private unsubs: Array<() => void> = [];
    /** Итог последней регистрации — нужен, напр., мосту для события error{code}. */
    last_reg?: RegResult;

    /**
     * @param factory — фабрика транспорта; сервер (sip_pool, session) подставляет
     * классический SIP-транспорт ClassicTransport.
     */
    constructor(
        private readonly sm: PhoneStateMachine,
        private readonly factory: (cfg: PhoneConfig) => Transport,
    )
    {}

    get busy(): boolean
    {
        const s = this.sm.snapshot.state;
        return s === 'CALL_OUT' || s === 'CALL_IN' || s === 'IN_CALL';
    }

    // ---------- регистрация ----------

    async register(cfg: PhoneConfig): Promise<void>
    {
        await this.drop_transport();
        this.manual_stop = false;
        this.transport_lost = false;
        this.locally_cancelled = false;

        let transport: Transport;
        try
        {
            transport = this.factory(cfg);
        }
        catch (e)
        {
            this.sm.set('UNREGISTERED', { error: (e as Error).message });
            return;
        }
        this.transport = transport;
        this.wire(transport);
        this.sm.patch({ registering: true, error: '' });

        try
        {
            try
            {
                await transport.connect();
            }
            catch (e)
            {
                this.sm.set('UNREGISTERED', { error: (e as Error).message });
                await this.drop_transport();
                return; // BUG-4: registering сбрасывается в finally
            }
            // резолвится по финальному ответу станции
            const res = await transport.register();
            this.last_reg = res;
            if (res.ok)
            {
                this.sm.set('REGISTERED');
            }
            else
            {
                await this.drop_transport();
                this.sm.set('UNREGISTERED', {
                    error: res.text || 'Не удалось зарегистрироваться',
                });
            }
        }
        finally
        {
            this.sm.patch({ registering: false });
        }
    }

    async unregister(): Promise<void>
    {
        this.manual_stop = true;
        await this.drop_transport(); // внутри — graceful BYE/CANCEL (BUG-7)
        this.sm.set('UNREGISTERED', { error: '' });
    }

    private wire(t: Transport): void
    {
        this.unsubs.push(
            t.on('incoming', (peer, handle) =>
            {
                this.handle = handle;
                if (this.sm.snapshot.state !== 'REGISTERED')
                {
                    // BUG-9: объясняем пользователю молчаливый 486.
                    if (this.sm.snapshot.registering)
                    {
                        this.sm.patch({
                            error: 'Входящий вызов отклонён: идёт подключение к станции',
                        });
                    }
                    handle.reject(486).catch(() => this.forget());
                    return;
                }
                this.sm.set('CALL_IN', { peer });
            }),
            t.on('ringing', () => this.sm.patch({ ringing: true })),
            t.on('established', () => this.sm.set('IN_CALL')),
            t.on('terminated', (code) =>
            {
                this.handle = undefined;
                if (this.transport_lost || this.manual_stop) return;
                const suppress = this.locally_cancelled && (code === 487 || code === 491);
                this.locally_cancelled = false;
                if (this.sm.snapshot.state !== 'UNREGISTERED')
                {
                    // Свой отбой (suppress) — чистый статус; иначе текст уже имеющейся
                    // ошибки или расшифровка финального SIP-кода.
                    const error = suppress
                        ? ''
                        : this.sm.snapshot.error || (code ? sip_status_text(code) : '');
                    this.sm.set('REGISTERED', { error });
                }
            }),
            t.on('transport-lost', (text) =>
            {
                this.transport_lost = true;
                this.handle = undefined;
                this.sm.set('UNREGISTERED', { error: text });
            }),
            t.on('registration-lost', (text) =>
            {
                if (this.manual_stop) return;
                this.handle = undefined;
                this.sm.set('UNREGISTERED', { error: text });
            }),
            t.on('registered', () =>
            {
                if (this.manual_stop) return;
                this.transport_lost = false;
                this.sm.set('REGISTERED');
            }),
        );
    }

    private async drop_transport(): Promise<void>
    {
        for (const u of this.unsubs) u();
        this.unsubs = [];
        const t = this.transport;
        this.transport = undefined;
        this.handle = undefined;
        try
        {
            await t?.disconnect();
        }
        catch
        {
            /* noop */
        }
    }

    // ---------- вызовы ----------

    call(target: string): void
    {
        const s = this.sm.snapshot.state;
        if (!this.transport || s !== 'REGISTERED') return;
        this.locally_cancelled = false;
        try
        {
            this.handle = this.transport.call(target);
        }
        catch (e)
        {
            this.sm.patch({ error: (e as Error).message });
            return;
        }
        this.sm.set('CALL_OUT', { peer: target });
    }

    answer(): void
    {
        this.handle
            ?.answer()
            .catch(() => this.sm.patch({ error: 'Не удалось принять вызов' }));
    }

    reject_incoming(): void
    {
        this.handle?.reject(486).catch(() => this.forget());
    }

    hangup(): void
    {
        const s = this.sm.snapshot.state;
        if (s === 'CALL_OUT' && this.handle)
        {
            this.locally_cancelled = true; // BUG-5: свой отбой не должен оставлять «487»
            this.handle.cancel().catch(() => this.forget());
            return;
        }
        if (s === 'CALL_IN')
        {
            // BUG-6: отбой неотвеченного входящего = reject(486), не bye().
            this.reject_incoming();
            return;
        }
        this.handle?.bye().catch(() => this.forget());
    }

    /** Локальный разрыв без graceful-сигнализации (ошибка транспорта). */
    private forget(): void
    {
        this.handle = undefined;
    }
}
