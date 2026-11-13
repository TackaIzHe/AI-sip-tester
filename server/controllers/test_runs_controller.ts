// Контроллер прогонов тест-кейсов (plan_2.md п.5.4, исполнение — п.8):
// GET /api/test_runs отдаёт список реализованных кейсов (реестр CASES — единый
// источник истины для страницы и терминала); POST /api/test_runs
// {case:1..5|"noanswer"|"caller"|"batch24reg"|"batch24unreg"|"t1".."t8"|
//  "all"} ставит прогон в очередь и сразу отвечает 202
// {id} ("all" — основные кейсы, стимулы t1..t8 вне него, см. cases_for_all);
// GET /api/test_runs/:id отдаёт статус, вердикты и
// журнал прогона в JSON (сквозная приёмка плана, п.Verification.6). Исполнение —
// общий e2e_runner.run_case (тот же, что у терминала): свой раннер API —
// прямой путь к расхождению «что видит терминал» ↔ «что делает API».
//
// Очередь обязательна: пул абонентов общий на процесс, параллельные прогоны
// дрались бы за регистрацию 9404 и состояния вызовов. Хранилище прогонов — память
// процесса (per create_app: в api-тестах п.9 изолированно от боёвого сервера).
// related: e2e_runner.ts, doc/task_8_plan_2.md, doc/api.md (п.10).

import { Router } from 'express';
import {
    CASES,
    cases_for_all,
    implemented_cases,
    run_case,
    type CaseVerdict,
} from '../../e2e_runner';
import type { AppConfig } from '../config';
import { utc_stamp, type Journal, type JournalEvent } from '../journal';
import type { SipPool } from '../sip_pool';

/** Зависимости контроллера (в бою — из create_app/main.ts). */
export interface TestRunsDeps
{
    config: AppConfig;
    pool: SipPool;
    journal: Journal;
}

/** Идентификатор кейса из тела: 1..5 (число или строка), 'noanswer' или 'all'. */
function parse_case(value: unknown): string | undefined
{
    if (value === 'all') return 'all';
    const id = String(value);
    return implemented_cases().includes(id) ? id : undefined;
}

/** Запись прогона в хранилище (GET /api/test_runs/:id). */
interface RunRecord
{
    id: string;
    case: string;
    status: 'running' | 'done';
    /** ISO-время постановки в очередь. */
    started_at: string;
    /** ISO-время завершения; нет — ещё выполняется. */
    finished_at?: string;
    /** Вердикты кейсов (у case='all' — по одному на каждый основной кейс). */
    verdicts?: CaseVerdict[];
    /** События журнала, зафиксированные за прогон. */
    events?: JournalEvent[];
    /** Текст ошибки, если прогон бросил непредусмотренное исключение. */
    error?: string;
}

/**
 * Router: GET / (список кейсов), POST / (постановка прогона),
 * GET /:id (результат+журнал).
 */
export function test_runs_controller(deps: TestRunsDeps): Router
{
    const router = Router();
    const runs = new Map<string, RunRecord>();
    // Очередь прогонов: следующий ждёт завершения предыдущего (общий пул).
    let queue: Promise<void> = Promise.resolve();

    router.get('/', (_req, res) =>
    {
        // Индекс ресурса (rails-style): список кейсов берётся из реестра
        // CASES — страница и терминал показывают один и тот же набор.
        const cases = implemented_cases().map((id) => ({ id, name: CASES[id].name }));
        return res.json({ cases });
    });

    router.post('/', (req, res) =>
    {
        const case_id = parse_case((req.body ?? {}).case);
        if (!case_id)
        {
            return res.status(400).json({
                error:
                    `Тело {case: ${implemented_cases().join('|')} ` +
                    `| "all"} обязательно`,
            });
        }
        const id =
            `run_${utc_stamp(Date.now())}_` +
            `${case_id === 'all' ? 'all' : `case${case_id}`}`;
        const record: RunRecord = {
            id,
            case: case_id,
            status: 'running',
            started_at: new Date().toISOString(),
        };
        runs.set(id, record);
        const events_start = deps.journal.events.length;

        queue = queue
            .then(async () =>
            {
                const ids = case_id === 'all' ? cases_for_all() : [case_id];
                const verdicts: CaseVerdict[] = [];
                for (const cid of ids)
                {
                    // run_case сам не бросает на провал кейса (вердикт FAIL), бросает
                    // только на неизвестный id — сюда он попасть не может.
                    verdicts.push(
                        await run_case(cid, {
                            pool: deps.pool,
                            journal: deps.journal,
                            config: deps.config,
                        }),
                    );
                }
                record.verdicts = verdicts;
            })
            .catch((e: unknown) =>
            {
                record.error = e instanceof Error ? e.message : String(e);
            })
            .finally(() =>
            {
                record.status = 'done';
                record.finished_at = new Date().toISOString();
                record.events = deps.journal.events.slice(events_start);
            });

        return res.status(202).json({ id, status: record.status });
    });

    router.get('/:id', (req, res) =>
    {
        const record = runs.get(req.params.id);
        if (!record)
            return res.status(404).json({ error: `Прогон ${req.params.id} не найден` });
        return res.json(record);
    });

    return router;
}
