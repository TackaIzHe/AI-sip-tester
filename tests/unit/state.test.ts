// Юнит-тесты таблицы переходов PhoneStateMachine (server/sip/state.ts) —
// перенос task2/tests/state.test.ts: запрещённые переходы отсекаются, поля
// снапшота (peer/error/timer) живут по состоянию. Гард переноса (plan_2.md §2,
// критерий): менять переходы можно только здесь. Стенд не нужен — чистая
// логика, нод-независимая. Запуск: npm run test:unit.

import { describe, expect, it } from 'vitest';
import { PhoneStateMachine } from '../../server/sip/state';

describe('PhoneStateMachine', () =>
{
    it('стартовое состояние UNREGISTERED', () =>
    {
        const sm = new PhoneStateMachine();
        expect(sm.snapshot.state).toBe('UNREGISTERED');
    });

    it('полный цикл исходящего вызова', () =>
    {
        const sm = new PhoneStateMachine();
        expect(sm.set('REGISTERED')).toBe(true);
        expect(sm.set('CALL_OUT', { peer: '1002' })).toBe(true);
        expect(sm.snapshot.peer).toBe('1002');
        expect(sm.set('IN_CALL')).toBe(true);
        expect(sm.snapshot.peer).toBe('1002');
        expect(sm.snapshot.call_started_at).toBeGreaterThan(0);
        expect(sm.set('REGISTERED')).toBe(true);
        expect(sm.snapshot.peer).toBe('');
        expect(sm.snapshot.call_started_at).toBe(0);
    });

    it('входящий вызов: CALL_IN -> IN_CALL', () =>
    {
        const sm = new PhoneStateMachine();
        sm.set('REGISTERED');
        expect(sm.set('CALL_IN', { peer: '1001' })).toBe(true);
        expect(sm.set('IN_CALL')).toBe(true);
        expect(sm.snapshot.peer).toBe('1001');
    });

    it('нельзя позвонить без регистрации', () =>
    {
        const sm = new PhoneStateMachine();
        expect(sm.set('CALL_OUT', { peer: '1002' })).toBe(false);
        expect(sm.snapshot.state).toBe('UNREGISTERED');
    });

    it('нельзя войти в IN_CALL минуя CALL_*', () =>
    {
        const sm = new PhoneStateMachine();
        sm.set('REGISTERED');
        expect(sm.set('IN_CALL')).toBe(false);
        expect(sm.snapshot.state).toBe('REGISTERED');
    });

    it('из вызова разрешён сброс в UNREGISTERED', () =>
    {
        const sm = new PhoneStateMachine();
        sm.set('REGISTERED');
        sm.set('CALL_OUT', { peer: '1' });
        expect(sm.set('UNREGISTERED', { error: 'сеть потеряна' })).toBe(true);
        expect(sm.snapshot.error).toBe('сеть потеряна');
    });

    it('подписчик получает каждое изменение', () =>
    {
        const sm = new PhoneStateMachine();
        const seen: string[] = [];
        const un = sm.subscribe((s) => seen.push(s.state));
        sm.set('REGISTERED');
        un();
        sm.set('UNREGISTERED');
        expect(seen).toEqual(['UNREGISTERED', 'REGISTERED']);
    });
});
