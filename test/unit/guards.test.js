/**
 * Boundary tests for the argument type guards in src/helpers/index.ts.
 *
 * These guards are the only runtime validation the server has: MCP SDK 0.6.0
 * does not enforce a tool's declared inputSchema, so whatever a client sends
 * reaches the handler and only these predicates stand between it and an HTTP
 * request. The table below targets the boundaries rather than the happy path —
 * numeric ranges, the /^\d+$/ id pattern, slug shape, enum allowlists, and the
 * non-finite numbers that a JSON client can produce.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

process.env.SENTRY_URL = process.env.SENTRY_URL || 'https://example.sentry.local';
process.env.SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN || 'test-token';
process.env.SENTRY_ORG_SLUG = process.env.SENTRY_ORG_SLUG || 'test-org';

const guards = await import('../../build/helpers/index.js');

/** Values that are never a valid arguments object. */
const NON_OBJECTS = [
  [null, 'null'],
  [undefined, 'undefined'],
  ['string', 'a string'],
  [42, 'a number'],
  [true, 'a boolean'],
];

/** Rejected wherever a bare numeric Sentry id is required. */
const BAD_NUMERIC_IDS = [
  ['12a', 'digits with a letter'],
  ['', 'empty string'],
  [' 123', 'leading whitespace'],
  ['123 ', 'trailing whitespace'],
  ['1.5', 'a decimal point'],
  ['-1', 'a leading minus'],
  ['12/34', 'an embedded path separator'],
  ['../123', 'a traversal prefix'],
  ['1e3', 'exponent notation'],
  [123, 'a number rather than a string'],
  [null, 'null'],
];

/** Accepted wherever an issue id (numeric or short ID) is required. */
const GOOD_ISSUE_IDS = ['123', '0', '99999999999999', 'WEB-1A3', 'my-project-2B', 'proj_x-Z9', 'a-1'];

/**
 * Rejected wherever an issue id is required. Short IDs widen the alphabet, so
 * the cases target what must still never reach a URL path: separators,
 * traversal, whitespace, escapes and malformed short IDs.
 */
const BAD_ISSUE_IDS = [
  ['', 'empty string'],
  [' 123', 'leading whitespace'],
  ['123 ', 'trailing whitespace'],
  ['WEB 1A3', 'an inner space'],
  ['WEB-1A3\n', 'a trailing newline'],
  ['1.5', 'a decimal point'],
  ['-1', 'a leading minus'],
  ['WEB-', 'a trailing hyphen'],
  ['-WEB-1', 'a leading hyphen'],
  ['WEB', 'a slug without a short id suffix'],
  ['12a', 'digits with a letter but no separator'],
  ['1e3', 'exponent notation'],
  ['12/34', 'an embedded path separator'],
  ['WEB-1/2', 'a path separator in a short id'],
  ['WEB\\1', 'a backslash'],
  ['../123', 'a traversal prefix'],
  ['..', 'a bare traversal segment'],
  ['WEB-..', 'a traversal suffix'],
  ['WEB-1A3?x=1', 'a query separator'],
  ['WEB-1A3#x', 'a fragment'],
  ['WEB%2F1', 'a percent escape'],
  ['web.app-1', 'a dot'],
  [`P-${'1'.repeat(200)}`, 'an overlong id'],
  [123, 'a number rather than a string'],
  [null, 'null'],
];

/** Rejected wherever a project slug is required. */
const BAD_SLUGS = [
  ['my/project', 'an embedded path separator'],
  ['my\\project', 'a backslash'],
  ['', 'empty string'],
  ['my project', 'a space'],
  ['proj%2Fect', 'a percent escape'],
  ['a?b', 'a query separator'],
  [42, 'a number rather than a string'],
  [null, 'null'],
];

/** Non-finite and out-of-range numbers for a 1..100 bound. */
const BAD_LIMITS_1_100 = [
  [0, 'below the minimum'],
  [101, 'above the maximum'],
  [-1, 'negative'],
  [Number.NaN, 'NaN'],
  [Number.POSITIVE_INFINITY, 'Infinity'],
  [Number.NEGATIVE_INFINITY, '-Infinity'],
  ['50', 'a numeric string'],
  [null, 'null'],
];

/**
 * Each entry states what a guard must accept and what it must reject.
 * `invalid` entries are [value, why] so a failure names the boundary it missed.
 */
