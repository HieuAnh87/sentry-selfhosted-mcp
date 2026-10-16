/**
 * Error-path tests.
 *
 * The regression these guard: every dispatch case in src/server.ts used to
 * `return` the handler promise instead of `return await`-ing it, so a rejection
 * escaped the surrounding try/catch entirely and handleToolError/mapAxiosError
 * were unreachable. A failing Sentry call surfaced as a raw JSON-RPC protocol
 * error rather than a tool result.
 *
 * Here the mapping itself is tested against real AxiosErrors produced by real
 * (intercepted) HTTP. test/e2e/server.test.js covers the other half: that the
 * dispatcher actually routes those rejections through this mapping.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import nock from 'nock';

const AUTH_TOKEN = 'sntrys-SECRET-TOKEN-MUST-NEVER-BE-LOGGED';

process.env.SENTRY_URL = process.env.SENTRY_URL || 'https://sentry.test.local';
process.env.SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN || AUTH_TOKEN;
process.env.SENTRY_ORG_SLUG = process.env.SENTRY_ORG_SLUG || 'org';

const { handleGetSentryIssue, handleListSentryProjects, handleToolError } =
  await import('../../build/tools/issues.js');

const BASE = 'https://sentry.test.local';
const ISSUE_PATH = '/api/0/organizations/org/issues/123/';
const PROJECTS_PATH = '/api/0/organizations/org/projects/';

/**
 * Run a handler the way the server dispatcher does: await it, and route any
 * rejection through handleToolError.
 */
async function callTool(fn, toolName) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof Error && error.name === 'McpError') throw error;
    return handleToolError(error, toolName);
  }
}

const textOf = (result) => (result.content ?? []).map((block) => block.text).join('\n');

/**
 * A transport-level failure for nock to emit.
 *
 * Must be a real Error: handed a plain object, nock does not fail the socket
 * promptly and the request instead sits until axios' own 20s timeout fires,
 * which both slows the suite and tests the wrong failure.
 */
const networkError = (code, message) => Object.assign(new Error(message), { code });

describe('tool error mapping', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  const getIssue = () => callTool(() => handleGetSentryIssue({ issue_id_or_url: '123' }), 'get_sentry_issue');

  it('maps 401 to a permission-denied message', async () => {
    nock(BASE).get(ISSUE_PATH).reply(401, { detail: 'Invalid token' });

    const result = await getIssue();

    assert.strictEqual(result.isError, true, 'must be a tool result, not a thrown protocol error');
    assert.match(textOf(result), /permission denied/i);
    assert.match(textOf(result), /get_sentry_issue/);
  });

  it('maps 403 to a permission-denied message', async () => {
    nock(BASE).get(ISSUE_PATH).reply(403, { detail: 'Forbidden' });

    const result = await getIssue();

    assert.strictEqual(result.isError, true);
    assert.match(textOf(result), /permission denied/i);
  });

  it('maps 404 to a resource-not-found message', async () => {
    nock(BASE).get(ISSUE_PATH).reply(404, { detail: 'Not found' });

    const result = await getIssue();

    assert.strictEqual(result.isError, true);
    assert.match(textOf(result), /not found/i);
    assert.match(textOf(result), /IDs\/slugs/i);
  });

  it('reports 429 as an error result rather than throwing', async () => {
    nock(BASE).get(ISSUE_PATH).reply(429, { detail: 'Rate limit exceeded' });

    const result = await getIssue();

    assert.strictEqual(result.isError, true);
    assert.match(textOf(result), /429/);
  });

  it('reports 500 as an error result rather than throwing', async () => {
    nock(BASE).get(ISSUE_PATH).reply(500, { detail: 'Internal server error' });

    const result = await getIssue();

    assert.strictEqual(result.isError, true);
    assert.match(textOf(result), /500/);
  });

  it('reports a connection timeout as an error result', async () => {
    nock(BASE)
      .get(ISSUE_PATH)
      .replyWithError(networkError('ECONNABORTED', 'timeout of 20000ms exceeded'));

    const result = await getIssue();

    assert.strictEqual(result.isError, true);
    assert.match(textOf(result), /timeout/i);
  });

  it('reports a refused connection as an error result', async () => {
    nock(BASE)
      .get(ISSUE_PATH)
      .replyWithError(networkError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:443'));

    const result = await getIssue();

    assert.strictEqual(result.isError, true);
  });

  it('reports a malformed JSON body as an error result rather than crashing', async () => {
    // Axios parses response bodies leniently, so a truncated body arrives as a
    // raw string; the handler must fail cleanly instead of throwing out of band.
    nock(BASE)
      .get(PROJECTS_PATH)
      .reply(200, '[{"id": "1", "slug": "web"', { 'content-type': 'application/json' });

    const result = await callTool(() => handleListSentryProjects(), 'list_sentry_projects');

    assert.strictEqual(result.isError, true);
    assert.ok(textOf(result).length > 0, 'an error result must carry a message');
  });

  it('reports an HTML error page as an error result rather than crashing', async () => {
    // What a reverse proxy or an SSO redirect actually returns in front of Sentry.
    nock(BASE)
      .get(PROJECTS_PATH)
      .reply(200, '<html><body>Sign in</body></html>', { 'content-type': 'text/html' });

    const result = await callTool(() => handleListSentryProjects(), 'list_sentry_projects');

    assert.strictEqual(result.isError, true);
    assert.match(textOf(result), /non-JSON response \(HTTP 200, text\/html\)/);
  });

  it('keeps the status of a proxy timeout page instead of a JSON parse error', async () => {
    nock(BASE).get(ISSUE_PATH).reply(504, 'upstream request timeout', { 'content-type': 'text/plain' });

    const result = await callTool(() => handleGetSentryIssue({ issue_id_or_url: '123' }), 'get_sentry_issue');

    assert.strictEqual(result.isError, true);
    assert.match(textOf(result), /HTTP 504/);
    assert.match(textOf(result), /upstream request timeout/);
    assert.doesNotMatch(textOf(result), /Unexpected token/);
  });

  it('still decodes a JSON error body for its detail', async () => {
    nock(BASE).get(ISSUE_PATH).reply(403, JSON.stringify({ detail: 'Missing scope event:read' }), { 'content-type': 'application/json' });

    const result = await callTool(() => handleGetSentryIssue({ issue_id_or_url: '123' }), 'get_sentry_issue');

    assert.match(textOf(result), /Missing scope event:read/);
  });
});

