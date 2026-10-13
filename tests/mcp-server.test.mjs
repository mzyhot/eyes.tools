import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createEyesServer } from '../dev-server.mjs';

// One test stands in for the network; the requests the tests send are real.
const send = globalThis.fetch;

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

test('MCP: initialize, list and call the pages\' tools over Streamable HTTP', async t => {
  const { rpc, call } = await start(t);

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.jsonrpc, '2.0');
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.serverInfo.name, 'eyes.tools');
  assert.match(init.result.instructions, /keeps nothing/);
  // A version the server lacks is answered with the newest it has.
  assert.equal((await rpc('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, '2025-11-25');
  assert.deepEqual((await rpc('ping')).result, {});

  const { tools } = (await rpc('tools/list', {})).result;
  const names = tools.map(tool => tool.name);
  assert.equal(new Set(names).size, names.length, 'tool names are unique');
  assert.ok(names.length >= 25, 'only ' + names.length + ' tools');
  for (const name of ['hash_text', 'convert_case', 'calculate', 'convert_color', 'clean_code', 'format_json', 'roll_dice', 'make_qr_code']) assert.ok(names.includes(name), name);
  // What needs a visitor's own file, scratchpad or share room stays on the pages.
  for (const name of ['hash_chosen_file', 'resize_image', 'read_image_metadata', 'read_scratchpad', 'add_to_scratchpad', 'find_tool']) assert.ok(!names.includes(name), name);
  for (const tool of tools) {
    assert.match(tool.name, /^[a-z0-9_]{1,64}$/);
    assert.ok(tool.title && tool.description.endsWith('keeps nothing it is sent.'), tool.name);
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.equal(tool.annotations.readOnlyHint, true, tool.name);
    assert.equal(tool.annotations.destructiveHint, false, tool.name);
  }
  assert.equal(tools.find(tool => tool.name === 'flip_coins').annotations.openWorldHint, true);
  assert.equal(tools.find(tool => tool.name === 'hash_text').annotations.openWorldHint, false);

  // Answers are the pages' own, as structured content and as text.
  const hashed = await call('hash_text', { text: 'abc🌍' });
  assert.equal(hashed.isError, false);
  assert.equal(hashed.structuredContent['sha-256'], createHash('sha256').update('abc🌍').digest('hex'));
  assert.equal(hashed.structuredContent.md5, createHash('md5').update('abc🌍').digest('hex'));
  assert.deepEqual(JSON.parse(hashed.content[0].text), hashed.structuredContent);
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
  assert.equal((await call('clean_code', { language: 'cobol', code: 'x' })).content[0].text, 'pick a language from the list');
  assert.equal((await call('convert_time_zone', { dateTime: '2026-11-01T01:30', from: 'America/New_York', to: 'UTC', occurrence: 'later' })).structuredContent.instant, '2026-11-01T06:30:00.000Z');
  assert.equal((await call('make_ean13_barcode', { digits: '400638133393' })).structuredContent.number, '4006381333931');
  assert.match((await call('make_qr_code', { text: 'https://eyes.tools' })).structuredContent.svg, /^<svg /);
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
  assert.match((await call('flip_coins', { count: 101 })).content[0].text, /between 1 and 100/);
  assert.match((await call('hash_text', { text: 'x', encoding: 'rot13' })).content[0].text, /hex or base64/);
  // So is leaving out what a tool requires.
  const missing = await call('base64_decode', { text: 'aGk' });
  assert.equal(missing.isError, true); assert.equal(missing.content[0].text, 'base64 is required');

  // Protocol mistakes are JSON-RPC errors.
  assert.equal((await rpc('tools/call', { name: 'nope' })).error.code, -32602);
  assert.equal((await rpc('tools/call', { name: 'hash_text', arguments: [1] })).error.code, -32602);
  assert.equal((await rpc('tools/call', {})).error.code, -32602);
  assert.equal((await rpc('resources/list', {})).error.code, -32601);
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
  for (const path of ['/mcp/', '/mcp/else', '/mcp-server.mjs']) {
    const res = await send(base + path);
    assert.equal(res.status, 404, path); assert.match(res.headers.get('content-type'), /text\/html/); await res.arrayBuffer();
  }

  for (const [body, status, code] of [
    ['{nope', 400, -32700],
    [JSON.stringify([ping, ping]), 400, -32600],
    [JSON.stringify({ id: 1, method: 'ping' }), 400, -32600],
    [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(1024 * 1024) }), 413, -32600]
  ]) {
    const res = await post(body);
    assert.equal(res.status, status, body.slice(0, 40));
    const reply = await res.json();
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

test('MCP: a slow or failing randomness source is an error result, not a hung call', async t => {
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  t.after(() => { globalThis.fetch = send; });
  // The service hands the pages' cores the fetch it finds when it loads them.
  const { call } = await start(t);
  const flip = await call('flip_coins', { count: 2, source: 'trng' });
  assert.equal(flip.isError, true);
  assert.ok(flip.content[0].text.length > 0);
  assert.equal((await call('flip_coins', { count: 2, source: 'csrng' })).isError, false);
});