const table = [
  {
    guard: 'isValidGetIssueArgs',
    valid: [
      { issue_id_or_url: '123' },
      { issue_id_or_url: 'https://sentry.example.com/organizations/o/issues/123/' },
      { issue_id_or_url: '123', include_latest_event: true },
      { issue_id_or_url: '123', include_fields: [] },
      { issue_id_or_url: '123', include_fields: ['id', 'latest_event.entries'] },
      { issue_id_or_url: '123', max_stack_frames: 0 },
    ],
    invalid: [
      ...NON_OBJECTS,
      [{}, 'missing issue_id_or_url'],
      [{ issue_id_or_url: 123 }, 'a number rather than a string'],
      [{ issue_id_or_url: '123', include_latest_event: 'yes' }, 'a string for a boolean'],
      [{ issue_id_or_url: '123', include_fields: 'id' }, 'a bare string for a string array'],
      [{ issue_id_or_url: '123', include_fields: [1, 2] }, 'a non-string array element'],
      [{ issue_id_or_url: '123', max_stack_frames: -1 }, 'a negative frame count'],
      [{ issue_id_or_url: '123', max_stack_frames: Number.NaN }, 'NaN'],
      [{ issue_id_or_url: '123', max_stack_frames: Number.POSITIVE_INFINITY }, 'Infinity'],
    ],
  },
  {
    guard: 'isValidListIssuesArgs',
    valid: [
      { project_slug: 'my-project' },
      { project_slug: 'My_Project.v2' },
      { project_slug: 'p', limit: 1 },
      { project_slug: 'p', limit: 100 },
      { project_slug: 'p', status: 'resolved' },
      { project_slug: 'p', status: 'ignored' },
      { project_slug: 'p', status: 'unresolved' },
    ],
    invalid: [
      ...NON_OBJECTS,
      [{}, 'missing project_slug'],
      ...BAD_SLUGS.map(([value, why]) => [{ project_slug: value }, `project_slug with ${why}`]),
      ...BAD_LIMITS_1_100.map(([value, why]) => [{ project_slug: 'p', limit: value }, `limit ${why}`]),
      [{ project_slug: 'p', status: 'RESOLVED' }, 'an enum value in the wrong case'],
      [{ project_slug: 'p', status: 'deleted' }, 'a value outside the enum'],
      [{ project_slug: 'p', cursor: 12 }, 'a non-string cursor'],
    ],
  },
  {
    guard: 'isValidSearchIssuesArgs',
    valid: [
      {},
      { query: 'is:unresolved' },
      { sort: 'date' },
      { sort: 'priority' },
      { sort: 'freq' },
      { sort: 'user' },
      { limit: 1 },
      { limit: 100 },
    ],
    invalid: [
      ...NON_OBJECTS,
      [{ sort: 'newest' }, 'a value outside the sort enum'],
      [{ sort: 'Date' }, 'a sort value in the wrong case'],
      ...BAD_LIMITS_1_100.map(([value, why]) => [{ limit: value }, `limit ${why}`]),
    ],
  },
  {
    guard: 'isValidUpdateIssueArgs',
    valid: [
      { issue_id: '123', status: 'resolved' },
      { issue_id: '0', status: 'ignored' },
      { issue_id: '99999999999999', status: 'unresolved' },
    ],
    invalid: [
      ...NON_OBJECTS,
      [{ issue_id: '123' }, 'a missing status'],
      [{ status: 'resolved' }, 'a missing issue_id'],
      ...BAD_ISSUE_IDS.map(([value, why]) => [{ issue_id: value, status: 'resolved' }, `issue_id with ${why}`]),
      [{ issue_id: '123', status: 'RESOLVED' }, 'an enum value in the wrong case'],
      [{ issue_id: '123', status: 'deleted' }, 'a value outside the enum'],
      [{ issue_id: '123', status: null }, 'a null status'],
    ],
  },
  {
    guard: 'isValidCreateCommentArgs',
    valid: [
      { issue_id: '123', comment_text: 'looking into it' },
      { issue_id: '123', comment_text: '' },
    ],
    invalid: [
      ...NON_OBJECTS,
      [{ issue_id: '123' }, 'missing comment_text'],
      ...BAD_ISSUE_IDS.map(([value, why]) => [{ issue_id: value, comment_text: 'x' }, `issue_id with ${why}`]),
      [{ issue_id: '123', comment_text: 42 }, 'a non-string comment'],
    ],
  },
  {
    guard: 'isValidGetIssueHashesArgs',
    valid: [{ issue_id: '123' }, { issue_id: '123', cursor: 'abc' }],
    invalid: [
      ...NON_OBJECTS,
      ...BAD_ISSUE_IDS.map(([value, why]) => [{ issue_id: value }, `issue_id with ${why}`]),
      [{ issue_id: '123', cursor: 5 }, 'a non-string cursor'],
    ],
  },
  {
    guard: 'isValidBulkUpdateArgs',
    valid: [
      { project_slug: 'p' },
      { project_slug: 'p', status: 'resolved', has_seen: true, assigned_to: 'me' },
      { project_slug: 'p', issue_ids: ['1'], status: 'resolved' },
      { project_slug: 'p', issue_ids: Array.from({ length: 100 }, (_, i) => String(i + 1)) },
    ],
    invalid: [
      ...NON_OBJECTS,
      [{}, 'missing project_slug'],
      ...BAD_SLUGS.map(([value, why]) => [{ project_slug: value }, `project_slug with ${why}`]),
      [{ project_slug: 'p', status: 'archived' }, 'a value outside the enum'],
      [{ project_slug: 'p', has_seen: 'true' }, 'a string for a boolean'],
      [{ project_slug: 'p', issue_ids: [] }, 'an empty issue_ids array'],
      [{ project_slug: 'p', issue_ids: '1' }, 'a bare string for issue_ids'],
      [{ project_slug: 'p', issue_ids: [1] }, 'a number in issue_ids'],
      [{ project_slug: 'p', issue_ids: ['WEB-1A3'] }, 'a short ID in issue_ids (numeric only)'],
      ...BAD_NUMERIC_IDS.filter(([value]) => typeof value === 'string')
        .map(([value, why]) => [{ project_slug: 'p', issue_ids: ['1', value] }, `issue_ids with ${why}`]),
      [
        { project_slug: 'p', issue_ids: Array.from({ length: 101 }, (_, i) => String(i + 1)) },
        'more than 100 issue_ids',
      ],
    ],
  },
  {
    guard: 'isValidListProjectsArgs',
    valid: [{}, { cursor: '0:100:0' }],
    invalid: [...NON_OBJECTS, [{ cursor: 5 }, 'a non-string cursor']],
  },
  {
    guard: 'isValidGetEventArgs',
    valid: [
      { project_slug: 'p', event_id: 'abc123' },
      { project_slug: 'p', event_id: 'a-b_c' },
      { project_slug: 'p', event_id: 'e', offset: 0 },
      { project_slug: 'p', event_id: 'e', entry_type: 'exception' },
      { project_slug: 'p', event_id: 'e', entry_type: 'breadcrumbs' },
    ],
    invalid: [
      ...NON_OBJECTS,
      [{ project_slug: 'p' }, 'a missing event_id'],
      [{ project_slug: 'p', event_id: 'a/b' }, 'a path separator in event_id'],
      [{ project_slug: 'p', event_id: '../etc' }, 'a traversal in event_id'],
      [{ project_slug: 'p', event_id: 'a.b' }, 'a dot in event_id'],
      [{ project_slug: 'p', event_id: '' }, 'an empty event_id'],
      [{ project_slug: 'p', event_id: 'e', entry_type: 'stacktrace' }, 'a value outside the entry enum'],
      [{ project_slug: 'p', event_id: 'e', limit: 0 }, 'a limit below the minimum'],
      [{ project_slug: 'p', event_id: 'e', offset: -1 }, 'a negative offset'],
      [{ project_slug: 'p', event_id: 'e', offset: Number.NaN }, 'NaN'],
    ],
  },
  {
    guard: 'isValidListIssueEventsArgs',
    valid: [{ issue_id: '1' }, { issue_id: '1', limit: 100, full: true }],
    invalid: [
      ...NON_OBJECTS,
      ...BAD_ISSUE_IDS.map(([value, why]) => [{ issue_id: value }, `issue_id with ${why}`]),
      ...BAD_LIMITS_1_100.map(([value, why]) => [{ issue_id: '1', limit: value }, `limit ${why}`]),
    ],
  },
  {
    guard: 'isValidListErrorEventsArgs',
    valid: [{ project_slug: 'p' }, { project_slug: 'p', limit: 1, query: 'x', full: false }],
    invalid: [
      ...NON_OBJECTS,
      ...BAD_SLUGS.map(([value, why]) => [{ project_slug: value }, `project_slug with ${why}`]),
      ...BAD_LIMITS_1_100.map(([value, why]) => [{ project_slug: 'p', limit: value }, `limit ${why}`]),
    ],
  },
  {
    guard: 'isValidGetStackFramesArgs',
    valid: [
      { project_slug: 'p', event_id: 'e' },
      { project_slug: 'p', event_id: 'e', in_app_only: true, max_frames: 100 },
    ],
    invalid: [
      ...NON_OBJECTS,
      [{ project_slug: 'p', event_id: 'e', max_frames: 0 }, 'a frame count below the minimum'],
      [{ project_slug: 'p', event_id: 'e', max_frames: 101 }, 'a frame count above the maximum'],
      [{ project_slug: 'p', event_id: 'e', max_frames: Number.POSITIVE_INFINITY }, 'Infinity'],
      [{ project_slug: 'p', event_id: 'e', in_app_only: 1 }, 'a number for a boolean'],
    ],
  },
  {
    guard: 'isValidCheckDsymArgs',
    valid: [{ project_slug: 'p' }, { project_slug: 'p', event_id: 'abc' }],
    invalid: [
      ...NON_OBJECTS,
      ...BAD_SLUGS.map(([value, why]) => [{ project_slug: value }, `project_slug with ${why}`]),
      [{ project_slug: 'p', event_id: 'a/b' }, 'a path separator in event_id'],
    ],
  },
  {
    guard: 'isValidListBreadcrumbsArgs',
    valid: [{ project_slug: 'p', event_id: 'e' }, { project_slug: 'p', event_id: 'e', limit: 50, type: 'http' }],
    invalid: [
      ...NON_OBJECTS,
      [{ project_slug: 'p' }, 'a missing event_id'],
      ...BAD_LIMITS_1_100.map(([value, why]) => [{ project_slug: 'p', event_id: 'e', limit: value }, `limit ${why}`]),
    ],
  },
  {
    guard: 'isValidListReleasesArgs',
    valid: [{}, { date: 'adopted' }, { date: 'unadopted' }, { sort: 'date' }, { sort: 'semver' }, { limit: 100 }],
    invalid: [
      ...NON_OBJECTS,
      [{ date: 'yesterday' }, 'a value outside the date enum'],
      [{ sort: 'version' }, 'a value outside the sort enum'],
      ...BAD_LIMITS_1_100.map(([value, why]) => [{ limit: value }, `limit ${why}`]),
    ],
  },
  {
    guard: 'isValidGetReleaseArgs',
    // Versions are free-form (semver, SHA, custom); the client URL-encodes them.
    valid: [{ version: '1.0.0' }, { version: 'release/1.2.3+build' }, { version: 'x', full: true }],
    invalid: [...NON_OBJECTS, [{}, 'a missing version'], [{ version: 42 }, 'a non-string version']],
  },
  {
    guard: 'isValidGetIssueTagsArgs',
    valid: [{ issue_id: '7' }],
    invalid: [...NON_OBJECTS, ...BAD_ISSUE_IDS.map(([value, why]) => [{ issue_id: value }, `issue_id with ${why}`])],
  },
  {
    guard: 'isValidGetIssueTagValuesArgs',
    // Tag keys are free-form (e.g. "user.email"); the client URL-encodes them.
    valid: [{ issue_id: '7', tag_key: 'user.email' }, { issue_id: '7', tag_key: 'env', limit: 100 }],
    invalid: [
      ...NON_OBJECTS,
      [{ issue_id: '7' }, 'a missing tag_key'],
      [{ issue_id: '7', tag_key: 42 }, 'a non-string tag_key'],
      ...BAD_LIMITS_1_100.map(([value, why]) => [{ issue_id: '7', tag_key: 'env', limit: value }, `limit ${why}`]),
    ],
  },
  {
    guard: 'isValidListActivityArgs',
    valid: [{ issue_id: '7' }, { issue_id: '7', limit: 1, cursor: 'c' }],
    invalid: [
      ...NON_OBJECTS,
      ...BAD_ISSUE_IDS.map(([value, why]) => [{ issue_id: value }, `issue_id with ${why}`]),
      ...BAD_LIMITS_1_100.map(([value, why]) => [{ issue_id: '7', limit: value }, `limit ${why}`]),
    ],
  },
  {
    guard: 'isValidGetTraceArgs',
    valid: [{ trace_id: 'abc123' }, { trace_id: 'a-b_c', max_spans: 1 }, { trace_id: 't', max_spans: 500 }],
    invalid: [
      ...NON_OBJECTS,
      [{ trace_id: 'a/b' }, 'a path separator in trace_id'],
      [{ trace_id: '' }, 'an empty trace_id'],
      [{ trace_id: 't', max_spans: 0 }, 'a span count below the minimum'],
      [{ trace_id: 't', max_spans: 501 }, 'a span count above the maximum'],
      [{ trace_id: 't', max_spans: Number.NaN }, 'NaN'],
    ],
  },
  {
    guard: 'isValidMergeIssuesArgs',
    valid: [
      { issue_id: '1', target_ids: [] },
      { issue_id: '1', target_ids: ['2', '3'] },
      { issue_id: '1', target_ids: Array.from({ length: 10 }, (_, i) => String(i)) },
      { issue_id: 'WEB-1A3', target_ids: ['WEB-1A4', '42'] },
    ],
    invalid: [
      ...NON_OBJECTS,
      [{ issue_id: '1' }, 'missing target_ids'],
      [{ issue_id: '1', target_ids: '2' }, 'a bare string for an array'],
      [{ issue_id: '1', target_ids: [2, 3] }, 'numeric array elements'],
      [{ issue_id: '1', target_ids: ['2', 'abc'] }, 'an id that is neither numeric nor a short ID'],
      ...BAD_ISSUE_IDS.map(([value, why]) => [{ issue_id: '1', target_ids: ['2', value] }, `target_ids with ${why}`]),
      [
        { issue_id: '1', target_ids: Array.from({ length: 11 }, (_, i) => String(i)) },
        'more than the 10-target maximum',
      ],
    ],
  },
  {
    guard: 'isValidGetGroupingConfigArgs',
    valid: [{ issue_id: '7' }],
    invalid: [...NON_OBJECTS, ...BAD_ISSUE_IDS.map(([value, why]) => [{ issue_id: value }, `issue_id with ${why}`])],
  },
  {
    guard: 'isValidRawApiArgs',
    valid: [
      { endpoint: 'projects/o/p/events/' },
      { endpoint: 'e', method: 'GET' },
      { endpoint: 'e', params: { a: 1 } },
      { endpoint: 'e', grep_pattern: '"tags"' },
    ],
    invalid: [
      ...NON_OBJECTS,
      [{}, 'a missing endpoint'],
      [{ endpoint: 42 }, 'a non-string endpoint'],
      [{ endpoint: 'e', method: 5 }, 'a non-string method'],
      [{ endpoint: 'e', grep_pattern: 5 }, 'a non-string grep_pattern'],
    ],
  },
];

