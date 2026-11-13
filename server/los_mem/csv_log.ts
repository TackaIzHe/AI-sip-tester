// CSV-журнал прогонов генератора стимулов los_mem (doc/los_mem/plan_test.md
// §2.2): строки `ts_utc,ts_ms,scenario,kind,text`, kind: phase|tick|summary|
// notify — фазовые метки для сшивки «память/пакеты» по времени с внешним
// мониторингом; notify — сырые строки отправленных NOTIFY (план 5 п.2).
//
// Пишется сразу на диск (fs.writeSync): soak-прогон переживает даже убийство
// процесса. Общий модуль для standalone-CLI (los_mem_main.ts) и кейсов T1–T8
// в реестре CASES (e2e_runner.ts) — метки обязаны иметь один формат, где бы
// прогон ни запускался.
// related: los_mem_main.ts, e2e_runner.ts (кейсы t1..t8),
// server/los_mem/scenarios.ts, doc/los_mem/plan_test.md §2.2.

import fs from 'node:fs';
import path from 'node:path';

/**
 * CSV-журнал прогона: заголовок колонки создаёт в конструкторе, close()
 * идемпотентен (повтор — no-op).
 */
export class CsvLog
{
    private fd: number | undefined;

    /**
     * @param file_path — путь CSV; каталог создаётся при необходимости.
     * @param scenario — id сценария в колонке scenario (t1..t8).
     */
    constructor(
        readonly file_path: string,
        private readonly scenario: string,
    )
    {
        fs.mkdirSync(path.dirname(this.file_path), { recursive: true });
        this.fd = fs.openSync(this.file_path, 'w');
        fs.writeSync(this.fd, 'ts_utc,ts_ms,scenario,kind,text\n');
    }

    /** Одна строка журнала; кавычки в тексте удваиваются (CSV-экранирование). */
    row(kind: string, text: string): void
    {
        if (this.fd === undefined) return;
        const now = Date.now();
        const safe = text.replace(/"/g, '""');
        fs.writeSync(
            this.fd,
            `${new Date(now).toISOString()},${now},${this.scenario},${kind},"` +
                `${safe}"\n`,
        );
    }

    close(): void
    {
        if (this.fd !== undefined) fs.closeSync(this.fd);
        this.fd = undefined;
    }
}
