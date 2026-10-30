import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

/* The checker as both its callers load it: a classic script, run alone. */
const scope = {};
runInNewContext(await readFile(new URL('../agent-schema.js', import.meta.url), 'utf8'), scope);
const { check, unknown } = scope.AgentSchema;

const schema = {
  type: 'object',
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 10 },
    count: { type: 'integer', minimum: 1, maximum: 100 },
    ratio: { type: 'number', minimum: 0 },
    loud: { type: 'boolean' },
    encoding: { type: 'string', enum: ['hex', 'base64'] },
    size: { type: 'integer', enum: [192, 256] },
    code: { type: 'string', pattern: '^[0-9]+$' },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
    when: { type: ['string', 'null'] },
    either: { anyOf: [{ type: 'integer', maximum: 5 }, { type: 'string', enum: ['all'] }] },
    nested: { type: 'object', properties: { x: { type: 'integer' } }, required: ['x'], additionalProperties: false }
  },
  required: ['text'],
  additionalProperties: false
};

test('a good input passes', () => {
  assert.equal(check(schema, { text: 'hi' }), null);
  assert.equal(check(schema, { text: 'hi', count: 100, ratio: 0.5, loud: false, encoding: 'hex', size: 256, code: '42', tags: ['a', 'b'], when: null, either: 'all', nested: { x: 1 } }), null);
  assert.equal(check(schema, { text: 'hi', either: 3, when: 'now' }), null);
});

test('each mistake is named, in the site\'s words', () => {
  const says = (input, message) => assert.equal(check(schema, input), message, JSON.stringify(input));
  says([], 'the input must be an object');
  says({}, 'text is required');
  says({ text: '' }, 'text must not be empty');
  says({ text: 'x'.repeat(11) }, 'text must be at most 10 characters long');
  says({ text: 5 }, 'text must be text');
  says({ text: 'hi', count: '5' }, 'count must be a whole number');
  says({ text: 'hi', count: 2.5 }, 'count must be a whole number');
  says({ text: 'hi', count: 101 }, 'count must be between 1 and 100');
  says({ text: 'hi', ratio: -1 }, 'ratio must be at least 0');
  says({ text: 'hi', loud: 'yes' }, 'loud must be true or false');
  says({ text: 'hi', encoding: 'rot13' }, 'encoding must be hex or base64');
  says({ text: 'hi', size: 300 }, 'size must be 192 or 256');
  says({ text: 'hi', code: '4a' }, 'code must match ^[0-9]+$');
  says({ text: 'hi', tags: ['a', 'b', 'c'] }, 'tags must have at most 2 items');
  says({ text: 'hi', tags: ['a', 1] }, 'tags[1] must be text');
  says({ text: 'hi', when: 3 }, 'when must be text or null');
  says({ text: 'hi', either: 9 }, 'either must be at most 5');
  says({ text: 'hi', either: 'some' }, 'either must be all');
  says({ text: 'hi', nested: {} }, 'nested.x is required');
  says({ text: 'hi', nested: { x: 1, y: 2 } }, 'unknown field nested.y: nested takes x');
  says({ text: 'hi', lenght: 3 }, 'unknown input lenght: this tool takes text, count, ratio, loud, encoding, size, code, tags, when, either and nested');
});

test('a long list of choices is summed up, not recited', () => {
  const many = { type: 'object', properties: { language: { type: 'string', enum: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] } } };
  assert.equal(check(many, { language: 'z' }), 'language must be one of the 9 values the schema lists, such as a, b or c');
});

test('a keyword the checker would skip is reported', () => {
  assert.deepEqual([...unknown(schema)], []);
  assert.deepEqual([...unknown({ type: 'object', properties: { a: { type: 'string', format: 'email' } }, oneOf: [] })], ['schema.oneOf', 'schema.properties.a.format']);
});
