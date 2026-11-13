// Контроллер файлов (plan_2.md п.5.2): дерево проекта и просмотр содержимого
// для веб-страницы (п.6). Порт buildTree/file-content из task2/vite.config.ts:18-70
// с ОДНОЙ правкой по плану: dotfiles НЕ фильтруются (убран startsWith('.')) —
// страница обязана показывать .claude/, .env и прочие скрытые. В игноре только
// node_modules и .git (из task2-списка убраны dist/certs — они теперь легальны).
//
// Content: traversal-защита (resolve+префикс корня → 403), 400 без path,
// 404 не-файл/нет, 413 > 1 МБ, 415 бинарные (NUL в первых 8 КБ) — 1-в-1 task2.
// related: server/routes.ts (маршруты /api/files/*), doc/task_5_plan_2.md.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import { Router } from 'express';

/** Что игнорируем в дереве на любом уровне (plan_2.md п.5.2: только эти два). */
const TREE_IGNORED = new Set(['node_modules', '.git']);

/** Узел дерева файлов (форма ответа — как в task2, её ждёт страница п.6). */
export interface TreeNode
{
    name: string;
    dir: boolean;
    children?: TreeNode[];
}

/** Дерево от rel-каталога; каталоги первыми, затем по имени (порядок task2). */
export function build_tree(root: string, dir: string): TreeNode[]
{
    const nodes: TreeNode[] = [];
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true }))
    {
        // Правка п.5.2: скрытые файлы/каталоги НЕ отсекаем (в task2 здесь было
        // entry.name.startsWith('.')) — критерий: дерево содержит .claude/ и .env.
        if (TREE_IGNORED.has(entry.name)) continue;
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory())
        {
            nodes.push({ name: entry.name, dir: true, children: build_tree(root, rel) });
        }
        else if (entry.isFile())
        {
            nodes.push({ name: entry.name, dir: false });
        }
    }
    return nodes.sort(
        (a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name),
    );
}

/**
 * Router контроллерa: GET /tree, GET /content?path=.
 * root — корень дерева (в бою process.cwd(), в api-тестах — temp-каталог, п.9).
 */
export function files_controller(root: string): Router
{
    const router = Router();
    const abs_root = resolve(root);

    router.get('/tree', (_req, res, next) =>
    {
        try
        {
            res.json(build_tree(abs_root, ''));
        }
        catch (e)
        {
            next(e);
        }
    });

    router.get('/content', (req, res, next) =>
    {
        function send(code: number, obj: unknown): void
        {
            res.status(code).json(obj);
        }
        try
        {
            const rel = typeof req.query.path === 'string' ? req.query.path : '';
            if (!rel) return send(400, { error: 'no path' });
            const abs = resolve(abs_root, normalize(rel));
            if (abs !== abs_root && !abs.startsWith(abs_root + sep))
                return send(403, { error: 'forbidden' });
            if (!statSync(abs).isFile()) return send(404, { error: 'not a file' });
            const buf = readFileSync(abs);
            if (buf.length > 1024 * 1024) return send(413, { error: 'file too large' });
            if (buf.subarray(0, 8000).includes(0))
                return send(415, { error: 'binary file' });
            return send(200, { content: buf.toString('utf8') });
        }
        catch (e)
        {
            // ENOENT/ENOTDIR у statSync — «нет такого файла» (в task2 падало в 500,
            // здесь 404: curl-клиенту важен различимый код).
            if (e instanceof Error && (e as NodeJS.ErrnoException).code === 'ENOENT')
            {
                return send(404, { error: 'not a file' });
            }
            next(e);
        }
    });

    return router;
}
