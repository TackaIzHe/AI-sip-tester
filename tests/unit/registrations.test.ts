// Юнит-тесты хранилища таблицы регистраций (server/station/registrations.ts,
// doc/task_33_plan_2.md) — чистая логика, без сети: ручные строки (add с
// уникальным identifier, дубль → Error), правки по стабильному id (телефон,
// смена identifier, занятость → Error, нет id → undefined), удаление,
// идемпотентный upsert record() (адрес/время обновляются, телефон оператора
// и id сохраняются; новый identifier → новая строка; пустой — no-op) и то,
// что наружу уходят только копии записей. Запуск: npm run test:unit.
// related: server/station/registrations.ts, tests/unit/station_registrations.test.ts
// (связка с REGISTER станции), doc/task_33_plan_2.md.

import { describe, expect, it } from 'vitest';
import { StationRegistrations } from '../../server/station/registrations';

describe('StationRegistrations: ручные строки (add/update/remove)', () =>
{
    it('add присваивает стабильный id и пустые адрес/время', () =>
    {
        const store = new StationRegistrations();
        const reg = store.add('u00s00p00', '100');
        expect(reg).toEqual({
            id: 1,
            identifier: 'u00s00p00',
            phone: '100',
            address: '',
            last_seen_at: '',
        });
        expect(store.list().map((e) => e.id)).toEqual([1]);
    });

    it('дубль identifier → Error с русским текстом (→ 409 контроллера)', () =>
    {
        const store = new StationRegistrations();
        store.add('u00s00p00', '');
        expect(() => store.add('u00s00p00', '200')).toThrow(/уже есть/);
        // регистр значим: «U00S00P00» — другая строка (без нормализации)
        expect(() => store.add('U00S00P00', '')).not.toThrow();
    });

    it('update правит поля по id; нет id → undefined; identifier занят → Error', () =>
    {
        const store = new StationRegistrations();
        const a = store.add('u00s00p00', '');
        const b = store.add('u00s00p01', '200');
        // правка телефона; id стабилен
        const upd = store.update(a.id, { phone: '100' });
        expect(upd).toMatchObject({ id: a.id, phone: '100' });
        // смена identifier на свободный — ок
        expect(store.update(a.id, { identifier: 'u00s00p09' })).toMatchObject({
            identifier: 'u00s00p09',
        });
        // занятый identifier другой строки — Error, строка не тронута
        expect(() => store.update(a.id, { identifier: 'u00s00p01' })).toThrow(
            /занят строкой/,
        );
        expect(store.list().find((e) => e.id === b.id)?.identifier).toBe('u00s00p01');
        // того же identifier та же строка — не занятость (идемпотентная правка)
        expect(store.update(b.id, { identifier: 'u00s00p01' })).toMatchObject({
            identifier: 'u00s00p01',
        });
        expect(store.update(999, { phone: '1' })).toBeUndefined();
    });

    it('remove — true/false; id не переиспользуются после удаления', () =>
    {
        const store = new StationRegistrations();
        const a = store.add('u00s00p00', '');
        expect(store.remove(a.id)).toBe(true);
        expect(store.remove(a.id)).toBe(false);
        expect(store.add('u00s00p00', '').id).toBe(a.id + 1);
    });

    it('list отдаёт копии: правка выданной строки не меняет хранилище', () =>
    {
        const store = new StationRegistrations();
        store.add('u00s00p00', '100');
        const got = store.list();
        got[0].phone = 'МИМО';
        expect(store.list()[0].phone).toBe('100');
    });
});

describe('StationRegistrations: record (upsert из REGISTER)', () =>
{
    it('новый identifier → новая строка с адресом и временем, телефон пуст', () =>
    {
        const store = new StationRegistrations();
        store.record('u00s34p00', '192.168.80.157:5060');
        const list = store.list();
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({
            identifier: 'u00s34p00',
            phone: '',
            address: '192.168.80.157:5060',
        });
        expect(Date.parse(list[0].last_seen_at)).not.toBeNaN();
    });

    it('re-REGISTER: адрес/время обновляются, телефон оператора и id сохраняются', async () =>
    {
        const store = new StationRegistrations();
        const manual = store.add('u00s00p00', '100');
        store.record('u00s00p00', '192.168.80.133:5060');
        const first = store.list()[0];
        expect(first).toMatchObject({
            id: manual.id,
            phone: '100',
            address: '192.168.80.133:5060',
        });
        // retransmit/refresh — тот же upsert: строка одна, id прежний,
        // last_seen_at сдвигается (пауза — чтобы ISO-время точно отличалось)
        await new Promise((r) => setTimeout(r, 1100));
        store.record('u00s00p00', '192.168.80.133:5061');
        const again = store.list();
        expect(again).toHaveLength(1);
        expect(again[0].id).toBe(manual.id);
        expect(again[0].address).toBe('192.168.80.133:5061');
        expect(Date.parse(again[0].last_seen_at)).toBeGreaterThan(
            Date.parse(first.last_seen_at),
        );
    });

    it('пустой identifier — no-op (R-URI без user — не линия)', () =>
    {
        const store = new StationRegistrations();
        store.record('', '10.0.0.1:5060');
        expect(store.list()).toHaveLength(0);
    });
});
