import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createEyesServer } from '../dev-server.mjs';

// One test stands in for the network; the requests the tests send are real.
const send = globalThis.fetch;

/* The pages' input checker, which the tests hold answers to output schemas with. */
const checker = {};
runInNewContext(await readFile(new URL('../agent-schema.js', import.meta.url), 'utf8'), checker);
const { AgentSchema } = checker;

async function start(t, options) {
  const app = createEyesServer(options);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let id = 0;
  const post = (body, headers = {}) => send(base + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
  const rpc = async (method, params, headers) => {
    const res = await post({ jsonrpc: '2.0', id: ++id, method, params }, headers);
    assert.equal(res.status, 200, method);
    assert.match(res.headers.get('content-type'), /^application\/json/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    return res.json();
  };
  const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
  return { base, post, rpc, call };
}

/* A mono 16-bit wav of a sine. */
function wav(seconds, rate, frequency) {
  const count = Math.round(seconds * rate), data = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) data.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * frequency * i / rate)), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
/* An image's size from its header. */
function pngSize(bytes) { return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]; }
function webpSize(bytes) {
  const chunk = bytes.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
  if (chunk === 'VP8L') { const bits = bytes.readUInt32LE(21); return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1]; }
  return [1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3)];
}
/* A tool's image, as image content beside structured content that names it
   but does not carry it. */
function image(result, key = 'image') {
  assert.equal(result.isError, false, result.isError && result.content[0].text);
  const described = result.structuredContent[key];
  assert.equal(described.data, undefined, 'the base64 is not in the structured content');
  assert.ok(!result.content[0].text.includes('"data"'), 'nor in the text');
  const block = result.content.find(item => item.type === 'image');
  assert.equal(block.mimeType, described.mimeType);
  const bytes = Buffer.from(block.data, 'base64');
  assert.equal(bytes.length, described.bytes);
  return bytes;
}

