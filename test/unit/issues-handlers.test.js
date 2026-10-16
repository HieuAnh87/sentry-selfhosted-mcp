/**
 * Handler-level tests for src/tools/issues.ts, against intercepted HTTP.
 *
 * Covers: issue ID / short ID / URL parsing, concurrent latest-event fetching and
 * max_stack_frames, the pagination block, bulk_update_issues scope safety, and
 * compact mutation results.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import nock from 'nock';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

process.env.SENTRY_URL = process.env.SENTRY_URL || 'https://sentry.test.local';
process.env.SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN || 'token';
process.env.SENTRY_ORG_SLUG = process.env.SENTRY_ORG_SLUG || 'org';

const issues = await import('../../build/tools/issues.js');
const {
  getIssueId,
  handleGetSentryIssue,
  handleListSentryProjects,
  handleListSentryIssues,
  handleListIssues,
  handleGetIssueHashes,
  handleBulkUpdateIssues,
  handleUpdateIssueStatus,
  handleCreateComment,
} = issues;

const BASE = 'https://sentry.test.local';
const LINK_MORE =
  '<https://sentry.test.local/api/0/x/?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", '
  + '<https://sentry.test.local/api/0/x/?cursor=0:25:0>; rel="next"; results="true"; cursor="0:25:0"';
const LINK_DONE =
  '<https://sentry.test.local/api/0/x/?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", '
  + '<https://sentry.test.local/api/0/x/?cursor=0:25:0>; rel="next"; results="false"; cursor="0:25:0"';

const json = (result, block = 0) => JSON.parse(result.content[block].text);

/** Assert a promise rejects with an McpError whose message matches `pattern`. */
async function rejectsInvalidParams(promise, pattern) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof McpError, `expected an McpError, got ${error}`);
    assert.strictEqual(error.code, ErrorCode.InvalidParams);
    assert.match(error.message, pattern);
    return true;
  });
}

describe('getIssueId', () => {
  const accepted = [
    ['123', '123'],
    ['  123\n', '123'],
    ['WEB-1A3', 'WEB-1A3'],
    [' my-project-2B ', 'my-project-2B'],
    ['https://sentry.example.com/organizations/acme/issues/123/', '123'],
    ['https://sentry.example.com/organizations/acme/issues/123/?project=4&query=is%3Aunresolved', '123'],
    ['https://sentry.example.com/organizations/acme/issues/123', '123'],
    ['https://sentry.example.com/organizations/acme/issues/123/events/abc/', '123'],
    ['https://acme.sentry.example.com/issues/456/', '456'],
    ['https://sentry.example.com/organizations/acme/issues/WEB-1A3/', 'WEB-1A3'],
    ['http://localhost:9000/organizations/issues/issues/789/', '789'],
  ];
  for (const [input, expected] of accepted) {
    it(`extracts ${expected} from ${JSON.stringify(input)}`, () => {
      assert.strictEqual(getIssueId(input), expected);
    });
  }

  const rejected = [
    '',
    '   ',
    'WEB',
    '12/34',
    '../123',
    'WEB-1A3/../../x',
    'https://sentry.example.com/organizations/acme/projects/web/',
    'https://sentry.example.com/organizations/acme/issues/',
    'https://sentry.example.com/organizations/acme/issues/..%2F1/',
    'ftp://sentry.example.com/issues/123/',
    'javascript:alert(1)//issues/123',
  ];
  for (const input of rejected) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      assert.strictEqual(getIssueId(input), null);
    });
  }
});

