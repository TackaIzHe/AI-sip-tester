// Api-тесты /api/files/* (plan_2.md п.9.1): дерево содержит dotfiles
// (.env, .claude/) и игнорит node_modules/.git; content отдаёт 200/400/403/
// 404/413/415. Корень дерева — temp-каталог с синтетическими файлами, чтобы
// тест не зависел от состава реального проекта; дополнительно проверяется
// content dotfile — критерий п.5.
// related: server/controllers/files_controller.ts, doc/task_5_plan_2.md.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { TreeNode } from '../../server/controllers/files_controller';
import { make_api_app, temp_dir } from './helpers';

const BIG = 'a'.repeat(1024 * 1024 + 1); // > 1 МБ — планка 413 в контенте

let app: Express;
let root: string;
let cleanup_root: () => void;

beforeAll(async () =>
{
    const t = temp_dir();
    root = t.dir;
    cleanup_root = t.cleanup;
    mkdirSync(join(root, '.claude'), { recursive: true });
    mkdirSync(join(root, 'server'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.env'), 'PBX_HOST=192.168.80.157\n');
    writeFileSync(join(root, '.hidden'), 'скрытый файл');
    writeFileSync(join(root, '.claude', 'settings.json'), '{"ok":true}');
    writeFileSync(join(root, 'server', 'app.ts'), 'export const app = 1;\n');
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;');
    writeFileSync(join(root, '.git', 'config'), '[core]');
    writeFileSync(join(root, 'big.txt'), BIG);
    writeFileSync(
        join(root, 'bin.dat'),
        Buffer.concat([Buffer.from('MZ'), Buffer.from([0, 1, 2]), Buffer.from('tail')]),
    );

    app = make_api_app({ root }).app;
});

afterAll(() => cleanup_root());

/** Плоские имена верхнего уровня дерева. */
function top_names(tree: TreeNode[]): string[]
{
    return tree.map((n) => n.name);
}

describe('GET /api/files/tree', () =>
{
    it(
        'включает dotfiles (.env, .hidden, .claude/ ' + 'со вложенным settings.json)',
        async () =>
        {
            const res = await request(app).get('/api/files/tree').expect(200);
            const names = top_names(res.body);
            expect(names).toContain('.env');
            expect(names).toContain('.hidden');
            expect(names).toContain('.claude');
            const claude = res.body.find((n: TreeNode) => n.name === '.claude');
            expect(claude.dir).toBe(true);
            expect(claude.children.map((c: TreeNode) => c.name)).toContain(
                'settings.json',
            );
        },
    );

    it('игнорит node_modules и .git', async () =>
    {
        const res = await request(app).get('/api/files/tree').expect(200);
        const names = top_names(res.body);
        expect(names).not.toContain('node_modules');
        expect(names).not.toContain('.git');
    });

    it('каталоги идут перед файлами, внутри имени — порядок (как в task2)', async () =>
    {
        const res = await request(app).get('/api/files/tree').expect(200);
        const first_file = res.body.findIndex((n: TreeNode) => !n.dir);
        const last_dir = res.body.map((n: TreeNode) => n.dir).lastIndexOf(true);
        expect(last_dir).toBeLessThan(first_file);
    });
});

describe('GET /api/files/content', () =>
{
    it('200 — содержимое dotfile и вложенного файла', async () =>
    {
        const dot = await request(app)
            .get('/api/files/content')
            .query({ path: '.env' })
            .expect(200);
        expect(dot.body.content).toBe('PBX_HOST=192.168.80.157\n');
        const nested = await request(app)
            .get('/api/files/content')
            .query({ path: 'server/app.ts' })
            .expect(200);
        expect(nested.body.content).toContain('export const app');
    });

    it('400 — path отсутствует или пуст', async () =>
    {
        await request(app)
            .get('/api/files/content')
            .expect(400)
            .expect((r) => expect(r.body.error).toBeTruthy());
        await request(app).get('/api/files/content').query({ path: '' }).expect(400);
    });

    it('403 — traversal за корень (../ и абсолютный путь)', async () =>
    {
        await request(app)
            .get('/api/files/content')
            .query({ path: '../../etc/passwd' })
            .expect(403);
        await request(app)
            .get('/api/files/content')
            .query({ path: '/etc/passwd' })
            .expect(403);
    });

    it('404 — нет файла, каталог и точка вместо файла', async () =>
    {
        await request(app)
            .get('/api/files/content')
            .query({ path: 'missing.txt' })
            .expect(404);
        await request(app)
            .get('/api/files/content')
            .query({ path: 'server' })
            .expect(404);
        await request(app).get('/api/files/content').query({ path: '.' }).expect(404);
    });

    it('413 — файл больше 1 МБ', async () =>
    {
        const res = await request(app)
            .get('/api/files/content')
            .query({ path: 'big.txt' })
            .expect(413);
        expect(res.body.error).toContain('large');
    });

    it('415 — бинарный файл (NUL в первых 8 КБ)', async () =>
    {
        const res = await request(app)
            .get('/api/files/content')
            .query({ path: 'bin.dat' })
            .expect(415);
        expect(res.body.error).toContain('binary');
    });
});