test('MCP: initialize, list and call the pages\' tools over Streamable HTTP', async t => {
  const { rpc, call } = await start(t);

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.jsonrpc, '2.0');
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.serverInfo.name, 'eyes.tools');
  assert.match(init.result.instructions, /keeps nothing/);
  assert.match(init.result.instructions, /base64/);
  // A version the server lacks is answered with the newest it has.
  assert.equal((await rpc('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, '2025-11-25');
  assert.deepEqual((await rpc('ping')).result, {});

  const { tools } = (await rpc('tools/list', {})).result;
  const names = tools.map(tool => tool.name);
  assert.equal(new Set(names).size, names.length, 'tool names are unique');
  assert.ok(names.length >= 34, 'only ' + names.length + ' tools');
  for (const name of ['hash_text', 'hash_file', 'convert_case', 'calculate', 'convert_color', 'clean_code', 'format_json', 'roll_dice',
    'make_qr_code', 'make_ean13_barcode', 'resize_image', 'read_image_metadata', 'make_spectrogram']) assert.ok(names.includes(name), name);
  // What needs a visitor's scratchpad or share room stays on the pages.
  for (const name of ['read_scratchpad', 'add_to_scratchpad', 'find_tool', 'hash_chosen_file']) assert.ok(!names.includes(name), name);
  for (const tool of tools) {
    assert.match(tool.name, /^[a-z0-9_]{1,64}$/);
    assert.ok(tool.title && tool.description.endsWith('keeps nothing it is sent.'), tool.name);
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name + ' names every input it takes');
    assert.equal(tool.outputSchema.type, 'object', tool.name + ' describes its answer');
    assert.deepEqual([...AgentSchema.unknown(tool.inputSchema), ...AgentSchema.unknown(tool.outputSchema)], [], tool.name);
    for (const [key, property] of Object.entries(tool.inputSchema.properties)) assert.ok(property.description || property.enum, `${tool.name}: ${key} is described`);
    assert.ok(tool.inputSchema.examples && tool.inputSchema.examples.length, tool.name + ' gives an example');
    assert.equal(tool.annotations.readOnlyHint, true, tool.name);
    assert.equal(tool.annotations.destructiveHint, false, tool.name);
  }
  assert.equal(tools.find(tool => tool.name === 'flip_coins').annotations.openWorldHint, true);
  assert.equal(tools.find(tool => tool.name === 'hash_text').annotations.openWorldHint, false);

  // Every tool answers each of its examples, and the answer is what its
  // output schema says. (A drand draw needs the network; the last test has it.)
  for (const tool of tools) {
    for (const example of tool.inputSchema.examples) {
      assert.equal(AgentSchema.check(tool.inputSchema, example), null, tool.name + ' example');
      if (example.source === 'trng') continue;
      const answer = await call(tool.name, example);
      assert.equal(answer.isError, false, `${tool.name}: ${answer.isError && answer.content[0].text}`);
      assert.equal(AgentSchema.check(tool.outputSchema, answer.structuredContent), null, tool.name + ' answer');
      assert.deepEqual(JSON.parse(answer.content[0].text), answer.structuredContent);
    }
  }

  // Answers are the pages' own.
  const hashed = await call('hash_text', { text: 'abc🌍' });
  assert.equal(hashed.isError, false);
  assert.equal(hashed.structuredContent['sha-256'], createHash('sha256').update('abc🌍').digest('hex'));
  assert.equal(hashed.structuredContent.md5, createHash('md5').update('abc🌍').digest('hex'));
  assert.equal((await call('convert_case', { text: 'hello World' })).structuredContent.snake, 'hello_world');
  assert.equal((await call('calculate', { expression: '2^3^2' })).structuredContent.result, 512);
  assert.equal((await call('convert_units', { value: 0, from: 'celsius', to: '°F' })).structuredContent.result, 32);
  assert.deepEqual((await call('convert_color', { color: 'red' })).structuredContent, { hex: '#ff0000', rgb: 'rgb(255 0 0)', hsl: 'hsl(0 100% 50%)', oklch: 'oklch(62.8% 0.25768 29.23)' });
  assert.equal((await call('base64_decode', { base64: 'aGk' })).structuredContent.text, 'hi');
  // Clean code loads each formatter on the server as its page does: Prettier,
  // a WebAssembly one, and sql-formatter, and a formatter's error is a result.
  assert.equal((await call('clean_code', { language: 'typescript', code: 'let a:number=1' })).structuredContent.code, 'let a: number = 1;\n');
  assert.equal((await call('clean_code', { language: 'python', code: 'def f( a ):\n  return a', indent: '2' })).structuredContent.code, 'def f(a):\n  return a\n');
  assert.equal((await call('clean_code', { language: 'cpp', code: 'int main(){return 0;}', indent: '4' })).structuredContent.code, 'int main() { return 0; }');
  assert.equal((await call('clean_code', { language: 'sqlite', code: 'select a from t' })).structuredContent.code, 'select\n  a\nfrom\n  t\n');
  const broken = await call('clean_code', { language: 'go', code: 'package (' });
  assert.equal(broken.isError, true); assert.match(broken.content[0].text, /^[0-9a-z]/);
  assert.equal((await call('convert_time_zone', { dateTime: '2026-11-01T01:30', from: 'America/New_York', to: 'UTC', occurrence: 'later' })).structuredContent.instant, '2026-11-01T06:30:00.000Z');
  const ids = (await call('generate_ids', { kind: 'v4', count: 5 })).structuredContent.ids;
  assert.equal(new Set(ids).size, 5);
  assert.ok(ids.every(value => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)));
  const unique = (await call('random_numbers', { min: -2, max: 2, count: 5, unique: true })).structuredContent;
  assert.deepEqual([...unique.numbers].sort((a, b) => a - b), [-2, -1, 0, 1, 2]);
  assert.equal(unique.verified, false);
  const roll = (await call('roll_dice', { dice: 3, sides: 6, source: 'prng' })).structuredContent;
  assert.equal(roll.rolls.length, 3); assert.equal(roll.total, roll.rolls.reduce((a, b) => a + b));

  // A tool refusing its input is a result the agent reads, with the page's words.
  const refused = await call('calculate', { expression: '1/0' });
  assert.equal(refused.isError, true); assert.match(refused.content[0].text, /zero/);
  // So is input its schema does not allow, said the way the pages say it.
  const says = async (name, args, message) => {
    const result = await call(name, args);
    assert.equal(result.isError, true, name);
    assert.equal(result.content[0].text, message);
  };
  await says('base64_decode', { text: 'aGk' }, 'base64 is required');
  await says('flip_coins', { count: 101 }, 'count must be between 1 and 100');
  await says('flip_coins', { count: '3' }, 'count must be a whole number');
  await says('hash_text', { text: 'x', encoding: 'rot13' }, 'encoding must be hex or base64');
  await says('hash_text', { text: 'x', lenght: 3 }, 'unknown input lenght: this tool takes text, encoding, uppercase and compare');
  await says('clean_code', { language: 'cobol', code: 'x' }, 'language must be one of the 69 values the schema lists, such as javascript, jsx or typescript');
  await says('hash_file', { file: 'not base64!' }, 'file must be base64, or a data: URL with base64 in it');

  // Protocol mistakes are JSON-RPC errors.
  assert.equal((await rpc('tools/call', { name: 'nope' })).error.code, -32602);
  assert.equal((await rpc('tools/call', { name: 'hash_text', arguments: [1] })).error.code, -32602);
  assert.equal((await rpc('tools/call', {})).error.code, -32602);
  assert.equal((await rpc('resources/list', {})).error.code, -32601);
});

