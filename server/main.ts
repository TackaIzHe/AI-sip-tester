// Бутстрап сервера (plan_2.md п.5, п.7): конфиг → журнал → пул абонентов →
// express (app.ts, routes.ts) → listen SERVER_PORT → REPL-терминал
// (terminal.ts: test/status/help/quit) поверх того же пула. WS-мост —
// отдельный процесс `npx tsx bridge_main.ts` (п.2.3).
// related: server/config.ts (единая точка .env), doc/task_5_plan_2.md,
// doc/task_7_plan_2.md.

import { close_batch_pool } from '../e2e_runner';
import { create_app } from './app';
import { load_config_from_env } from './config';
import { Journal } from './journal';
import { SipSubscriberPool } from './sip_pool';
import { SipStation } from './station/station';
import { StationOutbound } from './station/outbound';
import { StationRegistrations } from './station/registrations';
import { StationSas } from './station/sas';
import { StationStimulus } from './station/stimulus';
import { start_terminal } from './terminal';

const config = load_config_from_env();
const journal = new Journal();
const pool = new SipSubscriberPool(config, journal);
// Станция-эмулятор (plan_4.md): только wire-up — слушатель поднимается
// исключительно кнопкой со вкладки «Станция» (POST /api/station/start).
const station = new SipStation(config);
// Движок стимулов утечки (doc/task_26): T1–T8 уходят через сокет станции;
// запуск только с вкладки, POST /api/station/stimulus.
const stimulus = new StationStimulus(config, station);
// Движок SAS-режима (план 6): NOTIFY идут через сокет станции; включение
// только с вкладки, POST /api/station/sas/enable.
const sas = new StationSas(config, station);
// Движок исходящего вызова (doc/task_30_plan_2.md): INVITE/UAC идёт через
// сокет станции; набор только с вкладки «Вызов», POST /api/station/call.
const outbound = new StationOutbound(config, station);
// Таблица регистраций нижестоящей станции (doc/task_33_plan_2.md): автозаполняется
// из REGISTER в SAS-режиме, правится с вкладки «Регистрации»; хранилище — память
// процесса (как прогоны test_runs). Тот же источник маршрутизации перенаправляемых
// INVITE (doc/task_34_plan_2.md): движок вызова берёт из неё адресат,
// идентификатор линии и номер звонящего.
const registrations = new StationRegistrations();
station.attach_registrations(registrations);
outbound.attach_registrations(registrations);
const app = create_app({
    config,
    pool,
    journal,
    station,
    stimulus,
    sas,
    outbound,
    registrations,
});

const server = app.listen(config.server_port, () =>
{
    console.log(
        `[sip-atc] HTTP :${config.server_port}; АТС ` +
            `${config.pbx_host}:${config.pbx_port} ` +
            `(${config.sip_protocol}); абоненты: ` +
            config.subscribers
                .map((s) => s.number + (s.can_register ? '' : '(только вызов)'))
                .join(', '),
    );
});

// Терминал (п.7): `test <1..4|all>` гоняет общий e2e_runner, `quit` — тот же
// graceful-путь, что и сигналы (unregister всех → закрыть http).
const repl = start_terminal({ config, pool, journal, on_quit: () => shutdown('quit') });

// Ошибка транспорта слушателя (EADDRINUSE и пр.) иначе долетает до node:events
// как необработанный 'error' и роняет процесс с трейсом вместо сообщения
// (лог error.md): порт занимает прежний запуск сервера. Обработчик навешан
// после start_terminal — 'error' приходит асинхронно, repl к этому моменту
// уже создан; снимаем приглашение (readline в terminal-режиме иначе оставит
// кривой терминал) и выходим с кодом 1: регистраций на этом этапе ещё нет,
// полный graceful-путь shutdown() не нужен, а код 1 виден скриптам.
server.on('error', (e: NodeJS.ErrnoException) =>
{
    if (e.code === 'EADDRINUSE')
    {
        console.error(
            `[sip-atc] порт ${config.server_port} уже занят — завершите ` +
                'прежний запуск сервера или смените SERVER_PORT в .env',
        );
    }
    else
    {
        console.error(`[sip-atc] ошибка HTTP-сервера: ${e.message}`);
    }
    repl.close();
    process.exit(1);
});

// graceful shutdown: снять регистрацию (REGISTER expires=0) и закрыть HTTP.
// Один путь для quit и сигналов — иначе `quit` оставлял регистрации висеть.
// close_batch_pool — то же для живущего пула диапазона 24..47 (case_8a мог
// оставить его живым без case_8b, doc/task_21_plan_2.md): 24 unregister'а
// могут не влезть в 3 с ниже — снятый хвост уходит по expires станции.
let stopping = false;
function shutdown(reason: string): void
{
    if (stopping) return;
    stopping = true;
    console.log(`[sip-atc] ${reason}, завершаю…`);
    repl.close();
    // Исходящий вызов (doc/task_30_plan_2.md) гасится ПЕРВЫМ: его CANCEL/BYE
    // идут через сокет станции, а abort() синхронен — обязан снять хук и
    // таймеры до остановки слушателя.
    outbound.abort();
    // stop() на нестартовавшей станции — no-op (идемпотентность, plan_4.md п.1).
    // Стимул (doc/task_26) гасится ПЕРЕД снятием слушателя: его graceful-зачистка
    // (unsubscribe/unreg) шлёт через сокет станции — иначе отправка упадёт на
    // закрытом сокете. Без прогона stop() не вызываем (idle — бросает).
    const stimulus_stop =
        stimulus.status().state === 'idle'
            ? Promise.resolve()
            : stimulus.stop().catch(() => undefined);
    // SAS-движок (план 6): снимает таймер/хук/флаг синхронно — до stop(),
    // иначе SAS-флаг станции пережил бы останов (off по смыслу shutdown).
    if (sas.status().state === 'on') sas.disable();
    void Promise.all([
        pool.close(),
        close_batch_pool(),
        stimulus_stop.then(() => station.stop()),
    ]).finally(() => server.close(() => process.exit(0)));
    setTimeout(() => process.exit(0), 3000).unref();
}

for (const sig of ['SIGINT', 'SIGTERM'] as const)
{
    process.on(sig, () => shutdown(sig));
}
