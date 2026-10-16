/**
 * Handler-level tests for src/tools/advanced.ts, against intercepted HTTP.
 *
 * Response fixtures follow the serializers in Sentry 26.9.0:
 *  - trace/         src/sentry/snuba/trace.py (SerializedSpan / SerializedIssue)
 *  - events-trace/  src/sentry/api/endpoints/organization_events_trace.py (FullResponse)
 *  - grouping-info/ src/sentry/grouping/grouping_info.py + variants.py + component.py
 *  - merge          src/sentry/issues/merge.py (`{merge: {parent, children}}`)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import nock from 'nock';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

process.env.SENTRY_URL = process.env.SENTRY_URL || 'https://sentry.test.local';
process.env.SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN || 'token';
process.env.SENTRY_ORG_SLUG = process.env.SENTRY_ORG_SLUG || 'org';

const { handleGetTraceDetails, handleGetGroupingConfig, handleMergeIssues, normalizeTrace } =
  await import('../../build/tools/advanced.js');

const BASE = 'https://sentry.test.local';
const TRACE_ID = 'a'.repeat(32);
const json = (result, block = 0) => JSON.parse(result.content[block].text);

async function rejectsInvalidParams(promise, pattern) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof McpError, `expected an McpError, got ${error}`);
    assert.strictEqual(error.code, ErrorCode.InvalidParams);
    assert.match(error.message, pattern);
    return true;
  });
}

// ------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------

const span = (id, extra = {}) => ({
  event_type: 'span',
  event_id: id,
  transaction_id: 'txn-event',
  project_id: 1,
  project_slug: 'web',
  parent_span_id: null,
  start_timestamp: 1700000000,
  end_timestamp: 1700000001,
  duration: 1000,
  op: 'http.server',
  description: `span ${id}`,
  name: 'name',
  transaction: 'GET /checkout',
  is_transaction: false,
  measurements: { 'measurements.lcp': 1 },
  children: [],
  errors: [],
  occurrences: [],
  ...extra,
});

/** `organizations/{org}/trace/{id}/`: a list of top-level items. */
const NEW_TRACE = [
  span('root', {
    is_transaction: true,
    children: [
      span('child-1', {
        parent_span_id: 'root',
        op: 'db',
        description: 'SELECT 1',
        start_timestamp: 1700000000.2,
        duration: 12.3456,
        errors: [
          {
            event_type: 'error',
            event_id: 'err-1',
            issue_id: 11,
            short_id: 'API-7',
            level: 'error',
            description: 'DB down',
            project_slug: 'api',
            start_timestamp: 1700000000.3,
            transaction: 'GET /checkout',
          },
        ],
        children: [span('grandchild', { parent_span_id: 'child-1', project_slug: 'api', duration: 2 })],
      }),
      span('child-2', { parent_span_id: 'root', end_timestamp: 1700000003 }),
    ],
  }),
  {
    event_type: 'error',
    event_id: 'orphan-1',
    issue_id: 12,
    short_id: 'WEB-9',
    level: 'error',
    description: 'Orphan boom',
    project_slug: 'web',
    start_timestamp: 1700000002,
    transaction: 'x',
  },
];

/** `organizations/{org}/events-trace/{id}/`: `{transactions, orphan_errors}`. */
const LEGACY_TRACE = {
  transactions: [
    {
      event_id: 'txn-a',
      span_id: 'span-a',
      transaction: 'GET /legacy',
      'transaction.duration': 250,
      'transaction.op': 'http.server',
      project_id: 1,
      project_slug: 'web',
      parent_span_id: null,
      parent_event_id: null,
      generation: 0,
      start_timestamp: 1700000000,
      timestamp: 1700000000.25,
      errors: [{ event_id: 'e-a', issue_id: 3, title: 'Boom', level: 'error', project_slug: 'web', span: 'span-a', timestamp: 1700000000.1 }],
      performance_issues: [],
      children: [
        {
          event_id: 'txn-b',
          span_id: 'span-b',
          transaction: 'worker.task',
          'transaction.duration': 100,
          'transaction.op': 'queue.task',
          project_slug: 'worker',
          parent_span_id: 'span-a',
          parent_event_id: 'txn-a',
          start_timestamp: '2023-11-14T22:13:20.100000Z',
          timestamp: '2023-11-14T22:13:20.200000Z',
          errors: [],
          performance_issues: [],
          children: [],
        },
      ],
    },
  ],
  orphan_errors: [{ event_id: 'o-1', issue_id: 4, title: 'Lost', level: 'error', project_slug: 'web', timestamp: 1700000001 }],
};

