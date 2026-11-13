// Прогон-зонд критерия plan_2.md п.4 против ЖИВОЙ АТС (не тест, не в бандле):
//   npx tsx doc/.probe_pool.ts
// Схема — как doc/.probe-call.py: REGISTER 9404 (пароль из .env) с Digest,
// повторный register идемпотентен, unregister expires=0. Цепочка этапов —
// в журнал (onTrace), печатается здесь.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load_config_from_env } from '../server/config';
import { Journal } from '../server/journal';
import { SipSubscriberPool } from '../server/sip_pool';

const app = load_config_from_env();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-probe-'));
const journal = new Journal({ reports_dir: tmp });
const pool = new SipSubscriberPool(app, journal);
const number = app.subscribers[0].number; // образец — 9404

async function main(): Promise<void>
{
    console.log(
        `[probe] АТС ${app.pbx_host}:${app.pbx_port} (${app.sip_protocol}), ` +
            `абонент ${number}`,
    );

    const t0 = Date.now();
    const first = await pool.register_subscriber(number);
    console.log(`[probe] register #1: ok=${first.ok} за ${Date.now() - t0} мс`);
    console.log('[probe] статусы:', JSON.stringify(pool.list_subscribers(), null, 2));

    const t1 = Date.now();
    const again = await pool.register_subscriber(number);
    console.log(
        `[probe] register #2 (идемпотентность): ok=${again.ok} за ${Date.now() - t1} мс`,
    );

    await pool.unregister(number);
    console.log('[probe] unregister выполнен');

    const chain = journal.events
        .filter((e) => e.kind === 'register' || e.kind === 'state')
        .map(
            (e) =>
                `${e.direction} ${e.kind}` +
                `${e.sip_code ? ' ' + e.sip_code : ''} — ${e.detail}`,
        );
    console.log('[probe] цепочка журнала:\n' + chain.map((s) => '  ' + s).join('\n'));
    console.log('[probe] итог:', JSON.stringify(pool.list_subscribers()[0]));
}

main()
    .then(() => process.exit(0))
    .catch((e) =>
    {
        console.error('[probe] FAIL:', e);
        process.exit(1);
    });
