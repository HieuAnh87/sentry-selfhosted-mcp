import { describe, it } from 'node:test';
import assert from 'node:assert';

process.env.SENTRY_URL = process.env.SENTRY_URL || 'https://example.sentry.local';
process.env.SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN || 'test-token';
process.env.SENTRY_ORG_SLUG = process.env.SENTRY_ORG_SLUG || 'test-org';

const {
  truncateResponse,
  truncateStackTraces,
} = await import('../../build/helpers/truncate.js');
const {
  filterObjectFields,
  extractEssentialIssueFields,
  extractEssentialEventEntry,
  extractBreadcrumbs,
} = await import('../../build/helpers/filter.js');
const { grepFilter } = await import('../../build/helpers/grep.js');

describe('helpers/truncate', () => {
  it('returns unmodified payload when under token limit', () => {
    const data = { ok: true, items: [1, 2, 3] };
    const result = truncateResponse(data, 10000);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.data, data);
  });

  it('truncates arrays when over token limit', () => {
    const data = Array.from({ length: 100 }, (_, i) => ({ id: i, text: `item-${i}` }));
    const result = truncateResponse(data, 20);
    assert.equal(result.truncated, true);
    assert.ok(Array.isArray(result.data));
    assert.ok(result.data.length < data.length);
    assert.match(result.pagination_info || '', /Response truncated/i);
  });

  it('truncates nested exception stack frames from the bottom', () => {
    const frames = Array.from({ length: 8 }, (_, i) => ({ filename: `f${i}.ts`, function: `fn${i}` }));
    const payload = {
      entries: [{ type: 'exception', data: { values: [{ stacktrace: { frames } }] } }],
    };

    const truncated = truncateStackTraces(payload, 3);
    const outFrames = truncated.entries[0].data.values[0].stacktrace.frames;
    assert.equal(outFrames.length, 3);
    assert.equal(truncated.entries[0].data.values[0].stacktrace.frames_omitted, 5);
    assert.equal(outFrames[0].function, 'fn5');
  });
});

describe('helpers/filter', () => {
  it('supports include_fields with dot notation', () => {
    const input = {
      id: '1',
      title: 'err',
      latest_event: { entries: [1, 2], tags: ['a'] },
    };

    const out = filterObjectFields(input, ['id', 'latest_event.entries']);
    assert.equal(out.id, '1');
    assert.ok(out.latest_event);
    assert.ok('entries' in out.latest_event);
    assert.ok(!('title' in out));
  });

  it('extracts essential issue fields and adds note for large fields', () => {
    const issue = {
      id: '10',
      title: 'boom',
      shortId: 'ABC-10',
      tags: [{ k: 'env', v: 'prod' }],
    };
    const out = extractEssentialIssueFields(issue);
    assert.equal(out.id, '10');
    assert.equal(out.title, 'boom');
    assert.match(String(out._note), /truncated/i);
  });

  it('extracts breadcrumbs and respects type filter + limit', () => {
    const event = {
      entries: [
        {
          type: 'breadcrumbs',
          data: {
            values: [
              { type: 'http', message: 'GET /a' },
              { type: 'navigation', message: 'push /b' },
              { type: 'http', message: 'GET /c' },
            ],
          },
        },
      ],
    };

    const crumbs = extractBreadcrumbs(event, 1, 'http');
    assert.equal(crumbs.length, 1);
    assert.equal(crumbs[0].type, 'http');
  });

  it('extractEssentialEventEntry truncates unknown entry types', () => {
    const out = extractEssentialEventEntry({ type: 'foo', data: { x: 1 } });
    assert.equal(out.type, 'foo');
    assert.equal(out._truncated, true);
  });
});

describe('helpers/grep', () => {
  it('returns original data when pattern is empty', () => {
    const data = { a: 1 };
    assert.deepEqual(grepFilter(data, ''), data);
  });

  it('returns error object for invalid regex', () => {
    const out = grepFilter({ a: 1 }, '[abc');
    assert.ok(out.error);
  });
});
