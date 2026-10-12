import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const context = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(8000);
const base = process.env.SITE_TEST_URL || 'http://127.0.0.1:8880';
const failures = [], errors = [];
page.on('pageerror', error => errors.push(`${page.url()}: ${error.message}`));
await context.addInitScript(() => document.addEventListener('securitypolicyviolation', e => { throw new Error('CSP blocked ' + e.blockedURI + ' (' + e.violatedDirective + ')'); }));
// Browsers do not ship WebMCP by default yet: a stand-in registry records what
// each page offers, as document.modelContext would, and refuses a duplicate name.
await context.addInitScript(() => {
  const tools = new Map();
  const registry = { tools, registerTool(tool) {
    if (tools.has(tool.name)) return Promise.reject(new DOMException('duplicate ' + tool.name, 'InvalidStateError'));
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name) || !tool.description) return Promise.reject(new DOMException('bad tool', 'InvalidStateError'));
    JSON.stringify(tool.inputSchema); tools.set(tool.name, tool); return Promise.resolve();
  } };
  Object.defineProperty(Document.prototype, 'modelContext', { configurable: true, get: () => registry });
});
// Tests never depend on the public randomness relay.
await context.route('https://drand.cloudflare.com/**', route => route.abort());
const go = async name => {
  const response = await page.goto(`${base}/${name}`, { waitUntil: 'domcontentloaded' });
  // s.js marks the body ready once the chrome is built and the registry's deps have run.
  await page.waitForFunction(() => document.body.dataset.ready === '1');
  return response;
};
const text = selector => page.locator(selector).textContent();
const fill = (selector, value) => page.locator(selector).fill(value);
const click = selector => page.locator(selector).click();
const has = (selector, value) => page.waitForFunction(([s, v]) => document.querySelector(s)?.textContent.includes(v), [selector, value]);
const enabled = selector => page.waitForFunction(s => !document.querySelector(s)?.disabled, selector);
const outValue = value => page.waitForFunction(v => document.querySelector('#out')?.value === v, value);
async function check(name, run) { try { await run(); console.log('PASS ' + name); } catch (error) { failures.push(name + ': ' + error.message); console.error('FAIL ' + name + ': ' + error.message); } }
async function download(selector) {
  const pending = page.waitForEvent('download'); await click(selector);
  const file = await pending; return { name: file.suggestedFilename(), bytes: await readFile(await file.path()) };
}

