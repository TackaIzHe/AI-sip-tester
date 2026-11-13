// Терминал сервера (plan_2.md п.7): readline-REPL поверх того же пула и
// журнала, что и REST API (общее состояние — PhoneSnapshot, инвариант №1).
// Команды: `test <1..5|noanswer|caller|batch24reg|batch24unreg|t1..t8|all>` —
// тот же e2e_runner, что и у POST /api/test_runs (п.8: шаги — в stdout,
// отчёт — в reports/); `all` — только основные кейсы, стимулы t1..t8 вне
// него (e2e_runner.cases_for_all).
// `status` (регистрации + активные вызовы), `help`, `quit` (graceful:
// unregister всех → закрыть http).
//
// Терминал НЕ знает про express и не владеет жизненным циклом процесса: выход
// — через DI-колбэк on_quit (main.ts снимает регистрацию и закрывает сервер).
// Команды сериализуются очередью, чтобы параллельные строки не перемешивали
// прогоны. related: e2e_runner.ts (раннер), server/main.ts (wire-up).

import * as readline from 'node:readline';
import type { AppConfig } from './config';
import type { Journal } from './journal';
import type { SipPool } from './sip_pool';
import { cases_for_all, implemented_cases, run_case } from '../e2e_runner';

/** Зависимости терминала (в бою — из main.ts; input/output — для тестов REPL). */
export interface TerminalDeps
{
    config: AppConfig;
    pool: SipPool;
    journal: Journal;
    /** Graceful-завершение по `quit`: unregister всех → закрыть http/процесс. */
    on_quit: () => void | Promise<void>;
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
}

/** Состояния абонентов и активные вызовы одной строкой на строку вывода. */
function render_status(pool: SipPool): string[]
{
    const lines: string[] = ['Абоненты:'];
    for (const s of pool.list_subscribers())
    {
        const reg = s.can_register ? '' : ' (только цель вызова)';
        const extra = s.registering
            ? ', регистрация…'
            : s.error
              ? `, ошибка: ${s.error}`
              : '';
        lines.push(`  ${s.number.padEnd(6)} ${s.state}${reg}${extra}`);
    }
    const active = pool.list_calls().filter((c) => c.ended_at === 0);
    lines.push(active.length ? 'Активные вызовы:' : 'Активных вызовов нет.');
    for (const c of active)
    {
        lines.push(
            `  ${c.call_id}  ${c.from} → ${c.to}  [${c.state}] ` +
                `(${c.direction === 'out' ? 'исходящий' : 'входящий'})`,
        );
    }
    return lines;
}

/**
 * Поднять REPL-терминал. Возвращает интерфейс (main.ts может закрыть его при
 * сигнале). readline сам печатает приглашение `sip> `; команды обрабатываются
 * последовательно через очередь промисов.
 */
export function start_terminal(deps: TerminalDeps): readline.Interface
{
    const out = deps.output ?? process.stdout;
    const rl = readline.createInterface({
        input: (deps.input ?? process.stdin) as NodeJS.ReadableStream,
        output: out as NodeJS.WritableStream,
        prompt: 'sip> ',
        terminal: deps.input === undefined && deps.output === undefined,
    });
    function write(s = ''): void
    {
        out.write(s + '\n');
    }

    // `test <…|all>`: прогон кейсов (реестр — e2e_runner.CASES, для `all` —
    // cases_for_all без стимулов); шаги и вердикт — в stdout.
    async function do_test(arg: string | undefined): Promise<void>
    {
        if (!arg)
        {
            write(`использование: test <${implemented_cases().join('|')}|all>`);
            return;
        }
        const wanted = arg === 'all' ? cases_for_all() : [arg];
        if (arg !== 'all' && !implemented_cases().includes(arg))
        {
            write(`кейс ${arg} не найден (доступны: ${implemented_cases().join(', ')})`);
            return;
        }
        for (const id of wanted)
        {
            write(`— кейс ${id} —`);
            const v = await run_case(id, {
                pool: deps.pool,
                journal: deps.journal,
                config: deps.config,
                step: (t) => write('  · ' + t),
            });
            write(`  ${v.verdict}: ${v.verdict_text}`);
            write(`  отчёт: ${v.report.id}`);
            write(
                `  HTML:  http://${deps.config.bridge_host}:` +
                    `${deps.config.server_port}/reports/${v.report.id}.html`,
            );
        }
    }

    async function handle(line: string): Promise<boolean>
    {
        const cmd = line.trim();
        if (!cmd) return true;
        const [name, ...rest] = cmd.split(/\s+/);
        switch (name.toLowerCase())
        {
            case 'help':
            case '?':
                write('команды:');
                write(
                    `  test <${implemented_cases().join('|')}|all> — ` +
                        `прогон e2e-кейса(ов), отчёт в reports/`,
                );
                write('  status              — регистрации абонентов и активные вызовы');
                write('  help                — эта справка');
                write(
                    '  quit                — graceful-завершение ' +
                        '(unregister всех → закрыть сервер)',
                );
                return true;
            case 'status':
                write(render_status(deps.pool).join('\n'));
                return true;
            case 'test':
                await do_test(rest[0]);
                return true;
            case 'quit':
            case 'exit':
                write('завершаю: снимаю регистрации и закрываю сервер…');
                await deps.on_quit();
                return false; // не показывать приглашение — процесс завершает on_quit
            default:
                write(`неизвестная команда «${name}»; справка: help`);
                return true;
        }
    }

    // Очередь: каждая следующая команда ждёт завершения предыдущей.
    let queue: Promise<void> = Promise.resolve();
    rl.on('line', (line) =>
    {
        queue = queue
            .then(async () =>
            {
                const keep_prompt = await handle(line);
                if (keep_prompt) rl.prompt();
            })
            .catch((e: unknown) =>
            {
                write('ошибка: ' + (e instanceof Error ? e.message : String(e)));
                rl.prompt();
            });
    });

    write(
        'терминал сервера SIP-автотестов; команды: help, status, test <кейс|all>, quit',
    );
    rl.prompt();
    return rl;
}
