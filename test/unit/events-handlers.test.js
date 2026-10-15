/**
 * Event tool handlers against Sentry's real response shapes, with HTTP mocked by nock.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import nock from 'nock';

process.env.SENTRY_URL = 'https://sentry.test.local';
process.env.SENTRY_AUTH_TOKEN = 'test-token';
process.env.SENTRY_ORG_SLUG = 'org';

const {
  handleGetSentryEventDetails,
  handleGetStackFrames,
  handleListBreadcrumbs,
  handleListIssueEvents,
  handleListErrorEvents,
} = await import('../../build/tools/events.js');

const BASE = 'https://sentry.test.local';
const EVENT_PATH = '/api/0/projects/org/web/events/abc/';

const json = (result, block = 0) => JSON.parse(result.content[block].text);

const frame = (fn, inApp) => ({ function: fn, filename: `${fn}.js`, lineNo: 3, colNo: 0, inApp });

const mockEvent = (event) => nock(BASE).get(EVENT_PATH).reply(200, { id: 'abc', eventID: 'abc', ...event });

describe('get_stack_frames', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  it('in_app_only keeps frames Sentry marks with camelCase inApp', async () => {
    mockEvent({
      entries: [{
        type: 'exception',
        data: { values: [{ stacktrace: { frames: [frame('lib', false), frame('app', true), frame('vendor', null)] } }] },
      }],
    });

    const out = json(await handleGetStackFrames({ project_slug: 'web', event_id: 'abc', in_app_only: true }));

    assert.strictEqual(out.total_frames, 1);
    assert.strictEqual(out.frames[0].function, 'app');
    assert.strictEqual(out.frames[0].in_app, true);
    assert.strictEqual(out.frames[0].col_no, 0, 'a zero column must not become null');
  });

  it('falls back to the crashed thread when the exception has no stack trace', async () => {
    mockEvent({
      entries: [
        { type: 'exception', data: { values: [{ type: 'SIGSEGV', threadId: 2, stacktrace: null }] } },
        {
          type: 'threads',
          data: {
            values: [
              { id: 1, name: 'main', current: true, stacktrace: { frames: [frame('idle', false)] } },
              { id: 2, name: 'worker', crashed: true, stacktrace: { frames: [frame('crash', true)] } },
            ],
          },
        },
      ],
    });

    const out = json(await handleGetStackFrames({ project_slug: 'web', event_id: 'abc' }));

    assert.deepStrictEqual(out.frames.map(f => f.function), ['crash']);
    assert.match(out._note, /thread/);
  });
});

describe('get_sentry_event_details', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  const entries = [
    { type: 'debugmeta', data: { images: [] } },
    { type: 'breadcrumbs', data: { values: [{ message: 'b' }] } },
    { type: 'exception', data: { values: [{ type: 'E', stacktrace: { frames: [] } }] } },
    { type: 'request', data: { method: 'GET', url: 'https://x/', headers: [['Cookie', 'SECRET']] } },
  ];

  it('applies offset without entry_type, over the prioritized order', async () => {
    mockEvent({ entries });

    const out = json(await handleGetSentryEventDetails({ project_slug: 'web', event_id: 'abc', offset: 1, limit: 2 }));

    assert.deepStrictEqual(out.entries.map(e => e.type), ['breadcrumbs', 'request']);
    assert.strictEqual(out.pagination_info.offset, 1);
    assert.strictEqual(out.pagination_info.next_offset, 3);
    assert.ok(!JSON.stringify(out).includes('SECRET'), 'request cookies must not leak');
  });

  it("returns the top-level contexts for entry_type 'contexts'", async () => {
    mockEvent({
      entries,
      contexts: { os: { name: 'Linux', version: '6.1' }, runtime: { name: 'node', version: '20' } },
    });

    const out = json(await handleGetSentryEventDetails({ project_slug: 'web', event_id: 'abc', entry_type: 'contexts' }));

    assert.deepStrictEqual(out.contexts.os, { name: 'Linux', version: '6.1' });
    assert.deepStrictEqual(out.entries, []);
    assert.strictEqual(out.entriesError, undefined);
    assert.strictEqual(out._contexts_removed, undefined);
  });

  it('still strips contexts in the default mode', async () => {
    mockEvent({ entries, contexts: { os: { name: 'Linux' } } });

    const out = json(await handleGetSentryEventDetails({ project_slug: 'web', event_id: 'abc' }));

    assert.strictEqual(out.contexts, undefined);
    assert.strictEqual(out._contexts_removed, true);
  });
});

describe('list_breadcrumbs', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  it('returns the most recent breadcrumbs and the pre-limit total', async () => {
    mockEvent({
      entries: [{ type: 'breadcrumbs', data: { values: Array.from({ length: 12 }, (_, i) => ({ message: `c${i}` })) } }],
    });

    const out = json(await handleListBreadcrumbs({ project_slug: 'web', event_id: 'abc', limit: 3 }));

    assert.strictEqual(out.total_breadcrumbs, 12);
    assert.strictEqual(out.returned_breadcrumbs, 3);
    assert.deepStrictEqual(out.breadcrumbs.map(c => c.message), ['c9', 'c10', 'c11']);
  });
});

describe('list_issue_events / list_error_events', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  const link = (cursor) =>
    `<${BASE}/x/?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", ` +
    `<${BASE}/x/?cursor=${cursor}>; rel="next"; results="true"; cursor="${cursor}"`;

  it('pages with per_page, normalizes object tags, and appends the pagination block', async () => {
    nock(BASE)
      .get('/api/0/organizations/org/issues/123/events/')
      .query(q => q.per_page === '2' && q.cursor === '0:2:0')
      .reply(200, [
        { id: '1', eventID: 'e1', title: 'boom', tags: [{ key: 'env', value: 'prod', query: 'env:prod' }] },
        { id: '2', eventID: 'e2', title: 'boom', tags: [['level', 'error']] },
      ], { Link: link('0:4:0') });

    const result = await handleListIssueEvents({ issue_id: '123', limit: 2, cursor: '0:2:0' });
    const events = json(result);

    assert.deepStrictEqual(events[0].tags, [{ key: 'env', value: 'prod' }]);
    assert.deepStrictEqual(events[1].tags, [{ key: 'level', value: 'error' }]);
    assert.strictEqual(result.content.length, 2);
    assert.deepStrictEqual(
      { next_cursor: json(result, 1).next_cursor, has_more: json(result, 1).has_more },
      { next_cursor: '0:4:0', has_more: true }
    );
  });

  it('list_error_events carries the pagination block too', async () => {
    nock(BASE)
      .get('/api/0/projects/org/web/events/')
      .query(true)
      .reply(200, [{ id: '1', groupID: '9', title: 'x', tags: [] }], { Link: link('0:1:0') });

    const result = await handleListErrorEvents({ project_slug: 'web' });

    assert.strictEqual(json(result)[0].groupID, '9');
    assert.strictEqual(json(result, 1).next_cursor, '0:1:0');
  });
});
