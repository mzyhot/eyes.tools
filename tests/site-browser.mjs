import assert from 'node:assert/strict';
import { readdir, mkdir, writeFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const base = process.env.SITE_TEST_URL || 'http://127.0.0.1:8880';
const output = process.env.SITE_TEST_OUTPUT || '/tmp/eyes-site-tests';
await mkdir(output, { recursive: true });
const failures = [], inventory = [];
const context = await browser.newContext();
await context.addInitScript(() => document.addEventListener('securitypolicyviolation', e => { throw new Error('CSP blocked ' + e.blockedURI); }));
await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
const page = await context.newPage();
page.on('pageerror', error => failures.push(`${page.url()}: ${error.message}`));
try {
  const routes = ['/', '/404.html', ...(await readdir(new URL('../t/', import.meta.url))).filter(f => f.endsWith('.html')).map(f => '/' + f.slice(0, -'.html'.length))];
  for (const route of routes) {
    const response = await page.goto(base + route, { waitUntil: 'domcontentloaded' });
    assert.equal(response.status(), 200, route);
    /* The compatibility stubs navigate away from <head>; wait for where they
       land before asking whether that page is ready. */
    if (route === '/lines') await page.waitForURL('**/dump?mode=lines');
    if (route === '/units') await page.waitForURL('**/calc?mode=units');
    await page.waitForFunction(() => document.body.dataset.ready === '1');
    const controls = await page.evaluate(() => ({
      title: document.querySelector('h1')?.textContent,
      fields: [...document.querySelectorAll('input,textarea,select')].map(e => ({ id: e.id, type: e.type, value: e.type === 'file' ? '' : e.value, options: e.options ? [...e.options].map(o => ({ value: o.value, text: o.textContent })) : undefined })),
      buttons: [...document.querySelectorAll('button')].map(e => ({ id: e.id, text: e.textContent })),
      errors: [...document.querySelectorAll('.err')].map(e => e.textContent).filter(Boolean)
    }));
    inventory.push({ route, ...controls });
    if (route !== '/' && !controls.title?.trim()) failures.push(`${route}: missing title`);
    for (const theme of ['dark', 'light']) {
      await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
      for (const width of [320, 375, 414, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        const over = await page.evaluate(() => {
          const width = document.documentElement.clientWidth;
          return [...document.querySelectorAll('main *, .top *, .foot *')].filter(e => {
            const r = e.getBoundingClientRect();
            return r.width > 0 && (r.right > width + 1 || r.left < -1) && getComputedStyle(e).position !== 'fixed' && !e.closest('[hidden]');
          }).slice(0, 5).map(e => `${e.tagName.toLowerCase()}#${e.id}.${String(e.className)}`);
        });
        if (over.length) failures.push(`${route}: ${theme} ${width}px overflow: ${over.join(', ')}`);
      }
    }
    console.log('checked ' + route);
  }
  await writeFile(output + '/inventory.json', JSON.stringify(inventory, null, 2));
  await writeFile(output + '/failures.json', JSON.stringify(failures, null, 2));
  assert.deepEqual(failures, []);
  console.log('PASS every page loads without JavaScript errors or overflow at five widths in both themes');
} finally { await browser.close(); }