test('MCP: files go in as base64 and images come back as image content', async t => {
  const { call } = await start(t);

  // A QR code, as an image and as svg.
  const qr = await call('make_qr_code', { text: 'https://eyes.tools', size: 384 });
  const qrPng = image(qr);
  assert.deepEqual(pngSize(qrPng), [384, 384]);
  assert.match(qr.structuredContent.svg, /^<svg /);
  assert.equal(qr.structuredContent.modules, 25);

  const barcode = await call('make_ean13_barcode', { digits: '400638133393' });
  assert.equal(barcode.structuredContent.number, '4006381333931');
  assert.deepEqual(pngSize(image(barcode)), [904, 424]);

  // The QR code's own PNG, sent back in, as base64 and as a data: URL.
  const resized = await call('resize_image', { image: qrPng.toString('base64'), width: 96, format: 'webp', quality: 70 });
  assert.deepEqual(webpSize(image(resized)), [96, 96]);
  assert.deepEqual([resized.structuredContent.originalWidth, resized.structuredContent.originalHeight, resized.structuredContent.originalFormat], [384, 384, 'png']);
  const converted = await call('resize_image', { image: 'data:image/png;base64,' + qrPng.toString('base64'), format: 'jpeg' });
  assert.equal(converted.structuredContent.width, 384);
  assert.equal(image(converted).subarray(0, 3).toString('hex'), 'ffd8ff');
  const metadata = (await call('read_image_metadata', { image: qrPng.toString('base64') })).structuredContent;
  assert.equal(metadata.type, 'image/png');
  assert.ok(Object.entries(metadata.fields).some(([key, value]) => /image width/i.test(key) && /384/.test(value)), JSON.stringify(metadata.fields));

  // A download's checksum, checked.
  const file = Buffer.from('the file a page offers for download\n');
  const hashed = (await call('hash_file', { file: file.toString('base64'), compare: 'SHA256 (file.txt) = ' + createHash('sha256').update(file).digest('hex') })).structuredContent;
  assert.equal(hashed.bytes, file.length);
  assert.equal(hashed['sha-1'], createHash('sha1').update(file).digest('hex'));
  assert.deepEqual(hashed.comparison, { algorithm: 'sha-256', encoding: 'hex', match: true });

  // A sound, drawn.
  const drawn = await call('make_spectrogram', { audio: wav(0.5, 8000, 1000).toString('base64'), width: 128, height: 64 });
  assert.deepEqual(pngSize(image(drawn)), [128, 64]);
  assert.deepEqual({ ...drawn.structuredContent, image: undefined }, { duration: 0.5, sampleRate: 8000, channels: 1, frequencyMax: 4000, width: 128, height: 64, image: undefined });

  // What the server cannot read is named, with where it can be.
  const bmp = Buffer.from('424d', 'hex');
  assert.match((await call('resize_image', { image: Buffer.concat([bmp, Buffer.alloc(60)]).toString('base64') })).content[0].text, /^send a png, jpeg, webp or gif; this is image\/bmp\. the img page reads more/);
  assert.match((await call('make_spectrogram', { audio: qrPng.toString('base64') })).content[0].text, /^send wav, mp3, flac, ogg vorbis or opus; this is image\/png/);
  assert.match((await call('resize_image', { image: qrPng.toString('base64'), format: 'avif' })).content[0].text, /avif is written on the img page/);
});