// ------------------------------------------------------------------
// get_trace_details
// ------------------------------------------------------------------

describe('get_trace_details', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  it('asks the trace endpoint for a 90-day window', async () => {
    const scope = nock(BASE)
      .get(`/api/0/organizations/org/trace/${TRACE_ID}/`)
      .query({ statsPeriod: '90d' })
      .reply(200, NEW_TRACE);

    await handleGetTraceDetails({ trace_id: TRACE_ID });

    assert.ok(scope.isDone());
  });

  it('flattens the trace/ shape in tree order with parents, depth and errors', async () => {
    nock(BASE).get(`/api/0/organizations/org/trace/${TRACE_ID}/`).query(true).reply(200, NEW_TRACE);

    const result = json(await handleGetTraceDetails({ trace_id: TRACE_ID }));

    assert.strictEqual(result.source_endpoint, 'trace');
    assert.deepStrictEqual(result.spans.map((s) => [s.id, s.parent_id ?? null, s.depth]), [
      ['root', null, 0],
      ['child-1', 'root', 1],
      ['grandchild', 'child-1', 2],
      ['child-2', 'root', 1],
    ]);
    const child = result.spans[1];
    assert.strictEqual(child.kind, 'span');
    assert.strictEqual(result.spans[0].kind, 'transaction');
    assert.strictEqual(child.op, 'db');
    assert.strictEqual(child.description, 'SELECT 1');
    assert.strictEqual(child.transaction, 'GET /checkout');
    assert.strictEqual(child.project, 'web');
    assert.strictEqual(child.duration_ms, 12.35);
    assert.strictEqual(child.start_timestamp, '2023-11-14T22:13:20.200Z');
    assert.strictEqual(child.error_count, 1);
    assert.deepStrictEqual(child.error_ids, ['err-1']);
    assert.deepStrictEqual(child.error_issues, ['API-7']);
    assert.strictEqual(child.measurements, undefined, 'bulky fields are dropped');

    assert.strictEqual(result.total_spans, 4);
    assert.strictEqual(result.total_errors, 2);
    assert.deepStrictEqual(result.projects, ['api', 'web']);
    assert.strictEqual(result.orphan_errors.length, 1);
    assert.strictEqual(result.orphan_errors[0].issue, 'WEB-9');
    assert.strictEqual(result.start_timestamp, '2023-11-14T22:13:20.000Z');
    assert.strictEqual(result.end_timestamp, '2023-11-14T22:13:23.000Z');
    assert.strictEqual(result.duration_ms, 3000);
    assert.strictEqual(result.capped, false);
  });

  it('falls back to events-trace/ and flattens its shape', async () => {
    nock(BASE).get(`/api/0/organizations/org/trace/${TRACE_ID}/`).query(true).reply(404, { detail: 'nope' });
    const legacy = nock(BASE)
      .get(`/api/0/organizations/org/events-trace/${TRACE_ID}/`)
      .query({ statsPeriod: '90d' })
      .reply(200, LEGACY_TRACE);

    const result = json(await handleGetTraceDetails({ trace_id: TRACE_ID }));

    assert.ok(legacy.isDone());
    assert.strictEqual(result.source_endpoint, 'events-trace');
    assert.deepStrictEqual(result.spans.map((s) => [s.id, s.parent_id ?? null, s.depth, s.kind]), [
      ['txn-a', null, 0, 'transaction'],
      ['txn-b', 'txn-a', 1, 'transaction'],
    ]);
    assert.strictEqual(result.spans[0].op, 'http.server');
    assert.strictEqual(result.spans[0].transaction, 'GET /legacy');
    assert.strictEqual(result.spans[0].duration_ms, 250);
    assert.deepStrictEqual(result.spans[0].error_ids, ['e-a']);
    assert.strictEqual(result.spans[1].project, 'worker');
    assert.strictEqual(result.spans[1].start_timestamp, '2023-11-14T22:13:20.100000Z');
    assert.strictEqual(result.total_errors, 2);
    assert.strictEqual(result.orphan_errors[0].event_id, 'o-1');
    assert.deepStrictEqual(result.projects, ['web', 'worker']);
  });

  it('caps the span list at max_spans but keeps whole-trace totals', async () => {
    nock(BASE).get(`/api/0/organizations/org/trace/${TRACE_ID}/`).query(true).reply(200, NEW_TRACE);

    const result = json(await handleGetTraceDetails({ trace_id: TRACE_ID, max_spans: 2 }));

    assert.strictEqual(result.returned_spans, 2);
    assert.strictEqual(result.total_spans, 4);
    assert.strictEqual(result.capped, true);
    assert.match(result._note, /max_spans/);
  });

  it('explains an empty trace', async () => {
    nock(BASE).get(`/api/0/organizations/org/trace/${TRACE_ID}/`).query(true).reply(200, []);

    const result = json(await handleGetTraceDetails({ trace_id: TRACE_ID }));

    assert.strictEqual(result.total_spans, 0);
    assert.match(result._note, /No spans or errors/);
  });

  it('survives a very deep trace without recursion', () => {
    let node = span('leaf');
    for (let i = 0; i < 20_000; i++) node = span(`s${i}`, { children: [node] });

    const trace = normalizeTrace([node]);

    assert.strictEqual(trace.total_spans, 20_001);
  });
});

