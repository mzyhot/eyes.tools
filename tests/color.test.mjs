import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

/* The color page's core, run as the MCP server runs it. */
const html = await readFile(new URL('../t/color.html', import.meta.url), 'utf8');
const scope = {};
runInNewContext(/\/\* ── core\b[^]*?\*\/([^]*?)\/\* ── end core\b/.exec(html)[1], scope);
const convert = scope.AGENT_TOOLS.find(tool => tool.name === 'convert_color').compute;

/* oklch() back to 8-bit sRGB with the reference code of CSS Color 4
   (conversions.js), in double precision. */
const mul = (M, v) => M.map(row => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
const LAB_LMS = [[1, 0.3963377773761749, 0.2158037573099136], [1, -0.1055613458156586, -0.0638541728258133], [1, -0.0894841775298119, -1.2914855480194092]];
const LMS_XYZ = [[1.2268798758459243, -0.5578149944602171, 0.2813910456659647], [-0.0405757452148008, 1.1122868032803170, -0.0717110580655164], [-0.0763729366746601, -0.4214933324022432, 1.5869240198367816]];
const XYZ_RGB = [[12831 / 3959, -329 / 214, -1974 / 3959], [-851781 / 878810, 1648619 / 878810, 36519 / 878810], [705 / 12673, -2585 / 12673, 705 / 667]];
const gamma = v => Math.sign(v) * (Math.abs(v) > 0.0031308 ? 1.055 * Math.pow(Math.abs(v), 1 / 2.4) - 0.055 : 12.92 * Math.abs(v));
function toRgb(oklch) {
  const [, l, c, h] = /^oklch\(([\d.]+)% ([\d.]+) ([\d.]+)\)$/.exec(oklch).map(Number);
  const lab = [l / 100, c * Math.cos(h * Math.PI / 180), c * Math.sin(h * Math.PI / 180)];
  /* `+ 0` turns the -0 a hair-below-zero channel rounds to into 0. */
  return mul(XYZ_RGB, mul(LMS_XYZ, mul(LAB_LMS, lab).map(v => v ** 3))).map(v => Math.round(gamma(v) * 255) + 0);
}

test('every color the page writes as oklch converts back to itself exactly, with room for a browser\'s drift', () => {
  /* All 16,777,216 colors pass; this grid runs in a moment. It is dense where
     a channel is dark, where the fewest digits stand between neighbours. The
     browser suite paints the riskiest in Chromium itself. */
  const steps = [...Array(17).keys(), ...Array.from({ length: 40 }, (_, i) => 17 + i * 6), 254, 255];
  let checked = 0;
  for (const r of steps) for (const g of steps) for (const b of steps) {
    const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
    const { oklch } = convert({ color: hex });
    assert.deepEqual(toRgb(oklch), [r, g, b], `${hex} became ${oklch}`);
    const [, l, c, h] = /^oklch\(([\d.]+)% ([\d.]+) ([\d.]+)\)$/.exec(oklch).map(Number);
    const room = scope.room(scope.fromOklab([l / 100, c * Math.cos(h * Math.PI / 180), c * Math.sin(h * Math.PI / 180)]), [r, g, b]);
    assert.ok(room.read > 0, `${hex} as ${oklch} leaves no room for a browser's drift`);
    checked++;
  }
  assert.ok(checked > 190000);
});

test('oklch matches the published values and writes greys without a hue', () => {
  assert.equal(convert({ color: 'red' }).oklch, 'oklch(62.8% 0.25768 29.23)');
  assert.equal(convert({ color: 'white' }).oklch, 'oklch(100% 0 0)');
  assert.equal(convert({ color: 'black' }).oklch, 'oklch(0% 0 0)');
  assert.equal(convert({ color: '#808080' }).oklch, 'oklch(59.99% 0 0)');
});
