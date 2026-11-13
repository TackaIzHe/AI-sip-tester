// Контроллер отчётов (plan_2.md п.5.3): список и просмотр отчётов, которые
// генерирует Journal.render_report() (п.3) в каталог reports/. Источник данных
// — файлы на диске, не память процесса: отчёты переживают перезапуск сервера
// и создаются e2e-раннером (п.8) в том же процессе.
//
// Список — по *.json отчётов (JSON — машиночитаемая копия; id — имя файла без
// расширения, UTC-метка в имени даёт и уникальность, и хронологию сортировки).
// GET /:id отдаёт распарсенный JSON отчёта; html/md доступны статикой
// /reports/<id>.html (app.ts) — их открывает страница (п.6).
// DELETE /:id и DELETE / — удаление отчётов по запросу страницы: снимается
// вся триада файлов отчёта (<id>.json/.md/.html), иначе статика /reports
// продолжала бы отдавать мёртвые ссылки.
// related: server/journal.ts (генерация), server/app.ts (статика /reports).

import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';

/** Строка списка отчётов: id + пути ко всем трём представлениям. */
export interface ReportEntry
{
    id: string;
    json: string;
    md: string;
    html: string;
    size: number;
}

/** Имя отчёта безопасно как путь: только [A-Za-z0-9._-], не '.'/'..', без sep. */
function safe_id(id: string): boolean
{
    return /^[A-Za-z0-9._-]+$/.test(id) && id !== '.' && id !== '..';
}

/** id отчёта из имени *.json файла каталога. */
function id_of(name: string): string
{
    return name.slice(0, -'.json'.length);
}

/**
 * Удалить все три представления отчёта (.json/.md/.html). Возвращает true, если
 * на диске был хотя бы один файл (иначе отчёта нет — 404 у вызывающего).
 */
function remove_report(dir: string, id: string): boolean
{
    let removed = false;
    for (const ext of ['.json', '.md', '.html'])
    {
        const file = path.join(dir, `${id}${ext}`);
        if (fs.existsSync(file))
        {
            fs.rmSync(file);
            removed = true;
        }
    }
    return removed;
}

/** Список имён *.json в каталоге (пустой список, если каталога нет). */
function json_names(dir: string): string[]
{
    return fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((n) => n.endsWith('.json'))
        : [];
}

/**
 * Router контроллера: GET /, GET /:id, DELETE /:id, DELETE /.
 * reports_dir — тот же каталог, что у Journal (в бою ./reports, в тестах temp).
 */
export function reports_controller(reports_dir: string): Router
{
    const router = Router();
    const dir = path.resolve(reports_dir);

    router.get('/', (_req, res, next) =>
    {
        try
        {
            const names = json_names(dir);
            // UTC-метка в имени (journal.utc_stamp) — обратная лексика = хронология.
            names.sort((a, b) => b.localeCompare(a));
            const reports: ReportEntry[] = names.map((n) =>
            {
                const id = id_of(n);
                return {
                    id,
                    json: `/api/reports/${encodeURIComponent(id)}`,
                    md: `/reports/${encodeURIComponent(id)}.md`,
                    html: `/reports/${encodeURIComponent(id)}.html`,
                    size: fs.statSync(path.join(dir, n)).size,
                };
            });
            res.json({ reports });
        }
        catch (e)
        {
            next(e);
        }
    });

    router.get('/:id', (req, res, next) =>
    {
        const id = req.params.id;
        // id идёт в путь файла — фильтрация вместо resolve/префикса: в каталог
        // отчётов сервер пишет сам, но суровый чек исключает и ../, и абсолют.
        if (!safe_id(id))
            return res.status(400).json({ error: 'Некорректный id отчёта' });
        const file = path.join(dir, `${id}.json`);
        if (!fs.existsSync(file))
            return res.status(404).json({ error: `Отчёт ${id} не найден` });
        try
        {
            res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
        }
        catch (e)
        {
            next(e);
        }
    });

    // Удаление одного отчёта (кнопка «удалить выбранные» на странице снимает
    // каждый отмеченный чекбоксом отчёт этим маршрутом).
    router.delete('/:id', (req, res, next) =>
    {
        const id = req.params.id;
        if (!safe_id(id))
            return res.status(400).json({ error: 'Некорректный id отчёта' });
        try
        {
            if (!remove_report(dir, id))
                return res.status(404).json({ error: `Отчёт ${id} не найден` });
            res.json({ deleted: id });
        }
        catch (e)
        {
            next(e);
        }
    });

    // Удаление всех отчётов (каталог чистится целиком: триады перечисленных
    // отчётов + осиротевшие .md/.html без пары .json — иначе статика /reports
    // продолжала бы отдавать файлы, которых «нет» в списке).
    router.delete('/', (_req, res, next) =>
    {
        try
        {
            const ids = json_names(dir).map(id_of);
            for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : [])
            {
                if (
                    name.endsWith('.json') ||
                    name.endsWith('.md') ||
                    name.endsWith('.html')
                )
                {
                    fs.rmSync(path.join(dir, name));
                }
            }
            res.json({ deleted: ids, count: ids.length });
        }
        catch (e)
        {
            next(e);
        }
    });

    return router;
}
