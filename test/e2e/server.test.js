/**
 * End-to-end tests against a real MCP server process.
 *
 * These cover the behaviours that only exist once the dispatcher is in the loop,
 * and that in-process handler tests cannot see:
 *
 *  - raw_sentry_api refuses an endpoint that would leave the configured host
 *    (the request carries the Authorization header, so a redirected call hands
 *    the Sentry token to whoever answers)
 *  - a failing Sentry call comes back as a tool result with isError: true, not
 *    as a raw JSON-RPC protocol error. Every dispatch case used to `return` the
 *    handler promise rather than `return await` it, so rejections bypassed the
 *    surrounding try/catch entirely
 *  - nothing the server writes to stderr contains the auth token
 *
 * One server process and two stub hosts are shared by the whole file.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';

import { McpServerProcess, StubSentry, TEST_TOKEN, toolText } from '../support/harness.js';

/** JSON-RPC error code the SDK emits for McpError(ErrorCode.InvalidParams). */
const INVALID_PARAMS = -32602;

describe('MCP server end-to-end', () => {
  /** @type {StubSentry} */ let sentry;
  /** @type {StubSentry} */ let attacker;
  /** @type {McpServerProcess} */ let server;

  before(async () => {
    sentry = await new StubSentry().start();
    // A second real host, so "did the request leave the configured origin?" is
    // answered by observation rather than by inspecting an error message.
    attacker = await new StubSentry().start();
    attacker.setDefault({ status: 200, body: { stolen: true } });
    server = await McpServerProcess.start({ sentryUrl: sentry.origin });
  });

  after(async () => {
    await server?.stop();
    await sentry?.stop();
    await attacker?.stop();
  });

  beforeEach(() => {
    sentry.reset();
    attacker.reset();
    attacker.setDefault({ status: 200, body: { stolen: true } });
  });

  describe('raw_sentry_api endpoint validation', () => {
    const rejected = [
      ['an absolute http URL', (origin) => `${origin}/steal`],
      ['an absolute URL with an uppercase scheme', (origin) => origin.replace('http://', 'HTTP://') + '/steal'],
      ['a protocol-relative URL', (origin) => `//${origin.replace('http://', '')}/steal`],
      ['a triple-slash prefix, which resolves protocol-relative', () => '///evil.example.com/steal'],
      ['a traversal segment', () => '../../../etc/passwd'],
      ['a traversal segment mid-path', () => 'projects/org/../../../admin/'],
      ['a backslash traversal segment', () => 'projects\\..\\admin'],
      ['an encoded traversal segment', () => '%2e%2e/%2e%2e/admin'],
      ['a mixed encoded traversal segment', () => '.%2e/.%2e/admin'],
      ['a backslash authority', () => '\\\\evil.example\\steal'],
    ];

    for (const [label, build] of rejected) {
      it(`refuses ${label}`, async () => {
        const endpoint = build(attacker.origin);

        const envelope = await server.callTool('raw_sentry_api', { endpoint });

        assert.ok(envelope.error, `endpoint "${endpoint}" must be refused, got: ${JSON.stringify(envelope.result)}`);
        assert.strictEqual(envelope.error.code, INVALID_PARAMS);
        assert.match(envelope.error.message, /Sentry.*api\/0|relative Sentry API path/i);
        assert.strictEqual(attacker.requests.length, 0, 'the attacker host must never be contacted');
        assert.strictEqual(sentry.requests.length, 0, 'a refused endpoint must not reach Sentry either');
      });
    }

    it('allows an ordinary relative endpoint', async () => {
      sentry.setDefault({ status: 200, body: { id: 'abc' } });

      const envelope = await server.callTool('raw_sentry_api', { endpoint: 'projects/org/web/events/abc/' });

      assert.strictEqual(envelope.error, undefined);
      assert.deepStrictEqual(sentry.paths, ['/api/0/projects/org/web/events/abc/']);
    });

    it('strips a leading slash rather than escaping the API prefix', async () => {
      sentry.setDefault({ status: 200, body: {} });

      await server.callTool('raw_sentry_api', { endpoint: '/projects/org/web/' });

      assert.deepStrictEqual(sentry.paths, ['/api/0/projects/org/web/']);
    });

    it('does not follow a redirect away from the configured Sentry origin', async () => {
      sentry.setDefault({
        status: 302,
        headers: { Location: `${attacker.origin}/steal` },
        body: {},
      });

      const envelope = await server.callTool('raw_sentry_api', { endpoint: 'redirect/' });

      assert.strictEqual(attacker.requests.length, 0, 'a redirect must not reach the attacker host');
      assert.strictEqual(sentry.requests.length, 1, 'only the configured Sentry host may be contacted');
      assert.strictEqual(envelope.error, undefined);
      assert.strictEqual(envelope.result?.isError, true);
    });
  });

  describe('failing Sentry calls become tool results, not protocol errors', () => {
    const tools = [
      ['get_sentry_issue', { issue_id_or_url: '123' }],
      ['list_sentry_projects', {}],
      ['list_sentry_issues', { project_slug: 'web' }],
      ['list_issues', {}],
      ['get_issue_hashes', { issue_id: '123' }],
      ['list_issue_events', { issue_id: '123' }],
      ['list_teams', {}],
      ['list_releases', {}],
      ['get_issue_tags', { issue_id: '123' }],
      ['get_trace_details', { trace_id: 'abc' }],
      ['raw_sentry_api', { endpoint: 'projects/org/web/' }],
    ];

    for (const [name, args] of tools) {
      it(`${name} reports a 500 as isError`, async () => {
        sentry.setDefault({ status: 500, body: { detail: 'internal error' } });

        const envelope = await server.callTool(name, args);

        assert.strictEqual(
          envelope.error,
          undefined,
          `${name} must not surface a protocol error: ${JSON.stringify(envelope.error)}`
        );
        assert.strictEqual(envelope.result.isError, true, `${name} must return a tool result flagged isError`);
        assert.ok(toolText(envelope.result).length > 0, 'an error result must carry a message');
      });
    }

    it('maps 401 to a permission-denied result', async () => {
      sentry.setDefault({ status: 401, body: { detail: 'Invalid token' } });

      const envelope = await server.callTool('get_sentry_issue', { issue_id_or_url: '123' });

      assert.strictEqual(envelope.error, undefined);
      assert.strictEqual(envelope.result.isError, true);
      assert.match(toolText(envelope.result), /permission denied/i);
    });

    it('maps 403 to a permission-denied result', async () => {
      sentry.setDefault({ status: 403, body: { detail: 'Forbidden' } });

      const envelope = await server.callTool('get_sentry_issue', { issue_id_or_url: '123' });

      assert.strictEqual(envelope.result.isError, true);
      assert.match(toolText(envelope.result), /permission denied/i);
    });

    it('maps 404 to a resource-not-found result', async () => {
      sentry.setDefault({ status: 404, body: { detail: 'Not found' } });

      const envelope = await server.callTool('get_sentry_issue', { issue_id_or_url: '123' });

      assert.strictEqual(envelope.result.isError, true);
      assert.match(toolText(envelope.result), /not found/i);
    });

    it('reports a 429 without throwing', async () => {
      sentry.setDefault({ status: 429, body: { detail: 'Rate limited' } });

      const envelope = await server.callTool('list_teams', {});

      assert.strictEqual(envelope.error, undefined);
      assert.strictEqual(envelope.result.isError, true);
    });

    it('reports a dropped connection without throwing', async () => {
      sentry.setDefault({ destroy: true });

      const envelope = await server.callTool('list_teams', {});

      assert.strictEqual(envelope.error, undefined);
      assert.strictEqual(envelope.result.isError, true);
    });

    it('still rejects invalid arguments at the protocol level', async () => {
      // Argument validation is a caller mistake, not a Sentry failure: it stays
      // an McpError so the client can distinguish the two.
      const envelope = await server.callTool('get_sentry_issue', { issue_id_or_url: 42 });

      assert.ok(envelope.error, 'invalid arguments should surface as a protocol error');
      assert.strictEqual(envelope.error.code, INVALID_PARAMS);
    });

    it('rejects an unknown tool at the protocol level', async () => {
      const envelope = await server.callTool('no_such_tool', {});

      assert.ok(envelope.error);
    });

    it('stays alive and serving after a run of failures', async () => {
      sentry.setDefault({ status: 500, body: { detail: 'boom' } });
      await server.callTool('list_teams', {});
      await server.callTool('list_releases', {});

      const tools = await server.listTools();

      assert.strictEqual(tools.length, 28, 'the server must survive failing tool calls');
    });
  });

  describe('the auth token never reaches a log sink', () => {
    it('is absent when the latest-event fallback logs a failure', async () => {
      // The specific path that used to hand a whole AxiosError to console.warn:
      // the issue fetch succeeds, the follow-up latest-event fetch fails, and
      // the handler logs the failure before returning the issue anyway.
      // util.inspect then printed config.headers.Authorization into the log.
      sentry.enqueue({ status: 200, body: { id: '123', title: 'boom' } });
      sentry.setDefault({ status: 500, body: { detail: 'no event' } });

      await server.callTool('get_sentry_issue', { issue_id_or_url: '123', include_latest_event: true });

      const stderr = server.stderr;
      assert.ok(!stderr.includes(TEST_TOKEN), `stderr leaked the auth token:\n${stderr}`);
      assert.ok(!/Bearer\s/i.test(stderr), `stderr leaked a Bearer credential:\n${stderr}`);
      assert.ok(!/[Aa]uthorization/.test(stderr), `stderr leaked an Authorization header:\n${stderr}`);
    });

    it('is absent from everything the server wrote to stderr', async () => {
      // Exercise the paths that log: successful calls, HTTP failures, a network
      // failure, and a refused endpoint.
      sentry.setDefault({ status: 200, body: {} });
      await server.callTool('list_teams', {});

      sentry.setDefault({ status: 401, body: { detail: 'Invalid token' } });
      await server.callTool('get_sentry_issue', { issue_id_or_url: '123' });

      sentry.setDefault({ status: 500, body: { detail: 'boom' } });
      await server.callTool('list_releases', {});

      sentry.setDefault({ destroy: true });
      await server.callTool('list_teams', {});

      await server.callTool('raw_sentry_api', { endpoint: `${attacker.origin}/steal` });

      const stderr = server.stderr;

      assert.ok(stderr.length > 0, 'the server should have logged something by now');
      assert.ok(!stderr.includes(TEST_TOKEN), `stderr leaked the auth token:\n${stderr}`);
      assert.ok(!/Bearer\s/i.test(stderr), `stderr leaked a Bearer credential:\n${stderr}`);
      assert.ok(!/[Aa]uthorization/.test(stderr), `stderr leaked an Authorization header:\n${stderr}`);
    });
  });
});