describe('tool error messages carry Sentry\'s explanation, bounded', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  const getIssue = () => callTool(() => handleGetSentryIssue({ issue_id_or_url: '123' }), 'get_sentry_issue');

  for (const status of [401, 403, 404]) {
    it(`keeps Sentry's detail string on ${status}`, async () => {
      nock(BASE).get(ISSUE_PATH).reply(status, { detail: `Sentry explanation for ${status}` });

      const result = await getIssue();

      assert.strictEqual(result.isError, true);
      assert.match(textOf(result), new RegExp(`Sentry explanation for ${status}`));
      assert.match(textOf(result), new RegExp(`HTTP ${status}`));
    });
  }

  it('points a 404 at the discovery tools', async () => {
    nock(BASE).get(ISSUE_PATH).reply(404, { detail: 'The requested resource does not exist' });

    const text = textOf(await getIssue());

    assert.match(text, /list_sentry_projects/);
    assert.match(text, /list_issues/);
    assert.match(text, /short ID/i);
  });

  it('mentions Retry-After on a 429 when Sentry sends it', async () => {
    nock(BASE).get(ISSUE_PATH).reply(429, { detail: 'Rate limit exceeded' }, { 'Retry-After': '17' });

    const text = textOf(await getIssue());

    assert.match(text, /429/);
    assert.match(text, /Retry-After: 17/);
    assert.match(text, /Rate limit exceeded/);
  });

  it('still reports a 429 without a Retry-After header', async () => {
    nock(BASE).get(ISSUE_PATH).reply(429, {});

    const text = textOf(await getIssue());

    assert.match(text, /429/);
    assert.doesNotMatch(text, /Retry-After/);
  });

  it('caps a huge response body at about 500 characters', async () => {
    const huge = 'x'.repeat(20_000);
    nock(BASE).get(ISSUE_PATH).reply(502, { error: huge });

    const text = textOf(await getIssue());

    assert.match(text, /502/);
    assert.match(text, /truncated/);
    assert.ok(text.length < 1000, `error text should be bounded, got ${text.length} chars`);
  });

  it('caps a huge detail string too', async () => {
    nock(BASE).get(ISSUE_PATH).reply(403, { detail: 'y'.repeat(5000) });

    const text = textOf(await getIssue());

    assert.match(text, /permission denied/i);
    assert.ok(text.length < 1000, `error text should be bounded, got ${text.length} chars`);
  });
});

describe('tool error messages never leak the auth token', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  const cases = [
    ['401', (i) => i.reply(401, { detail: 'Invalid token' })],
    ['403', (i) => i.reply(403, { detail: 'Forbidden' })],
    ['404', (i) => i.reply(404, { detail: 'Not found' })],
    ['429', (i) => i.reply(429, { detail: 'Rate limited' })],
    ['500', (i) => i.reply(500, { detail: 'Boom' })],
    ['a network error', (i) => i.replyWithError(networkError('ECONNABORTED', 'timeout of 20000ms exceeded'))],
  ];

  for (const [label, respond] of cases) {
    it(`omits the token and the Authorization header for ${label}`, async () => {
      respond(nock(BASE).get(ISSUE_PATH));

      const result = await callTool(
        () => handleGetSentryIssue({ issue_id_or_url: '123' }),
        'get_sentry_issue'
      );
      const text = textOf(result);

      assert.strictEqual(result.isError, true);
      assert.ok(!text.includes(process.env.SENTRY_AUTH_TOKEN), `error text leaked the auth token: ${text}`);
      assert.ok(!/Bearer/i.test(text), `error text leaked an Authorization header: ${text}`);
      assert.ok(!/Authorization/i.test(text), `error text leaked an Authorization header: ${text}`);
    });
  }
});
