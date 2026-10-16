/**
 * Regression tests for helpers/filter.ts.
 *
 * Covers two fixes:
 *  - prototype pollution via caller-supplied include_fields/exclude_fields paths
 *  - dot-notation include paths producing the wrong *value shape*
 *
 * The pre-existing suite only asserted key presence ("'entries' in out.latest_event"),
 * which passed against the buggy double-nesting too. These assert the value.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';

process.env.SENTRY_URL = process.env.SENTRY_URL || 'https://example.sentry.local';
process.env.SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN || 'test-token';
process.env.SENTRY_ORG_SLUG = process.env.SENTRY_ORG_SLUG || 'test-org';

const { filterObjectFields } = await import('../../build/helpers/filter.js');

/** Property names a polluting payload would try to graft onto Object.prototype. */
const POLLUTION_KEYS = ['polluted', 'pwned', 'isAdmin'];

describe('helpers/filter — prototype pollution', () => {
  afterEach(() => {
    // Never let a failure here leak into other tests in this process.
    for (const key of POLLUTION_KEYS) delete Object.prototype[key];
  });

  it('does not write to Object.prototype via a "__proto__" include path', () => {
    filterObjectFields({ id: '1' }, ['__proto__.polluted']);

    assert.strictEqual(
      Object.getOwnPropertyDescriptor(Object.prototype, 'polluted'),
      undefined,
      'include_fields ["__proto__.polluted"] must not define a property on Object.prototype'
    );
    assert.strictEqual({}.polluted, undefined, 'a fresh object must not inherit the injected key');
  });

  it('does not write to Object.prototype via a "constructor.prototype" include path', () => {
    filterObjectFields({ id: '1' }, ['constructor.prototype.pwned']);

    assert.strictEqual(Object.getOwnPropertyDescriptor(Object.prototype, 'pwned'), undefined);
    assert.strictEqual({}.pwned, undefined);
  });

  it('does not write to Object.prototype via an exclude path', () => {
    filterObjectFields({ id: '1' }, undefined, ['__proto__.isAdmin']);

    assert.strictEqual(Object.getOwnPropertyDescriptor(Object.prototype, 'isAdmin'), undefined);
    assert.strictEqual({}.isAdmin, undefined);
  });

  it('drops unsafe field paths instead of emitting them', () => {
    const out = filterObjectFields({ id: '1', safe: 'keep' }, ['__proto__.polluted', 'safe']);

    assert.deepStrictEqual(out, { safe: 'keep' }, 'only the safe path should survive');
    assert.ok(!Object.prototype.hasOwnProperty.call(out, '__proto__'));
  });

  it('leaves the prototype chain of its own result intact', () => {
    const out = filterObjectFields({ a: 1 }, ['__proto__']);

    assert.strictEqual(Object.getPrototypeOf(out), Object.prototype);
  });
});

describe('helpers/filter — include_fields dot notation', () => {
  it('keeps the nested value itself, not a copy re-wrapped under its own key', () => {
    const input = {
      id: '1',
      title: 'err',
      latest_event: { entries: [1, 2], tags: ['a'] },
    };

    const out = filterObjectFields(input, ['id', 'latest_event.entries']);

    // The whole point: latest_event.entries is the array, not { entries: [...] }.
    assert.deepStrictEqual(out, { id: '1', latest_event: { entries: [1, 2] } });
  });

  it('keeps sibling nested paths under a single parent', () => {
    const out = filterObjectFields({ a: { b: 1, c: 2, d: 3 } }, ['a.b', 'a.c']);

    assert.deepStrictEqual(out, { a: { b: 1, c: 2 } });
  });

  it('supports paths nested more than two levels deep', () => {
    const input = { latest_event: { entries: { exception: { values: [1] }, other: 'drop' } } };

    const out = filterObjectFields(input, ['latest_event.entries.exception']);

    assert.deepStrictEqual(out, { latest_event: { entries: { exception: { values: [1] } } } });
  });

  it('applies nested include paths to each element of an array', () => {
    const input = [
      { id: '1', meta: { keep: 'a', drop: 'x' } },
      { id: '2', meta: { keep: 'b', drop: 'y' } },
    ];

    const out = filterObjectFields(input, ['id', 'meta.keep']);

    assert.deepStrictEqual(out, [
      { id: '1', meta: { keep: 'a' } },
      { id: '2', meta: { keep: 'b' } },
    ]);
  });

  it('omits a nested path whose parent is absent', () => {
    const out = filterObjectFields({ id: '1' }, ['id', 'latest_event.entries']);

    assert.deepStrictEqual(out, { id: '1' });
  });

  it('still removes nested fields through exclude_fields', () => {
    const input = { id: '1', latest_event: { entries: [1], tags: ['a'] } };

    const out = filterObjectFields(input, undefined, ['latest_event.tags']);

    assert.deepStrictEqual(out, { id: '1', latest_event: { entries: [1] } });
  });
});