// ------------------------------------------------------------------
// get_grouping_config
// ------------------------------------------------------------------

const GROUPING_INFO = {
  grouping_config: 'newstyle:2023-01-11',
  variants: {
    app: {
      type: 'component',
      key: 'app_exception_stacktrace',
      description: 'exception stacktrace — in-app frames',
      hash: 'aaa111',
      hint: null,
      contributes: true,
      hashMismatch: false,
      component: {
        id: 'app',
        name: 'in-app',
        contributes: true,
        hint: null,
        values: [
          {
            id: 'exception',
            contributes: true,
            values: [
              {
                id: 'stacktrace',
                contributes: true,
                values: [
                  {
                    id: 'frame',
                    contributes: true,
                    values: [
                      { id: 'module', contributes: true, values: ['app.checkout'] },
                      { id: 'function', contributes: true, values: ['handle'] },
                      { id: 'lineno', contributes: false, values: [42] },
                    ],
                  },
                  { id: 'frame', contributes: false, values: [{ id: 'function', contributes: true, values: ['skipped'] }] },
                ],
              },
              { id: 'type', contributes: true, values: ['ValueError'] },
              { id: 'value', contributes: false, hint: 'ignored because stacktrace takes precedence', values: ['bad'] },
            ],
          },
        ],
      },
    },
    system: {
      type: 'component',
      key: 'system_exception_stacktrace',
      description: 'exception stacktrace — all frames',
      hash: 'bbb222',
      hint: 'ignored because app variant is used',
      contributes: false,
      component: { id: 'system', contributes: false, values: [{ id: 'exception', contributes: true, values: ['x'] }] },
    },
    'custom-fingerprint': {
      type: 'custom_fingerprint',
      key: 'custom_server_fingerprint',
      description: 'custom fingerprint',
      hash: 'ccc333',
      hint: null,
      contributes: false,
      values: ['{{ default }}', 'checkout'],
      matched_rule: 'error.type:ValueError -> {{ default }}, checkout',
    },
  },
};

