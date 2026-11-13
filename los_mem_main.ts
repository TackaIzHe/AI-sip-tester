// CLI генератора стимулов тестов локализации утечки памяти (doc/los_mem/
// plan_test.md, сценарии T1–T8):
//
//   npx tsx los_mem_main.ts t1 [флаги]      — один сценарий
//   npx tsx los_mem_main.ts --list          — список сценариев и флагов
//
// Вердикта нет (решение оператора, doc/task_22_plan_2.md): сценарий генерирует
// стимул, пишет фазовые метки и счётчики в CSV (сшивка «память/пакеты» по
// времени, план §2.2) и завершается кодом 0. Ctrl-C — досрочная остановка с
// graceful-зачисткой (unsubscribe/закрытие сокетов), тоже код 0.
//
// Конфиг АТС — только .env через server/config.ts (инвариант «единой точки»);
// номера/пароли берутся из AppConfig.subscribers. Флаги (значение через '='):
//   --minutes=N  длительность стимула   --rate=X   темп, сообщений/с
//   --target=host:port  куда слать (по умолчанию PBX из .env)
//   --variant=a..f|all  T1/T8: тела dialog-info   --kind=value|name|hybrid T2
//   --props=N  T2: свойств в NOTIFY      --cycles=N --pause=S  T3
//   --provider-port=N  T4: порт «провайдера-401»  --observe-min=N  T5
//   --count=N --ipc-cmd=str  T6          --domain=d  T7
//   --csv=path|off  CSV-журнал (по умолчанию reports/los_<id>_<UTC>.csv)
// Короткие версии этих же сценариев живут в реестре CASES (терминал
// `test t1..t8`, вкладка «Тесты») — там без флагов, ~1 мин; длительности
// и варианты — только этим CLI.
// related: server/los_mem/scenarios.ts (сценарии), server/los_mem/csv_log.ts,
// e2e_runner.ts (кейсы t1..t8), server/config.ts, doc/los_mem/plan_test.md §2–§3.

import path from 'node:path';
import { load_config_from_env } from './server/config';
import { utc_stamp } from './server/journal';
import { CsvLog } from './server/los_mem/csv_log';
import {
    BASE_SCENARIO_OPTS,
    LOS_SCENARIOS,
    type ScenarioCtx,
    type ScenarioOpts,
} from './server/los_mem/scenarios';

/** Разбор argv: id сценария + флаги `--имя=значение`. */
function parse_cli(argv: string[]): { id?: string; flags: Map<string, string> }
{
    const flags = new Map<string, string>();
    let id: string | undefined;
    for (const arg of argv)
    {
        const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
        if (m) flags.set(m[1], m[2] ?? '1');
        else if (!id) id = arg.toLowerCase();
        else throw new Error(`лишний позиционный аргумент «${arg}»`);
    }
    return { id, flags };
}

/** Числовой флаг; не число — fall back на дефолт с предупреждением в лог. */
function num_flag(
    flags: Map<string, string>,
    name: string,
    current: number,
    log: (text: string) => void,
): number
{
    const raw = flags.get(name);
    if (raw === undefined) return current;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0)
    {
        log(`флаг --${name}=${raw} не число >0 — оставляю ${current}`);
        return current;
    }
    return n;
}

function usage(): string
{
    const lines = ['сценарии (npx tsx los_mem_main.ts <id> [флаги]):'];
    for (const [id, def] of Object.entries(LOS_SCENARIOS))
    {
        lines.push(`  ${id.padEnd(4)} ${def.title} (${def.plan_ref})`);
    }
    lines.push('флаги: --help (этот список), --list, и из шапки файла;');
    lines.push('пример быстрого прогона: t1 --minutes=1 --variant=all');
    return lines.join('\n');
}

async function main(): Promise<void>
{
    const { id, flags } = parse_cli(process.argv.slice(2));
    const log = (text: string): void =>
    {
        console.log(`[${new Date().toISOString()}] ${text}`);
    };
    if (!id || id === '--help' || flags.has('help') || flags.has('list'))
    {
        console.log(usage());
        process.exit(0);
    }
    const def = LOS_SCENARIOS[id];
    if (!def)
    {
        console.error(`неизвестный сценарий «${id}»;\n${usage()}`);
        process.exit(1);
    }

    const config = load_config_from_env();
    // Слияние: базы → дефолты сценария (по плану §3) → явные флаги CLI.
    const opts: ScenarioOpts = { ...BASE_SCENARIO_OPTS, ...def.defaults };
    opts.minutes = num_flag(flags, 'minutes', opts.minutes, log);
    opts.rate = num_flag(flags, 'rate', opts.rate, log);
    opts.props = num_flag(flags, 'props', opts.props, log);
    opts.cycles = num_flag(flags, 'cycles', opts.cycles, log);
    opts.pause_s = num_flag(flags, 'pause', opts.pause_s, log);
    opts.provider_port = num_flag(flags, 'provider-port', opts.provider_port, log);
    opts.observe_min = num_flag(flags, 'observe-min', opts.observe_min, log);
    opts.count = num_flag(flags, 'count', opts.count, log);
    if (flags.get('variant')) opts.variant = flags.get('variant') as string;
    if (flags.get('kind')) opts.kind = flags.get('kind') as string;
    if (flags.get('domain')) opts.domain = flags.get('domain') as string;
    if (flags.get('ipc-cmd')) opts.ipc_cmd = flags.get('ipc-cmd');
    const target_flag = flags.get('target');
    const target = target_flag
        ? {
              host: target_flag.split(':')[0],
              port: Number(target_flag.split(':')[1] ?? config.pbx_port),
          }
        : { host: config.pbx_host, port: config.pbx_port };

    const reports_dir = path.resolve('reports');
    const csv_off = flags.get('csv') === 'off';
    const csv_path =
        flags.get('csv') && !csv_off
            ? path.resolve(flags.get('csv') as string)
            : path.join(reports_dir, `los_${id}_${utc_stamp(Date.now())}.csv`);
    const csv = csv_off ? undefined : new CsvLog(csv_path, id);

    let stopped = false;
    const on_sigint = (): void =>
    {
        if (stopped) return; // второй Ctrl-C — не перебиваем зачистку
        stopped = true;
        log('SIGINT — останавливаю стимул и зачищаю…');
    };
    process.on('SIGINT', on_sigint);

    const ctx: ScenarioCtx = {
        config,
        target,
        via_host: config.bridge_host,
        reports_dir,
        opts,
        log,
        phase: (name) =>
        {
            log(`фаза: ${name}`);
            csv?.row('phase', name);
        },
        tick: (sent) => csv?.row('tick', String(sent)),
        stopped: () => stopped,
    };

    log(
        `${def.title}; цель ${target.host}:${target.port} (${config.sip_protocol}), ` +
            `Via/Contact от ${config.bridge_host}; ` +
            `CSV: ${csv_off ? 'выключен' : csv_path}`,
    );
    const started = Date.now();
    const summary = await def.run(ctx);
    const secs = Math.round((Date.now() - started) / 1000);
    csv?.row('summary', summary);
    csv?.close();
    log(`итог (${secs} с): ${summary}`);
    if (csv) log(`CSV-журнал: ${csv.file_path}`);
    process.exit(0); // вердикта нет — успех = «стимул сгенерирован» (см. шапку)
}

main().catch((e: unknown) =>
{
    // Ошибки сокета/конфига — единственный не-нулевой выход (вердикта прогону
    // нет — см. шапку файла).
    console.error('ошибка: ' + (e instanceof Error ? (e.stack ?? e.message) : String(e)));
    process.exit(1);
});
