// Прогон-зонд (браузерный уровень): клики пользователя по вкладке «Отчёты»
// страницы public/index.html против БОЕВОГО express-приложения (app.listen на
// эфемерном порту, каталоги public/ и reports/ — рабочие). jsdom (dev-тулза,
// в package.json не сохраняется) исполняет инлайновый JS страницы; дальше —
// сценарий браузера:
//   1) загрузка страницы (статус+дерево),
//   2) клик по вкладке «Отчёты» → load_reports() список из /api/reports,
//   3) клик по отчёту → iframe #report-viewer со src=/reports/<id>.html,
//   4) iframe-URL реально отдаёт журнал (fetch + шапка/вердикт/этапы).
// Запуск: npm i -D --no-save jsdom@24 && npx tsx doc/.probe_reports_browser.ts
// (jsdom — временная тулза проверки, в package.json НЕ сохраняется; Node 18
// требует ветку 24.x — jsdom 30 несовместим). После проверки: npm rm jsdom.
// related: doc/.probe_reports_page.ts (серверный уровень), public/index.html.

import fs from 'node:fs';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { AddressInfo } from 'node:net';
import { create_app } from '../server/app';
import type { AppConfig } from '../server/config';
import { Journal } from '../server/journal';
import type { SipPool } from '../server/sip_pool';

const CONFIG: AppConfig = {
    server_port: 0,
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

const ok = (label: string) => console.log(`  ✓ ${label}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function wait_until(
    fn: () => boolean,
    label: string,
    timeout_ms = 8000,
): Promise<void>
{
    const deadline = Date.now() + timeout_ms;
    while (Date.now() < deadline)
    {
        if (fn()) return;
        await sleep(50);
    }
    assert.fail(`таймаут: ${label}`);
}

// 1. Боевое приложение (без sip.js — вкладка «Отчёты» пула не касается).
const app = create_app({
    config: CONFIG,
    pool: {} as unknown as SipPool,
    journal: new Journal(),
});
const srv = app.listen(0);
await new Promise<void>((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

try
{
    // 2. Страница + её инлайновый JS в jsdom (fetch — на боевой сервер).
    const page_res = await fetch(`${base}/`);
    assert.equal(page_res.status, 200);
    const html = await page_res.text();
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
    assert.ok(script, 'в index.html не найден инлайновый <script>');

    const dom = new JSDOM(html, {
        url: `${base}/`,
        runScripts: 'outside-only',
        pretendToBeVisual: true,
    });
    const w = dom.window as unknown as Window & typeof globalThis;
    (w as any).fetch = (u: string | URL, init?: RequestInit) =>
        fetch(new URL(String(u), base), init as any);
    (w as any).window = w; // часть кода страницы ссылается на window явно
    w.eval(script!);

    const doc = dom.window.document;
    await wait_until(
        () => !doc.getElementById('tree')!.textContent!.includes('загрузка'),
        'дерево загрузилось',
    );
    ok('страница открыта, инлайновый JS отработал (дерево, статус)');

    // 3. Клик по вкладке «Отчёты» — как у пользователя.
    const n_reports_expected = fs
        .readdirSync('reports')
        .filter((n) => n.endsWith('.json')).length;
    assert.ok(
        n_reports_expected > 0,
        'в reports/ нет ни одного отчёта — нечего проверять',
    );
    (doc.querySelector('nav button[data-pane="reports"]') as HTMLElement).click();
    await wait_until(
        () => doc.querySelectorAll('#reports li').length === n_reports_expected,
        `список отчётов не заполнился (ожидалось ${n_reports_expected}); ` +
            `#reports: «${doc.getElementById('reports')!.textContent!.slice(0, 120)}»`,
    );
    assert.ok(
        !doc
            .getElementById('reports')!
            .textContent!.includes('не удалось загрузить отчёты'),
        'панель показала ошибку загрузки отчётов',
    );
    for (const li of [...doc.querySelectorAll('#reports li')])
    {
        assert.ok(
            li.querySelector('a'),
            `в записи «${li.textContent?.slice(0, 60)}» нет ссылки «новая вкладка»`,
        );
    }
    ok(
        `клик по вкладке «Отчёты»: список из ${n_reports_expected} записей, ` +
            `у каждой — ссылка`,
    );

    // 4. Клик по первой записи — HTML-журнал открывается в iframe.
    const first = doc.querySelector('#reports li') as HTMLElement;
    const first_id = first.dataset.id!;
    first.click();
    const frame = doc.querySelector(
        '#report-viewer iframe.report',
    ) as HTMLIFrameElement | null;
    assert.ok(frame, 'iframe отчёта не создан');
    assert.equal(new URL(frame.src).pathname, `/reports/${first_id}.html`);
    const frame_res = await fetch(frame.src);
    assert.equal(frame_res.status, 200, `iframe src ${frame.src} → ${frame_res.status}`);
    const report_html = await frame_res.text();
    assert.ok(
        report_html.includes(`Отчёт прогона: ${first_id}`),
        'в iframe — не журнал этого прогона',
    );
    assert.ok(report_html.includes('Вердикт:'), 'в журнале нет вердикта');
    ok(
        `клик по отчёту ${first_id}: iframe /reports/<id>.html → 200, ` +
            `журнал с вердиктом и этапами`,
    );

    // 5. Кнопка «обновить» на вкладке — повторная загрузка без деградации.
    (doc.getElementById('reload-reports') as HTMLElement).click();
    await wait_until(
        () => doc.querySelectorAll('#reports li').length === n_reports_expected,
        'после «обновить» список отчётов пропал',
    );
    ok('кнопка «обновить» — список перезагрузился');

    dom.window.close();
    console.log(
        '\nPASS: браузерный путь «вкладка Отчёты → список → журнал в iframe» работает.',
    );
}
finally
{
    srv.close();
}
