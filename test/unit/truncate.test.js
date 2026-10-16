/**
 * Regression tests for helpers/truncate.ts.
 *
 * The fix: an over-budget payload is never returned intact. Slicing the known
 * large array fields is not a budget — whatever remains can still be arbitrarily
 * big — so anything still over the cap now gets a real hard cut, and `truncated`
 * reports whether content was actually removed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

process.env.SENTRY_URL = process.env.SENTRY_URL || 'https://example.sentry.local';
process.env.SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN || 'test-token';
process.env.SENTRY_ORG_SLUG = process.env.SENTRY_ORG_SLUG || 'test-org';

const { truncateResponse } = await import('../../build/helpers/truncate.js');

/** The same estimator the implementation budgets against: 1 token ~ 4 chars. */
const estimateTokens = (value) => Math.ceil(JSON.stringify(value, null, 2).length / 4);

describe('helpers/truncate — the budget is actually enforced', () => {
  it('hard-cuts an object whose bulk is not in a known large-array field', () => {
    // No 'entries'/'frames'/'breadcrumbs' array to slice, so structural trimming
    // has nothing to remove and the cap has to be enforced explicitly.
    const budget = 100;
    const data = { id: '1', blob: 'z'.repeat(40_000) };

    const result = truncateResponse(data, budget);

    assert.strictEqual(result.truncated, true, 'an over-budget payload must report truncated');
    assert.ok(
      estimateTokens(result.data) <= budget,
      `result must fit the ${budget} token budget, got ~${estimateTokens(result.data)}`
    );
  });

  it('marks the hard-cut envelope so a client can tell the payload is incomplete', () => {
    const result = truncateResponse({ id: '1', blob: 'z'.repeat(40_000) }, 100);

    assert.strictEqual(result.data._truncated, true);
    assert.match(String(result.data._truncation_note), /truncat/i);
    assert.match(String(result.data._content_preview), /\[truncated\]$/);
  });

  it('enforces the budget even when large fields were sliced but bulk remains', () => {
    const budget = 200;
    const data = {
      entries: Array.from({ length: 50 }, (_, i) => ({ i })),
      leftover: 'q'.repeat(30_000),
    };

    const result = truncateResponse(data, budget);

    assert.strictEqual(result.truncated, true);
    assert.ok(estimateTokens(result.data) <= budget, `got ~${estimateTokens(result.data)} tokens`);
  });

  it('hard-cuts an array whose single surviving item is still oversized', () => {
    const budget = 100;
    const data = [{ id: '1', blob: 'z'.repeat(40_000) }];

    const result = truncateResponse(data, budget);

    assert.strictEqual(result.truncated, true);
    assert.ok(estimateTokens(result.data) <= budget, `got ~${estimateTokens(result.data)} tokens`);
  });

  it('hard-cuts an oversized primitive', () => {
    const budget = 100;

    const result = truncateResponse('y'.repeat(40_000), budget);

    assert.strictEqual(result.truncated, true);
    assert.ok(estimateTokens(result.data) <= budget, `got ~${estimateTokens(result.data)} tokens`);
  });

  it('brings a truncated array within budget', () => {
    const budget = 200;
    const data = Array.from({ length: 500 }, (_, i) => ({ id: i, text: `item-${i}` }));

    const result = truncateResponse(data, budget);

    assert.strictEqual(result.truncated, true);
    assert.ok(estimateTokens(result.data) <= budget, `got ~${estimateTokens(result.data)} tokens`);
    assert.match(result.pagination_info, /Response truncated/i);
  });
});

describe('helpers/truncate — `truncated` reflects reality', () => {
  it('is false, with the payload untouched, when it already fits', () => {
    const data = { ok: true, items: [1, 2, 3] };

    const result = truncateResponse(data, 10_000);

    assert.strictEqual(result.truncated, false);
    assert.deepStrictEqual(result.data, data);
    assert.strictEqual(result.pagination_info, undefined);
  });

  it('is true whenever the returned payload differs from the input', () => {
    const data = { id: '1', blob: 'z'.repeat(40_000) };

    const result = truncateResponse(data, 100);

    assert.notDeepStrictEqual(result.data, data);
    assert.strictEqual(result.truncated, true);
  });

  it('reports a pagination hint whenever it truncates', () => {
    const result = truncateResponse({ id: '1', blob: 'z'.repeat(40_000) }, 100);

    assert.ok(result.pagination_info, 'a truncated response must explain how to get the rest');
  });

  it('slices known large arrays and says so', () => {
    const data = { breadcrumbs: Array.from({ length: 40 }, (_, i) => ({ i, msg: 'm'.repeat(200) })) };

    const result = truncateResponse(data, 400);

    assert.strictEqual(result.truncated, true);
    assert.ok(estimateTokens(result.data) <= 400, `got ~${estimateTokens(result.data)} tokens`);
  });
});
