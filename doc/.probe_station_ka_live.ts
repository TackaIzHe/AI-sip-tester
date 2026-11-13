// Прогон-зонд: слушать keep-alive (OPTIONS) ОТ живой станции pa_sip .157
// на THIS:5060 — мы ведущая станция, регистрация/вызовы нами не инициируются
// (не тест, не в бандле):
//   npx tsx doc/.probe_station_ka_live.ts [секунд_ожидания]
//
// Поднимает боевой эмулятор SipStation (server/station/station.ts) на
// STATION_HOST:STATION_PORT (defaults — 192.168.80.159:5060, udp) и печатает
// каждое обращение станции + итоговые счётчики. Ответы 200/405 шлёт сам
// эмулятор — заодно проверяем, что ответ станции доходит (станция ждёт 200).
// related: server/station/station.ts, doc/task_24_plan_2.md, doc/los_mem/plan_test.md.

import { load_config_from_env } from '../server/config';
import { SipStation } from '../server/station/station';

const wait_s = Number(process.argv[2] ?? '90');

process.env.STATION_HOST ||= '192.168.80.159';
process.env.STATION_PORT ||= '5060';
process.env.STATION_PROTO ||= 'both'; // станция шлёт keep-alive по TCP (стенд, 2026-11-05)

const config = load_config_from_env();
const station = new SipStation(config);

await station.start();
const st = station.status();
console.log(`слушаю ${st.host}:${st.port} (${st.proto}), жду OPTIONS от станции …`);

let printed = 0;
const tick = setInterval(() =>
{
    const events = station.events();
    for (const e of events.slice(0, events.length - printed).reverse())
    {
        console.log(
            `<<< ${e.ts} ${e.proto} ${e.peer} ${e.method || 'мусор'} ` +
                `R-URI='${e.ruri}' CSeq='${e.cseq}' -> ответ ${e.code}`,
        );
    }
    if (events.length > printed) printed = events.length;
}, 2000);

setTimeout(() =>
{
    clearInterval(tick);
    const s = station.status();
    console.log('--- итог ---');
    console.log(JSON.stringify(s.counters, null, 2));
    console.log(`last_keepalive_at=${s.last_keepalive_at} error=${s.error}`);
    void station.stop().then(() => process.exit(0));
}, wait_s * 1000);