describe('get_sentry_issue', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  it('fetches a short ID through the organization issue endpoint', async () => {
    const scope = nock(BASE).get('/api/0/organizations/org/issues/WEB-1A3/').reply(200, { id: '42', shortId: 'WEB-1A3', title: 't' });

    const result = await handleGetSentryIssue({ issue_id_or_url: 'WEB-1A3' });

    assert.ok(scope.isDone());
    assert.strictEqual(json(result).shortId, 'WEB-1A3');
    assert.strictEqual(json(result).latest_event, null);
  });

  it('extracts the ID from an issue URL with a query string', async () => {
    const scope = nock(BASE).get('/api/0/organizations/org/issues/77/').reply(200, { id: '77', title: 't' });

    await handleGetSentryIssue({ issue_id_or_url: 'https://sentry.example.com/organizations/org/issues/77/?project=1' });

    assert.ok(scope.isDone());
  });

  it('refuses input it cannot turn into an issue ID', async () => {
    await rejectsInvalidParams(handleGetSentryIssue({ issue_id_or_url: '../etc/passwd' }), /short ID/);
  });

  it('fetches the issue and the latest event concurrently', async () => {
    let issueRequestedAt;
    let eventRequestedAt;
    nock(BASE)
      .get('/api/0/organizations/org/issues/9/')
      .delay(300)
      .reply(() => {
        issueRequestedAt ??= Date.now();
        return [200, { id: '9', title: 't' }];
      });
    nock(BASE)
      .get('/api/0/organizations/org/issues/9/events/latest/')
      .reply(() => {
        eventRequestedAt = Date.now();
        return [200, { id: 'e1', eventID: 'e1', entries: [] }];
      });

    const start = Date.now();
    await handleGetSentryIssue({ issue_id_or_url: '9', include_latest_event: true });

    assert.ok(eventRequestedAt !== undefined, 'the latest event must be requested');
    assert.ok(eventRequestedAt - start < 250, `latest event waited for the issue response (${eventRequestedAt - start}ms)`);
  });

  it('honours max_stack_frames above the default of 5', async () => {
    const frames = Array.from({ length: 12 }, (_, i) => ({ function: `f${i}`, filename: 'a.js', lineNo: i }));
    nock(BASE).get('/api/0/organizations/org/issues/9/').reply(200, { id: '9', title: 't' });
    nock(BASE)
      .get('/api/0/organizations/org/issues/9/events/latest/')
      .reply(200, {
        id: 'e1',
        eventID: 'e1',
        entries: [
          { type: 'exception', data: { values: [{ type: 'Error', value: 'boom', stacktrace: { frames } }] } },
          { type: 'request', data: { url: 'https://x' } },
          { type: 'debugmeta', data: { images: [] } },
        ],
      });

    const result = json(await handleGetSentryIssue({ issue_id_or_url: '9', include_latest_event: true, max_stack_frames: 8 }));

    const kept = result.latest_event.entries[0].data.values[0].stacktrace.frames;
    assert.strictEqual(kept.length, 8);
    assert.strictEqual(kept.at(-1).function, 'f11', 'innermost frames are kept');
    assert.ok(result.latest_event.entries.some(e => e.type === 'request'), 'request is summarized');
    assert.deepStrictEqual(result.latest_event.omitted_entry_types, ['debugmeta']);
  });

  it('defaults to 5 frames', async () => {
    const frames = Array.from({ length: 12 }, (_, i) => ({ function: `f${i}` }));
    nock(BASE).get('/api/0/organizations/org/issues/9/').reply(200, { id: '9', title: 't' });
    nock(BASE)
      .get('/api/0/organizations/org/issues/9/events/latest/')
      .reply(200, { id: 'e1', entries: [{ type: 'exception', data: { values: [{ stacktrace: { frames } }] } }] });

    const result = json(await handleGetSentryIssue({ issue_id_or_url: '9', include_latest_event: true }));

    assert.strictEqual(result.latest_event.entries[0].data.values[0].stacktrace.frames.length, 5);
  });

  it('still returns the issue when the latest event fails', async () => {
    nock(BASE).get('/api/0/organizations/org/issues/9/').reply(200, { id: '9', title: 't' });
    nock(BASE).get('/api/0/organizations/org/issues/9/events/latest/').reply(500, { detail: 'no' });

    const result = json(await handleGetSentryIssue({ issue_id_or_url: '9', include_latest_event: true }));

    assert.strictEqual(result.id, '9');
    assert.strictEqual(result.latest_event, null);
    assert.match(result.latest_event_error, /500/);
  });

  it('never returns a raw event that has no entries', async () => {
    nock(BASE).get('/api/0/organizations/org/issues/9/').reply(200, { id: '9', title: 't' });
    nock(BASE)
      .get('/api/0/organizations/org/issues/9/events/latest/')
      .reply(200, { id: 'e1', title: 'x', contexts: { huge: 'y'.repeat(1000) } });

    const result = json(await handleGetSentryIssue({ issue_id_or_url: '9', include_latest_event: true }));

    assert.strictEqual(result.latest_event.id, 'e1');
    assert.strictEqual(result.latest_event.contexts, undefined);
  });
});