test('MCP: one bounded message per POST, from this site or no browser at all', async t => {
  const { base, post } = await start(t, { mcpOptions: { allowedOrigins: 'https://agent.example' } });
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };

  // Notifications and responses are accepted with no body.
  const note = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(note.status, 202); assert.equal(await note.text(), '');
  assert.equal((await post({ jsonrpc: '2.0', id: 7, result: {} })).status, 202);

  // No event stream and no session: GET and DELETE are refused.
  for (const method of ['GET', 'DELETE']) {
    const res = await send(base + '/mcp', { method });
    assert.equal(res.status, 405, method); assert.equal(res.headers.get('allow'), 'POST'); await res.arrayBuffer();
  }
  // It is one path: what merely starts with it is the site's to answer.
  for (const path of ['/mcp/', '/mcp/else', '/mcp-server.mjs', '/mcp-worker.mjs']) {
    const res = await send(base + path);
    assert.equal(res.status, 404, path); assert.match(res.headers.get('content-type'), /text\/html/); await res.arrayBuffer();
  }

  for (const [body, status, code] of [
    ['{nope', 400, -32700],
    [JSON.stringify([ping, ping]), 400, -32600],
    [JSON.stringify({ id: 1, method: 'ping' }), 400, -32600],
    // A message as large as a 10 MB file needs is read; one past 16 MB is not.
    [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(14 * 1024 * 1024) }), 200, null],
    [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(16 * 1024 * 1024) }), 413, -32600]
  ]) {
    const res = await post(body);
    assert.equal(res.status, status, body.slice(0, 40));
    const reply = await res.json();
    if (code === null) { assert.deepEqual(reply.result, {}); continue; }
    assert.equal(reply.error.code, code); assert.equal(reply.id, null);
  }
  const version = await post(ping, { 'MCP-Protocol-Version': '2024-01-01' });
  assert.equal(version.status, 400); await version.arrayBuffer();
  assert.equal((await post(ping, { 'MCP-Protocol-Version': '2025-03-26' })).status, 200);

  // A page on another site cannot drive it through a visitor's browser; the
  // same site and origins the operator lists can, and only those get CORS.
  const host = new URL(base).host;
  const foreign = await post(ping, { Origin: 'https://evil.example' });
  assert.equal(foreign.status, 403); await foreign.arrayBuffer();
  const sneaky = await post(ping, { Origin: 'http://' + host, 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(sneaky.status, 403); await sneaky.arrayBuffer();
  const same = await post(ping, { Origin: 'http://' + host, 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(same.status, 200); assert.equal(same.headers.get('access-control-allow-origin'), null); await same.arrayBuffer();
  const listed = await post(ping, { Origin: 'https://agent.example' });
  assert.equal(listed.status, 200); assert.equal(listed.headers.get('access-control-allow-origin'), 'https://agent.example'); await listed.arrayBuffer();
  const preflight = await send(base + '/mcp', { method: 'OPTIONS', headers: { Origin: 'https://agent.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers'), /MCP-Protocol-Version/);
  // The site's own security headers still apply.
  assert.equal(listed.headers.get('x-content-type-options'), 'nosniff');
});

test('MCP: a call that runs too long is stopped, and its worker replaced', async t => {
  const { call } = await start(t, { mcpOptions: { workers: 2, callTimeout: 150 } });
  // Warm both workers, so what is timed below is the work.
  await Promise.all([call('base64_encode', { text: 'a' }), call('base64_encode', { text: 'b' })]);
  const slow = await call('make_spectrogram', { audio: wav(5, 48000, 440).toString('base64'), width: 2048, height: 1024 });
  assert.equal(slow.isError, true);
  assert.equal(slow.content[0].text, 'the tool took too long; try a smaller input');
  // The other worker answers meanwhile, and the stopped one's replacement after.
  assert.equal((await call('base64_encode', { text: 'hi' })).structuredContent.base64, 'aGk=');
  await new Promise(resolve => setTimeout(resolve, 1500));
  const answers = await Promise.all([1, 2, 3, 4].map(n => call('base64_encode', { text: String(n) })));
  assert.deepEqual(answers.map(answer => answer.structuredContent.base64), ['MQ==', 'Mg==', 'Mw==', 'NA==']);
});

test('MCP: a slow or failing randomness source is an error result, not a hung call', async t => {
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  t.after(() => { globalThis.fetch = send; });
  // The service makes the cores' requests with the fetch it finds when it starts.
  const { call } = await start(t);
  const flip = await call('flip_coins', { count: 2, source: 'trng' });
  assert.equal(flip.isError, true);
  assert.ok(flip.content[0].text.length > 0);
  assert.equal((await call('flip_coins', { count: 2, source: 'csrng' })).isError, false);
});
