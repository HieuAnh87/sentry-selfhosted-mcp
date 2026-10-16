/**
 * Regression tests for helpers/grep.ts.
 *
 * Covers two fixes:
 *  - the stateful /g regex: RegExp.prototype.test() advances lastIndex, so
 *    testing consecutive lines with one regex silently skipped every other
 *    match, and total_matches was derived as floor(lines/3) rather than counted
 *  - catastrophic backtracking: patterns that can blow up are now refused
 *    structurally, before they ever run
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

process.env.SENTRY_URL = process.env.SENTRY_URL || 'https://example.sentry.local';
process.env.SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN || 'test-token';
process.env.SENTRY_ORG_SLUG = process.env.SENTRY_ORG_SLUG || 'test-org';

const { grepFilter, generateGrepSuggestions } = await import('../../build/helpers/grep.js');

/**
 * Eight matching lines that are *adjacent* once serialized. Adjacency is what
 * exposes a stateful regex: a non-matching line in between would reset
 * lastIndex and hide the bug.
 */
const ADJACENT_MATCHES = { logs: Array.from({ length: 8 }, (_, i) => `needle line ${i}`) };

describe('helpers/grep — match counting', () => {
  it('counts every adjacent matching line, not every other one', () => {
    const out = grepFilter(ADJACENT_MATCHES, 'needle');

    assert.strictEqual(
      out.total_matches,
      8,
      'all 8 adjacent matching lines must be counted; a stateful /g regex reports 4'
    );
  });

  it('reports total_matches as a real count rather than a line-count guess', () => {
    // One single match: the old floor(matchingLines.length / 3) arithmetic
    // cannot represent this correctly at a document boundary.
    const out = grepFilter({ logs: ['alpha', 'unique_needle', 'beta'] }, 'unique_needle');

    assert.strictEqual(out.total_matches, 1);
  });

  it('emits each context line at most once', () => {
    const out = grepFilter(ADJACENT_MATCHES, 'needle');
    const unique = new Set(out.grep_results);

    assert.strictEqual(
      out.grep_results.length,
      unique.size,
      `context lines must be de-duplicated, got duplicates: ${JSON.stringify(out.grep_results)}`
    );
  });

  it('returns the matching lines plus one line of context on each side, in order', () => {
    const out = grepFilter(ADJACENT_MATCHES, 'needle');
    const allLines = JSON.stringify(ADJACENT_MATCHES, null, 2).split('\n');
    const matchIndexes = allLines.map((line, i) => (/needle/i.test(line) ? i : -1)).filter((i) => i >= 0);

    const expectedIndexes = new Set();
    for (const i of matchIndexes) {
      if (i > 0) expectedIndexes.add(i - 1);
      expectedIndexes.add(i);
      if (i < allLines.length - 1) expectedIndexes.add(i + 1);
    }
    const expected = [...expectedIndexes].sort((a, b) => a - b).map((i) => allLines[i]);

    assert.deepStrictEqual(out.grep_results, expected);
  });

  it('returns parsed JSON when the filtered slice is itself valid JSON', () => {
    // Every line matches, so the context window covers the whole document and
    // it round-trips: grepFilter hands back structured data, not the envelope.
    const data = { a: 'x_marker', b: 'x_marker', c: 'x_marker' };

    assert.deepStrictEqual(grepFilter(data, 'x_marker'), data);
  });

  it('is case-insensitive', () => {
    const out = grepFilter({ logs: ['NEEDLE'] }, 'needle');

    assert.strictEqual(out.total_matches, 1);
  });

  it('returns no matches for a pattern that is absent', () => {
    const out = grepFilter({ logs: ['alpha', 'beta'] }, 'nothing_here');

    assert.strictEqual(out.total_matches, 0);
    assert.deepStrictEqual(out.grep_results, []);
  });
});

describe('helpers/grep — catastrophic backtracking', () => {
  /**
   * A subject that makes each of these patterns blow up if it is ever executed.
   *
   * Deliberately kept to 26 repeats: long enough that running the pattern is
   * unmistakably catastrophic (~2^26 backtracking states, measured at ~0.7s
   * against the unguarded implementation), short enough that a regression which
   * removes the guard still *fails* this test in under a second instead of
   * hanging CI for hours. At 40 repeats it never returns at all.
   */
  const EVIL_SUBJECT = { s: `${'a'.repeat(26)}!`, t: `${'x'.repeat(26)}!` };

  const CATASTROPHIC = ['(a+)+$', '(x+x+)+y', 'a+a+a+$'];

  for (const pattern of CATASTROPHIC) {
    it(`rejects ${pattern} instead of running it`, () => {
      const started = Date.now();
      const out = grepFilter(EVIL_SUBJECT, pattern);
      const elapsed = Date.now() - started;

      assert.ok(out && out.error, `pattern ${pattern} must be refused with an error object`);
      assert.strictEqual(out.original_pattern, pattern);
      // The rejection is structural (the pattern never runs), so it must not
      // depend on the scan deadline firing.
      assert.ok(elapsed < 2000, `rejection must be immediate, took ${elapsed}ms`);
    });
  }

  it('rejects a nested quantifier inside a repeated group with an actionable reason', () => {
    const out = grepFilter(EVIL_SUBJECT, '(a+)+$');

    assert.match(out.error, /backtrack/i);
  });

  it('still accepts every pattern the server suggests to callers', () => {
    // Parsed from the suggestion text rather than hardcoded, so a new suggestion
    // that the ReDoS guard would refuse fails here instead of failing a user.
    const suggested = [...generateGrepSuggestions().matchAll(/'([^']+)'/g)].map((m) => m[1]);

    assert.strictEqual(suggested.length, 5, `expected 5 suggested patterns, got ${suggested.length}`);

    for (const pattern of suggested) {
      const out = grepFilter({ sample: 'value' }, pattern);
      assert.ok(
        !(out && out.error),
        `suggested pattern ${pattern} must be accepted, got: ${out && out.error}`
      );
    }
  });

  it('accepts ordinary patterns containing quantifiers', () => {
    for (const pattern of ['.*timeout.*', '[a-z]+_[a-z]+', '"function":', 'err(or)?']) {
      const out = grepFilter({ msg: 'connection timeout in db_pool' }, pattern);
      assert.ok(!(out && out.error), `pattern ${pattern} should be accepted, got: ${out && out.error}`);
    }
  });

  it('rejects an over-long pattern', () => {
    const out = grepFilter({ a: 1 }, 'a'.repeat(501));

    assert.match(out.error, /too long/i);
  });

  it('returns an error object for an invalid regex', () => {
    const out = grepFilter({ a: 1 }, '[abc');

    assert.match(out.error, /invalid regex/i);
  });

  it('returns the data untouched for an empty pattern', () => {
    const data = { a: 1 };

    assert.deepStrictEqual(grepFilter(data, ''), data);
  });
});