describe('pagination block', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  it('list_sentry_issues appends next_cursor when Sentry reports more', async () => {
    nock(BASE).get('/api/0/projects/org/web/issues/').query(true).reply(200, [{ id: '1' }], { Link: LINK_MORE });

    const result = await handleListSentryIssues({ project_slug: 'web' });

    assert.strictEqual(result.content.length, 2);
    assert.deepStrictEqual(json(result), [{ id: '1' }]);
    assert.strictEqual(json(result, 1).next_cursor, '0:25:0');
    assert.strictEqual(json(result, 1).has_more, true);
  });

  it('list_sentry_issues has a single block on the last page', async () => {
    nock(BASE).get('/api/0/projects/org/web/issues/').query(true).reply(200, [{ id: '1' }], { Link: LINK_DONE });

    const result = await handleListSentryIssues({ project_slug: 'web' });

    assert.strictEqual(result.content.length, 1);
  });

  it('list_issues forwards cursor and appends the next one', async () => {
    const scope = nock(BASE)
      .get('/api/0/organizations/org/issues/')
      .query({ cursor: '0:25:0', limit: 25, collapse: 'stats' })
      .reply(200, [{ id: '2' }], { Link: LINK_MORE });

    const result = await handleListIssues({ cursor: '0:25:0' });

    assert.ok(scope.isDone());
    assert.strictEqual(json(result, 1).next_cursor, '0:25:0');
  });

  it('list_sentry_projects accepts a cursor and reports the next one', async () => {
    const scope = nock(BASE)
      .get('/api/0/organizations/org/projects/')
      .query({ cursor: '0:100:0' })
      .reply(200, [{ id: '1', slug: 'web', name: 'Web', teams: [{ slug: 't' }] }], { Link: LINK_MORE });

    const result = await handleListSentryProjects({ cursor: '0:100:0' });

    assert.ok(scope.isDone());
    assert.deepStrictEqual(json(result).projects[0].teams, ['t']);
    assert.strictEqual(json(result).has_more, true);
    assert.strictEqual(json(result, 1).next_cursor, '0:25:0');
    assert.doesNotMatch(result.content[0].text, /raw_sentry_api/);
  });

  it('list_sentry_projects still works when called without arguments', async () => {
    nock(BASE).get('/api/0/organizations/org/projects/').reply(200, [{ id: '1', slug: 'web', name: 'Web' }]);

    const result = await handleListSentryProjects();

    assert.strictEqual(json(result).returned_projects, 1);
    assert.strictEqual(result.content.length, 1);
  });

  it('get_issue_hashes requests 25 per page and reports the next cursor', async () => {
    const scope = nock(BASE)
      .get('/api/0/organizations/org/issues/WEB-1/hashes/')
      .query({ per_page: 25, cursor: 'c1' })
      .reply(200, [{ id: 'h1', latestEvent: { id: 'e', eventID: 'e', title: 'boom', entries: [] } }], { Link: LINK_MORE });

    const result = await handleGetIssueHashes({ issue_id: 'WEB-1', cursor: 'c1' });

    assert.ok(scope.isDone());
    assert.deepStrictEqual(json(result).hashes, [{ id: 'h1', latestEvent: { id: 'e', eventID: 'e', message: 'boom' } }]);
    assert.strictEqual(json(result, 1).next_cursor, '0:25:0');
  });
});

describe('bulk_update_issues scope safety', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  /** Any PUT reaching Sentry is recorded so refusals can assert nothing was sent. */
  const capturePut = (status = 200, body = { status: 'resolved', statusDetails: {} }) => {
    const seen = [];
    nock(BASE)
      .put('/api/0/projects/org/web/issues/')
      .query(true)
      .reply(function (uri, requestBody) {
        seen.push({ uri, body: requestBody });
        return [status, body];
      });
    return seen;
  };

  for (const [label, extra] of [
    ['neither query nor issue_ids', {}],
    ['a blank query', { query: '   ' }],
  ]) {
    it(`refuses ${label} without contacting Sentry`, async () => {
      const seen = capturePut();

      await rejectsInvalidParams(
        handleBulkUpdateIssues({ project_slug: 'web', status: 'resolved', ...extra }),
        /every unresolved issue/
      );

      assert.strictEqual(seen.length, 0);
    });
  }

  it('refuses both query and issue_ids', async () => {
    const seen = capturePut();

    await rejectsInvalidParams(
      handleBulkUpdateIssues({ project_slug: 'web', status: 'resolved', query: 'is:unresolved', issue_ids: ['1'] }),
      /not both/
    );

    assert.strictEqual(seen.length, 0);
  });

  it('refuses a call that changes nothing', async () => {
    const seen = capturePut();

    await rejectsInvalidParams(handleBulkUpdateIssues({ project_slug: 'web', issue_ids: ['1'] }), /nothing to change/);

    assert.strictEqual(seen.length, 0);
  });

  it('rejects short IDs in issue_ids', async () => {
    await rejectsInvalidParams(
      handleBulkUpdateIssues({ project_slug: 'web', status: 'resolved', issue_ids: ['WEB-1'] }),
      /numeric/
    );
  });

  it('puts issue_ids in the URL as repeated id params, never in the body', async () => {
    const seen = capturePut();

    const result = json(await handleBulkUpdateIssues({ project_slug: 'web', status: 'resolved', issue_ids: ['1', '2', '1'] }));

    assert.strictEqual(seen.length, 1);
    const url = new URL(seen[0].uri, BASE);
    assert.deepStrictEqual(url.searchParams.getAll('id'), ['1', '2']);
    assert.strictEqual(url.searchParams.get('query'), null);
    assert.deepStrictEqual(seen[0].body, { status: 'resolved' });
    assert.strictEqual(result.updated, true);
    assert.deepStrictEqual(result.selection, { issue_ids: ['1', '2'] });
    assert.strictEqual(result.applied.status, 'resolved');
  });

  it('puts query in the URL, never in the body', async () => {
    const seen = capturePut();

    await handleBulkUpdateIssues({ project_slug: 'web', assigned_to: 'me', query: ' is:unresolved env:staging ' });

    const url = new URL(seen[0].uri, BASE);
    assert.strictEqual(url.searchParams.get('query'), 'is:unresolved env:staging');
    assert.deepStrictEqual(url.searchParams.getAll('id'), []);
    assert.deepStrictEqual(seen[0].body, { assignedTo: 'me' });
  });

  it('reports a 204 as nothing changed', async () => {
    nock(BASE).put('/api/0/projects/org/web/issues/').query(true).reply(204);

    const result = json(await handleBulkUpdateIssues({ project_slug: 'web', status: 'resolved', issue_ids: ['1'] }));

    assert.strictEqual(result.updated, false);
    assert.match(result._note, /no matching issues/);
  });
});