try {
  await check('JSON preserves numbers, duplicate keys and escapes', async () => {
    await go('json');
    const source = '{"large":9007199254740993,"small":-0,"exponent":1e309,"same":1,"same":2,"quoted":"a\\\"b","empty":[{},[]]}';
    await fill('#in', source); await click('#fmt');
    assert.ok((await page.locator('#out').inputValue()).includes('9007199254740993'));
    await click('#min'); await outValue(source);
    await fill('#in', '{bad}'); await click('#fmt'); assert.ok(await text('#err')); assert.equal(await page.locator('#out').inputValue(), '');
    await fill('#in', 'hello\n🌍'); await click('#esc'); await outValue(JSON.stringify('hello\n🌍'));
    await fill('#in', JSON.stringify('hello\n🌍')); await click('#unesc'); await outValue('hello\n🌍');
  });
  await check('base64 UTF-8, URL-safe encoding and malformed input', async () => {
    await go('base64'); await fill('#in', 'hello 🌍'); await click('#enc'); await outValue(Buffer.from('hello 🌍').toString('base64'));
    await fill('#in', Buffer.from('hello 🌍').toString('base64')); await click('#dec'); await outValue('hello 🌍');
    await fill('#in', '%invalid'); await click('#dec'); assert.ok(await text('#err'));
    await page.locator('#file').setInputFiles({ name: 'bytes.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 255, 128]) });
    await page.waitForFunction(() => document.querySelector('#uri').value.endsWith('AP+A'));
  });
  await check('calculator precedence, invalid expressions and temperature bounds', async () => {
    await go('calc');
    for (const [expression, result] of [['-2^2', '-4'], ['2^3^2', '512'], ['(2+3)*4', '20']]) { await fill('#expression', expression); await has('#result', result); }
    await fill('#expression', '1/0'); await page.waitForFunction(() => !!document.querySelector('#error').textContent); assert.equal(await text('#result'), '');
    await page.locator('input[value="units"]').check();
    await page.locator('#quantity').selectOption('temperature');
    await page.locator('#from').selectOption({ label: 'celsius (°C)' });
    await page.locator('#to').selectOption({ label: 'fahrenheit (°F)' });
    await fill('#value', '0'); await has('#unit-result', '32');
    await fill('#value', '-274'); await page.waitForFunction(() => !!document.querySelector('#unit-error').textContent);
  });
  await check('time rejects normalized invalid dates and accepts leap years', async () => {
    await go('time'); await fill('#in', '2024-02-31T12:00:00Z'); await has('#err', 'does not exist');
    await fill('#in', '2024-02-29T12:00:00Z'); await has('#out', '2024-02-29T12:00:00.000Z');
    await fill('#in', '0'); await has('#out', '1970-01-01T00:00:00.000Z');
    await fill('#in', '0099-01-01T00:00:00Z'); await has('#out', '0099-01-01T00:00:00.000Z');
  });
  await check('time zones: DST gap, both overlap instants, swap, early years', async () => {
    await go('tz'); await fill('#from', 'America/New_York'); await fill('#to', 'UTC');
    await fill('#when', '2026-03-08T02:30'); await click('#convert'); await has('#err', 'does not exist');
    await fill('#when', '2026-11-01T01:30'); await click('#convert'); await has('#iso', '2026-11-01T05:30:00.000Z');
    await page.locator('#occurrence').selectOption('later'); await has('#iso', '2026-11-01T06:30:00.000Z');
    await click('#swap'); await has('#iso', '2026-11-01T06:30:00.000Z');
    await click('#swap'); await has('#iso', '2026-11-01T06:30:00.000Z');
    await fill('#from', 'UTC'); await fill('#to', 'Asia/Tokyo'); await fill('#when', '0099-01-01T00:00'); await click('#convert'); await has('#iso', '0099-01-01T00:00:00.000Z');
    await fill('#from', 'Australia/Lord_Howe'); await fill('#to', 'UTC'); await fill('#when', '2026-04-05T01:45'); await click('#convert');
    const later = Date.parse(await text('#iso')); await page.locator('#occurrence').selectOption('earlier');
    assert.equal(later - Date.parse(await text('#iso')), 1800000);
  });
  await check('hash text, binary chunks, empty file and comparison', async () => {
    await go('hash'); await fill('#in', 'abc🌍');
    for (const algorithm of ['md5', 'sha1', 'sha256', 'sha384', 'sha512']) await has('#tout', createHash(algorithm).update('abc🌍').digest('hex'));
    const binary = Buffer.alloc(4 * 1024 * 1024 + 37); for (let i = 0; i < binary.length; i++) binary[i] = i % 251;
    await page.locator('#file').setInputFiles({ name: 'binary.bin', mimeType: 'application/octet-stream', buffer: binary }); await click('#run');
    for (const algorithm of ['md5', 'sha1', 'sha256', 'sha384', 'sha512']) await has('#fout', createHash(algorithm).update(binary).digest('hex'));
    await fill('#cmp', createHash('sha256').update(binary).digest('hex')); await has('#cfile', 'match');
    await page.locator('#file').setInputFiles({ name: 'empty.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(0) }); await click('#run'); await has('#fout', 'd41d8cd98f00b204e9800998ecf8427e');
  });
  await check('barcode checksum and downloadable SVG', async () => {
    await go('barcode'); await fill('#in', '590123412345');
    const svg = await download('#dl'); assert.ok(svg.name.includes('5901234123457')); assert.match(svg.bytes.toString(), /<svg/);
    await fill('#in', '5901234123458'); assert.ok(await text('#err')); assert.equal(await page.locator('#dl').isDisabled(), true);
  });
  await check('QR Unicode renders and exports both formats', async () => {
    await go('qr');
    const sample = 'A\u0080\u0800🌍';
    const encoded = await page.evaluate(s => { const q = new QRCode(document.createElement('div'), { text: s }); return q._oQRCode.dataList[0].parsedData; }, sample);
    assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(encoded)), sample);
    await fill('#in', 'https://example.com/🌍?q=a&b=2'); await enabled('#dl');
    assert.equal((await download('#dl')).bytes.subarray(1, 4).toString(), 'PNG');
    assert.match((await download('#dl-svg')).bytes.toString(), /<svg/);
    await fill('#in', ''); await page.waitForFunction(() => document.querySelector('#dl').disabled);
  });
  await check('case, Unicode character lookup and inspection', async () => {
    await go('case'); await fill('#in', 'hello World'); await has('#out', 'helloWorld'); await has('#out', 'hello_world');
    await go('char'); await fill('#q', 'U+1F30D'); await has('#glyph', '🌍'); await has('#hex', '1F30D');
    await go('inspect'); await fill('#in', 'A🌍'); await has('#out', 'U+1F30D'); await has('#out', 'U+0041');
  });
  await check('text count uses graphemes and UTF-8 bytes', async () => {
    await go('count'); await fill('#in', 'a🌍é\nhi');
    const stats = await page.locator('#stats dd').allTextContents();
    assert.equal(stats[1], '6'); assert.equal(stats[3], '7'); assert.equal(stats[4], String(Buffer.byteLength('a🌍é\nhi'))); assert.equal(stats[5], '2');
  });
  await check('diff escapes markup and shows additions and deletions', async () => {
    await go('diff'); await fill('#a', 'same\n<script>bad</script>\nold'); await fill('#b', 'same\nnew');
    await has('#out', '<script>bad</script>'); await has('#out', 'new'); assert.equal(await page.locator('#out script').count(), 0);
    await click('#swap'); await has('#out', 'old');
  });
  await check('scratchpad line transforms, undo and persistence', async () => {
    await go('dump'); await fill('#pad', ' b \na\nb\n'); await page.locator('#line-tools').evaluate(e => e.open = true);
    await page.locator('#line-trim').check(); await page.locator('#line-dedupe').check(); await page.locator('#line-empty').check(); await page.locator('#line-order').selectOption('asc');
    await page.waitForFunction(() => document.querySelector('#line-preview').value === 'a\nb');
    await click('#line-apply'); assert.equal(await page.locator('#pad').inputValue(), 'a\nb');
    await click('#line-undo'); assert.equal(await page.locator('#pad').inputValue(), ' b \na\nb\n');
    await page.waitForFunction(() => localStorage.getItem('eyes.dump') === ' b \na\nb\n');
    await page.reload(); assert.equal(await page.locator('#pad').inputValue(), ' b \na\nb\n');
  });
  await check('color contrast and invalid input', async () => {
    await go('color'); await fill('#fg', '#000'); await fill('#bg', '#fff'); await has('#ratio', '21'); await has('#hex', '#000000');
    await fill('#fg', 'broken'); assert.ok(await text('#err')); assert.equal(await page.locator('#copy-report').isDisabled(), true);
  });
  await check('lorem word count and password/PIN generation', async () => {
    await go('lorem'); await page.locator('#unit').selectOption('words'); await fill('#n', '7'); await page.waitForFunction(() => document.querySelector('#out').textContent.trim().split(/\s+/).length === 7);
    await go('pass'); let rows = await page.locator('#out .res__v').allTextContents(); assert.equal(rows.length, 5); assert.ok(rows.every(r => r.length === 20));
    await page.locator('input[value="pin"]').check(); await fill('#len', '8'); await click('#again'); rows = await page.locator('#out .res__v').allTextContents(); assert.ok(rows.every(r => /^\d{8}$/.test(r)));
  });
  await check('UUID, UUIDv7 and ULID formats and uniqueness', async () => {
    await go('uuid');
    for (const [kind, pattern] of [['v4', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/], ['v7', /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/], ['ulid', /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/]]) {
      await page.locator(`input[value="${kind}"]`).check(); await click('#regen'); const rows = (await text('#out')).trim().split('\n'); assert.equal(rows.length, 10); assert.equal(new Set(rows).size, 10); assert.ok(rows.every(r => pattern.test(r)), kind);
    }
  });
  await check('RNG unique range and validation', async () => {
    await go('rng'); await page.locator('input[value="csrng"]').check(); await fill('#min', '-2'); await fill('#max', '2'); await fill('#count', '5'); await page.locator('#unique').check(); await click('#draw'); await enabled('#copy');
    assert.deepEqual((await text('#out')).trim().split('\n').map(Number).sort((a,b) => a-b), [-2,-1,0,1,2]);
    await fill('#count', '6'); await click('#draw'); await has('#err', 'fewer numbers');
  });
  await check('coin and dice rendering with a deterministic verified-beacon fixture', async () => {
    for (const name of ['coin', 'dice']) {
      await go(name);
      await page.evaluate(() => { R.source = async (mode, n) => mode === 'trng' ? ({ bytes: new Uint8Array(n), verified: true, round: 123, chainHash: R.chainHash }) : Promise.reject(new Error('wrong source ' + mode)); });
      await page.locator('input[value="trng"]').check();
      await click(name === 'coin' ? '#flip' : '#roll'); await enabled('#copy'); await has('#round', '123');
      if (name === 'coin') assert.match(await text('#first'), /heads|tails/i); else assert.equal((await text('#total')).trim(), '2');
    }
  });
  await check('coin and dice also draw from web crypto and Math.random, with no proof shown', async () => {
    for (const name of ['coin', 'dice']) {
      for (const source of ['csrng', 'prng']) {
        await go(name); await page.locator(`input[value="${source}"]`).check();
        await click(name === 'coin' ? '#flip' : '#roll'); await enabled('#copy');
        assert.equal(await page.locator('#proof').isHidden(), true, name + ' ' + source);
        if (name === 'dice') assert.match(await text('#total'), /^\d+$/); else assert.match(await text('#first'), /^(heads|tails)$/);
      }
    }
  });
  await check('drand requests carry no custom headers, so Safari sends them without a preflight', async () => {
    await go('rng');
    const sent = await page.evaluate(async () => {
      const seen = [], original = window.fetch;
      window.fetch = (url, init) => { seen.push({ url: String(url), headers: Object.keys((init && init.headers) || {}) }); return original(url, init); };
      try { await R.source('trng', 32); } catch (_) {}
      window.fetch = original;
      return seen;
    });
    assert.ok(sent.length > 0 && sent.every(r => r.url.startsWith('https://drand.cloudflare.com/')), JSON.stringify(sent));
    assert.deepEqual(sent.filter(r => r.headers.length), [], 'custom headers force a CORS preflight the relay refuses');
  });
  await check('URL parsing, form encoding and malformed escapes', async () => {
    await go('url'); await fill('#in', 'https://example.com/path?q=a%20b#hash'); await click('#parse'); await has('#out', 'example.com'); await has('#out', '/path');
    await fill('#in', 'hello 🌍'); await click('#enc'); assert.ok((await text('#out')).includes('%F0%9F%8C%8D'));
    await fill('#in', '%ZZ'); await click('#dec'); assert.ok(await text('#err'));
  });
  let png;
  await check('image resize exports exact dimensions and EXIF reads PNG metadata', async () => {
    await go('img');
    png = Buffer.from(await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 32; c.height = 16; const x = c.getContext('2d'); x.fillStyle = '#f00'; x.fillRect(0,0,32,16); return c.toDataURL().split(',')[1]; }), 'base64');
    await page.locator('#file').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: png }); await enabled('#dl');
    await page.locator('#fmt').selectOption('image/png'); await fill('#w', '16'); await page.locator('#w').press('Tab');
    await page.waitForFunction(() => document.querySelector('#preview').width === 16 && document.querySelector('#preview').height === 8); await enabled('#dl');
    const resized = (await download('#dl')).bytes; assert.equal(resized.readUInt32BE(16), 16); assert.equal(resized.readUInt32BE(20), 8);
    await go('exif'); await page.locator('#file').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: png }); await enabled('#download'); await has('#out', '32'); await has('#out', '16');
    assert.ok(Object.keys(JSON.parse((await download('#download')).bytes)).length > 4);
  });
  await check('spectrogram decodes PCM audio and exports PNG', async () => {
    await go('spectrogram'); const frames = 8000, wav = Buffer.alloc(44 + frames * 2);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40);
    for (let i=0; i<frames; i++) wav.writeInt16LE(Math.round(Math.sin(2*Math.PI*440*i/8000)*16000), 44+i*2);
    await page.locator('#file').setInputFiles({ name:'tone.wav', mimeType:'audio/wav', buffer:wav }); await enabled('#dl'); await has('#meta', '1.00 s'); assert.equal((await download('#dl')).bytes.subarray(1,4).toString(), 'PNG');
  });
  await check('WebMCP: every page offers its tools, and they answer like the page', async () => {
    const call = (name, input) => page.evaluate(async ([n, i]) => JSON.parse(JSON.stringify(await document.modelContext.tools.get(n).execute(i, { signal: new AbortController().signal }))), [name, input]);
    const offered = () => page.evaluate(() => [...document.modelContext.tools.keys()]);
    await go(''); assert.deepEqual(await offered(), ['find_tool']);
    assert.deepEqual((await call('find_tool', { query: 'time zone' })).tools.map(t => t.url), [base + '/tz']);
    const names = new Set();
    for (const slug of (await readdir(new URL('../t/', import.meta.url))).filter(f => f.endsWith('.html')).map(f => f.slice(0, -5))) {
      if (slug === 'lines' || slug === 'units') continue;
      await go(slug);
      for (const name of await offered()) if (name !== 'find_tool') { assert.ok(!names.has(name), 'tool name reused: ' + name); names.add(name); }
    }
    assert.ok(names.size >= 30, 'only ' + names.size + ' tools offered');
    await go('case'); assert.equal((await call('convert_case', { text: 'hello World' })).snake, 'hello_world'); assert.equal(await page.locator('#in').inputValue(), 'hello World');
    assert.ok((await call('convert_case', { text: '' })).error);
    await go('hash'); assert.equal((await call('hash_text', { text: 'abc🌍' }))['sha-256'], createHash('sha256').update('abc🌍').digest('hex'));
    assert.match((await call('hash_chosen_file', {})).error, /no file/);
    await go('calc'); assert.equal((await call('calculate', { expression: '2^3^2' })).result, 512); assert.equal((await call('convert_units', { value: 0, from: 'celsius', to: '°F' })).result, 32);
    assert.match((await call('calculate', { expression: '1/0' })).error, /zero/);
    await go('json'); assert.ok((await call('format_json', { json: '{bad}' })).error); assert.equal((await call('format_json', { json: '{ "a" : 1 }', indent: 'minify' })).json, '{"a":1}');
    await go('color'); assert.equal((await call('check_contrast', { foreground: 'black', background: 'white' })).ratio, '21.00:1');
    await go('uuid'); assert.equal((await call('generate_ids', { kind: 'ulid', count: 3 })).ids.length, 3);
    await go('dump'); await call('add_to_scratchpad', { text: 'from an agent' }); assert.ok((await page.locator('#pad').inputValue()).endsWith('from an agent'));
    await go('tz'); assert.equal((await call('convert_time_zone', { dateTime: '2026-11-01T01:30', from: 'America/New_York', to: 'UTC', occurrence: 'later' })).instant, '2026-11-01T06:30:00.000Z');
    await go('case'); assert.equal((await call('convert_case', {})).error, 'text is required');

    // The MCP server runs the same cores: it offers every page tool but those
    // needing the visitor's own things, and answers exactly as the page does.
    const mcp = async (method, params) => (await (await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
    const pageOnly = ['hash_chosen_file', 'resize_image', 'read_image_metadata', 'read_scratchpad', 'add_to_scratchpad'];
    assert.deepEqual((await mcp('tools/list', {})).tools.map(t => t.name).sort(), [...names].filter(n => !pageOnly.includes(n)).sort());
    for (const [slug, name, input] of [
      ['case', 'convert_case', { text: 'Hello wide World' }], ['base64', 'base64_encode', { text: 'hé🌍', urlSafe: true }],
      ['hash', 'hash_text', { text: 'abc', encoding: 'base64' }], ['json', 'format_json', { json: '{"b":[1,{"c":null}]}', indent: '4' }],
      ['url', 'parse_url', { url: 'https://a.example:8080/p/q?x=1&y=%20#f' }], ['count', 'count_text', { text: 'one two\nthree' }],
      ['char', 'look_up_character', { query: '&copy;' }], ['inspect', 'inspect_text', { text: 'a\u200bb', set: 'ascii' }],
      ['diff', 'diff_text', { before: 'a\nb\nc', after: 'a\nc\nd' }], ['color', 'check_contrast', { foreground: '#777', background: 'white' }],
      ['calc', 'calculate', { expression: 'sqrt(2) * 3!' }], ['calc', 'convert_units', { value: 5, from: 'mi', to: 'km' }],
      ['barcode', 'make_ean13_barcode', { digits: '590123412345' }], ['qr', 'make_qr_code', { text: 'eyes', errorCorrection: 'high', size: 128 }],
      ['dump', 'clean_up_lines', { text: 'b\na\nb', sort: 'asc', unique: true }], ['dir', 'search_directory', { query: 'github' }],
      ['lorem', 'generate_lorem_ipsum', { kind: 'words', count: 7 }], ['time', 'convert_timestamp', { value: '1787313600' }],
      ['tz', 'convert_time_zone', { dateTime: '2026-03-08T02:30', from: 'America/New_York', to: 'Asia/Tokyo' }],
      ['calc', 'calculate', { expression: '1/0' }], ['json', 'format_json', { json: '{bad}' }]
    ]) {
      await go(slug);
      const onPage = await call(name, input), onServer = await mcp('tools/call', { name, arguments: input });
      if (onPage.error) assert.deepEqual([onServer.isError, onServer.content[0].text], [true, onPage.error], name);
      else {
        // The page adds what only a browser knows: the reader's own local time.
        delete onPage.local;
        assert.deepEqual(onServer.structuredContent, onPage, name + ' ' + JSON.stringify(input));
      }
    }
  });
  await check('directory filtering', async () => {
    await go('dir'); await fill('#q', 'github'); assert.ok((await text('main')).toLowerCase().includes('github')); await enabled('#copy-urls');
  });
  assert.deepEqual(errors, [], 'browser exceptions / CSP violations');
  assert.deepEqual(failures, [], 'functional failures');
  console.log('PASS all functional browser checks');
} finally { await browser.close(); }