describe('get_grouping_config', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  const mockIssueAndEvent = () => {
    nock(BASE)
      .get('/api/0/organizations/org/issues/WEB-1A3/')
      .reply(200, { id: '42', shortId: 'WEB-1A3', title: 't', project: { id: '1', slug: 'web', name: 'Web' } });
    nock(BASE)
      .get('/api/0/organizations/org/issues/WEB-1A3/events/latest/')
      .reply(200, { id: 'ev1', eventID: 'ev1', entries: [] });
  };

  it('explains the latest event\'s grouping, compactly', async () => {
    mockIssueAndEvent();
    const info = nock(BASE).get('/api/0/projects/org/web/events/ev1/grouping-info/').reply(200, GROUPING_INFO);

    const result = json(await handleGetGroupingConfig({ issue_id: 'WEB-1A3' }));

    assert.ok(info.isDone());
    assert.strictEqual(result.issue_id, '42');
    assert.strictEqual(result.short_id, 'WEB-1A3');
    assert.strictEqual(result.project, 'web');
    assert.strictEqual(result.event_id, 'ev1');
    assert.strictEqual(result.grouping_config, 'newstyle:2023-01-11');
    assert.deepStrictEqual(result.contributing_variants, ['app_exception_stacktrace']);
    assert.strictEqual(result.configs, undefined, 'the old placeholder field is gone');

    const [app, ...rest] = result.variants;
    assert.deepStrictEqual(app, {
      key: 'app_exception_stacktrace',
      type: 'component',
      description: 'exception stacktrace — in-app frames',
      contributes: true,
      hash: 'aaa111',
      hint: null,
      contributing_components: [
        'app/exception/stacktrace/frame/module: app.checkout',
        'app/exception/stacktrace/frame/function: handle',
        'app/exception/type: ValueError',
      ],
    });

    const system = rest.find((v) => v.key === 'system_exception_stacktrace');
    assert.strictEqual(system.contributes, false);
    assert.strictEqual(system.hint, 'ignored because app variant is used');
    assert.strictEqual(system.contributing_components, undefined, 'non-contributing variants carry no components');

    const custom = rest.find((v) => v.key === 'custom_server_fingerprint');
    assert.deepStrictEqual(custom.fingerprint, ['{{ default }}', 'checkout']);
    assert.match(custom.matched_rule, /ValueError/);
  });

  it('reads the older variants-at-top-level shape', async () => {
    mockIssueAndEvent();
    nock(BASE)
      .get('/api/0/projects/org/web/events/ev1/grouping-info/')
      .reply(200, {
        default: {
          type: 'component',
          key: 'default',
          description: 'message',
          hash: 'ddd',
          hint: null,
          contributes: true,
          config: { id: 'legacy:2019-03-12' },
          component: { id: 'default', contributes: true, values: [{ id: 'message', contributes: true, values: ['Hello %s'] }] },
        },
      });

    const result = json(await handleGetGroupingConfig({ issue_id: 'WEB-1A3' }));

    assert.strictEqual(result.grouping_config, 'legacy:2019-03-12');
    assert.deepStrictEqual(result.variants[0].contributing_components, ['default/message: Hello %s']);
  });

  it('caps the component summary', async () => {
    mockIssueAndEvent();
    const frames = Array.from({ length: 100 }, (_, i) => ({
      id: 'frame',
      contributes: true,
      values: [{ id: 'function', contributes: true, values: [`fn${i}`] }],
    }));
    nock(BASE)
      .get('/api/0/projects/org/web/events/ev1/grouping-info/')
      .reply(200, {
        grouping_config: 'c',
        variants: { app: { type: 'component', key: 'app', hash: 'h', contributes: true, component: { id: 'app', contributes: true, values: frames } } },
      });

    const result = json(await handleGetGroupingConfig({ issue_id: 'WEB-1A3' }));

    assert.strictEqual(result.variants[0].contributing_components.length, 25);
    assert.strictEqual(result.variants[0].contributing_components_truncated, true);
  });
});

