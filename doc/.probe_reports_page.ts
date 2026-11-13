// Прогон-зонд: журналы прогонов отдаются на страницу во вкладку «Отчёты».
// Без сети и без АТС: create_app с БОЕВЫМИ каталогами cwd (public/, reports/)
// и моком пула; supertest эмулирует ровно те запросы, которые делает
// public/index.html (см. load_reports/open_report):
//   GET /                  — страница с вкладкой «Отчёты»;
//   GET /api/reports       — список отчётов панели;
//   GET <entry.html>       — iframe-отчёт /reports/<id>.html (статика);
//   GET /api/reports/:id   — JSON-копия отчёта (meta + журнал событий).
// Запуск: npx tsx doc/.probe_reports_page.ts
// related: public/index.html, server/controllers/reports_controller.ts,
// doc/task_6_plan_2.md.

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import request from 'supertest';
import { create_app } from '../server/app';
import type { AppConfig } from '../server/config';
import { Journal } from '../server/journal';
import type { SipPool } from '../server/sip_pool';

const CONFIG: AppConfig = {
    server_port: 3000,
    pbx_host: '192.168.80.157',
    pbx_port: 5060,
    sip_protocol: 'udp',
    bridge_host: '192.168.80.159',
    bridge_port: 8090,
    subscribers: [
        { number: '9404', password: 'x', can_register: true },
        { number: '52', password: 'x', can_register: true },
        { number: '3203', password: 'x', can_register: false },
    ],
};

// Вкладки «Отчёты» пул не касается (только files/reports/static) — пустой мок.
const app = create_app({
    config: CONFIG,
    pool: {} as unknown as SipPool,
    journal: new Journal(),
});

const ok = (label: string) => console.log(`  ✓ ${label}`);

// 1. Страница: вкладка «Отчёты», панели и iframe-viewer на месте.
const page = await request(app).get('/');
assert.equal(page.status, 200);
assert.ok(page.headers['content-type']?.includes('text/html'), 'GET / — не html');
for (const needle of [
    'data-pane="reports"',
    'id="reports"',
    'id="report-viewer"',
    'load_reports()',
])
{
    assert.ok(page.text.includes(needle), `на странице нет «${needle}»`);
}
ok('GET / → 200, вкладка «Отчёты» и viewer присутствуют');

// 2. Список отчётов панели: непустой, у каждой записи путь html → /reports/<id>.html.
const list = await request(app).get('/api/reports');
assert.equal(list.status, 200);
const entries = list.body.reports as Array<{
    id: string;
    json: string;
    html: string;
    size: number;
}>;
assert.ok(
    Array.isArray(entries) && entries.length > 0,
    '/api/reports вернул пустой список',
);
for (const e of entries)
{
    assert.equal(
        e.html,
        `/reports/${encodeURIComponent(e.id)}.html`,
        `у ${e.id} неверный html-путь`,
    );
    assert.ok(
        fs.existsSync(path.join('reports', `${e.id}.html`)),
        `файл ${e.id}.html не на диске`,
    );
}
ok(`GET /api/reports → 200, отчётов: ${entries.length}, html-пути корректны`);

// 3. Каждый html-отчёт открывается iframe-запросом страницы (статика /reports/).
for (const e of entries)
{
    const html = await request(app).get(e.html);
    assert.equal(html.status, 200, `${e.html} → ${html.status}`);
    assert.ok(html.headers['content-type']?.includes('text/html'), `${e.html} — не html`);
    assert.ok(
        html.text.includes(`Отчёт прогона: ${e.id}`),
        `${e.html} — нет заголовка отчёта`,
    );
    assert.ok(html.text.includes('Вердикт:'), `${e.html} — нет строки вердикта`);
    assert.ok(
        /<td>\d+<\/td>/.test(html.text) || html.text.includes('журнал пуст'),
        `${e.html} — нет таблицы этапов`,
    );
}
ok(
    `каждый /reports/<id>.html (${entries.length}) → 200 с шапкой, вердиктом ` +
        `и таблицей этапов`,
);

// 4. JSON-копия каждого отчёта: шапка прогона + журнал событий (data на диске).
for (const e of entries)
{
    const js = await request(app).get(`/api/reports/${encodeURIComponent(e.id)}`);
    assert.equal(js.status, 200, `/api/reports/${e.id} → ${js.status}`);
    assert.equal(js.body.id, e.id);
    assert.ok(['PASS', 'FAIL'].includes(js.body.meta?.verdict), `у ${e.id} нет verdict`);
    assert.ok(Array.isArray(js.body.events), `у ${e.id} нет массива events`);
}
ok('каждый GET /api/reports/:id → 200 с meta.verdict и events (журнал этапов)');

console.log(
    `\nPASS: журналы прогонов отдаются во вкладку «Отчёты» страницы ` +
        `(записей: ${entries.length}).`,
);