describe('helpers/index — argument type guards', () => {
  it('covers every guard the module exports', () => {
    const exported = Object.keys(guards).filter((key) => key.startsWith('isValid'));
    const covered = table.map((entry) => entry.guard);

    assert.deepStrictEqual(
      exported.filter((name) => !covered.includes(name)),
      [],
      'every exported guard needs a boundary table entry'
    );
  });

  for (const { guard: guardName, valid, invalid } of table) {
    describe(guardName, () => {
      const guard = guards[guardName];

      it('is exported as a function', () => {
        assert.strictEqual(typeof guard, 'function', `${guardName} should be exported`);
      });

      for (const args of valid) {
        it(`accepts ${JSON.stringify(args)}`, () => {
          assert.strictEqual(guard(args), true, `${guardName} should accept ${JSON.stringify(args)}`);
        });
      }

      for (const [args, why] of invalid) {
        it(`rejects ${why}`, () => {
          assert.strictEqual(guard(args), false, `${guardName} should reject ${why}: ${JSON.stringify(args)}`);
        });
      }
    });
  }
});

/** Every guard whose `issue_id` accepts short IDs, with the extra args it needs. */
const ISSUE_ID_GUARDS = [
  ['isValidUpdateIssueArgs', { status: 'resolved' }],
  ['isValidCreateCommentArgs', { comment_text: 'x' }],
  ['isValidGetIssueHashesArgs', {}],
  ['isValidListIssueEventsArgs', {}],
  ['isValidGetIssueTagsArgs', {}],
  ['isValidGetIssueTagValuesArgs', { tag_key: 'env' }],
  ['isValidListActivityArgs', {}],
  ['isValidMergeIssuesArgs', { target_ids: [] }],
  ['isValidGetGroupingConfigArgs', {}],
];

describe('helpers/index — issue ids (numeric or short ID)', () => {
  it('isIssueId accepts numeric and short IDs', () => {
    for (const id of GOOD_ISSUE_IDS) {
      assert.strictEqual(guards.isIssueId(id), true, `isIssueId should accept ${JSON.stringify(id)}`);
    }
  });

  for (const [value, why] of BAD_ISSUE_IDS) {
    it(`isIssueId rejects ${why}`, () => {
      assert.strictEqual(guards.isIssueId(value), false, `isIssueId should reject ${JSON.stringify(value)}`);
    });
  }

  for (const [guardName, extra] of ISSUE_ID_GUARDS) {
    it(`${guardName} accepts numeric and short issue IDs`, () => {
      for (const id of GOOD_ISSUE_IDS) {
        const args = { ...extra, issue_id: id };
        assert.strictEqual(guards[guardName](args), true, `${guardName} should accept ${JSON.stringify(args)}`);
      }
    });
  }
});