// ------------------------------------------------------------------
// merge_issues
// ------------------------------------------------------------------

describe('merge_issues', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  const issue = (idOrShort, id, shortId, project) =>
    nock(BASE)
      .get(`/api/0/organizations/org/issues/${idOrShort}/`)
      .reply(200, { id, shortId, title: 't', project: { id: '1', slug: project } });

  it('refuses issues from different projects without merging', async () => {
    issue('1', '1', 'WEB-1', 'web');
    issue('API-2', '2', 'API-2', 'api');
    const put = nock(BASE).put(/.*/).query(true).reply(200, {});

    await rejectsInvalidParams(
      handleMergeIssues({ issue_id: '1', target_ids: ['API-2'] }),
      /2 projects.*web: WEB-1.*api: API-2/
    );
    assert.strictEqual(put.isDone(), false);
  });

  it('resolves short IDs and merges by numeric ID in the issues\' project', async () => {
    issue('WEB-1', '10', 'WEB-1', 'web');
    issue('WEB-2', '20', 'WEB-2', 'web');
    let seen;
    nock(BASE)
      .put('/api/0/projects/org/web/issues/')
      .query(true)
      .reply(function (uri, body) {
        seen = { uri, body };
        return [200, { merge: { parent: '20', children: ['10'] } }];
      });

    const result = json(await handleMergeIssues({ issue_id: 'WEB-1', target_ids: ['WEB-2'] }));

    assert.deepStrictEqual(new URL(seen.uri, BASE).searchParams.getAll('id'), ['10', '20']);
    assert.deepStrictEqual(seen.body, { merge: true });
    assert.strictEqual(result.merged, true);
    assert.strictEqual(result.parent, '20');
    assert.strictEqual(result.parent_short_id, 'WEB-2');
    assert.deepStrictEqual(result.children, ['10']);
    assert.match(result.explanation, /not issue_id/);
  });

  it('does not treat an empty response as a successful merge', async () => {
    issue('1', '1', 'WEB-1', 'web');
    issue('2', '2', 'WEB-2', 'web');
    nock(BASE).put('/api/0/projects/org/web/issues/').query(true).reply(204);

    const result = json(await handleMergeIssues({ issue_id: '1', target_ids: ['2'] }));

    assert.strictEqual(result.merged, false);
    assert.match(result.explanation, /not confirmed/i);
    assert.match(result.explanation, /verify/i);
  });

  it('does not treat a body without `merge` as success', async () => {
    issue('1', '1', 'WEB-1', 'web');
    issue('2', '2', 'WEB-2', 'web');
    nock(BASE).put('/api/0/projects/org/web/issues/').query(true).reply(200, { status: 'unresolved' });

    const result = json(await handleMergeIssues({ issue_id: '1', target_ids: ['2'] }));

    assert.strictEqual(result.merged, false);
  });

  it('refuses a merge with nothing to merge', async () => {
    await rejectsInvalidParams(handleMergeIssues({ issue_id: '1', target_ids: [] }), /at least one/);
    await rejectsInvalidParams(handleMergeIssues({ issue_id: '1', target_ids: ['1'] }), /at least one/);
  });

  it('refuses when a short ID and a numeric ID name the same issue', async () => {
    issue('5', '5', 'WEB-5', 'web');
    issue('WEB-5', '5', 'WEB-5', 'web');

    await rejectsInvalidParams(handleMergeIssues({ issue_id: '5', target_ids: ['WEB-5'] }), /same issue/);
  });
});