describe('compact mutation results', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  it('update_sentry_issue_status returns id, shortId, title and status only', async () => {
    nock(BASE)
      .put('/api/0/organizations/org/issues/WEB-1/', { status: 'resolved' })
      .reply(200, { id: '5', shortId: 'WEB-1', title: 'boom', status: 'resolved', activity: Array(50).fill({ x: 1 }) });

    const result = json(await handleUpdateIssueStatus({ issue_id: 'WEB-1', status: 'resolved' }));

    assert.deepStrictEqual(result, { updated: true, id: '5', shortId: 'WEB-1', title: 'boom', status: 'resolved' });
  });

  it('create_sentry_issue_comment returns the comment id', async () => {
    nock(BASE)
      .post('/api/0/organizations/org/issues/5/comments/', { text: 'hi' })
      .reply(201, { id: '900', type: 'note', data: { text: 'hi' }, dateCreated: '2026-01-01T00:00:00Z', user: { email: 'a@b' } });

    const result = json(await handleCreateComment({ issue_id: '5', comment_text: 'hi' }));

    assert.deepStrictEqual(result, { created: true, comment_id: '900', issue_id: '5', dateCreated: '2026-01-01T00:00:00Z' });
  });
});

describe('list tools return compact issues unless full is set', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  const RAW_ISSUE = {
    id: '381', shortId: 'CHAT-SERVICE-4', title: 'boom', culprit: 'app.main', level: 'error',
    status: 'unresolved', count: '178', userCount: 0, firstSeen: 'a', lastSeen: 'b',
    project: { id: '8', slug: 'chat-service', name: 'chat-service', platform: 'python' },
    metadata: { type: 'Error', value: 'x'.repeat(1000), filename: 'a.py', function: 'f' },
    stats: { '24h': Array.from({ length: 24 }, (_, i) => [i, 0]) },
    isBookmarked: false, seerFixabilityScore: null, annotations: [],
  };

  it('list_sentry_issues drops stats and flags and asks Sentry not to compute stats', async () => {
    const scope = nock(BASE)
      .get('/api/0/projects/org/chat-service/issues/')
      .query({ limit: 25, statsPeriod: '' })
      .reply(200, [RAW_ISSUE]);

    const [issue] = json(await handleListSentryIssues({ project_slug: 'chat-service' }));

    assert.ok(scope.isDone());
    assert.strictEqual(issue.shortId, 'CHAT-SERVICE-4');
    assert.deepStrictEqual(issue.project, { id: '8', slug: 'chat-service' });
    assert.strictEqual(issue.stats, undefined);
    assert.strictEqual(issue.isBookmarked, undefined);
    assert.ok(issue.metadata.value.length <= 301, 'metadata value is clipped');
  });

  it('full: true returns the raw Sentry objects with their stats', async () => {
    nock(BASE)
      .get('/api/0/organizations/org/issues/')
      .query({ limit: 25 })
      .reply(200, [RAW_ISSUE]);

    const [issue] = json(await handleListIssues({ full: true }));

    assert.deepStrictEqual(issue, RAW_ISSUE);
  });
});
