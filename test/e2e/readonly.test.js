/**
 * SENTRY_READ_ONLY end-to-end tests.
 *
 * The mode is opt-in and defaults to off, so this file asserts both halves:
 * that enabling it actually refuses every mutating path *before* any HTTP
 * request is made, and that leaving it unset keeps the existing behaviour
 * exactly as it was.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';

import { McpServerProcess, StubSentry } from '../support/harness.js';

/** Tools the read-only gate must refuse. */
const MUTATING_TOOLS = [
  ['update_sentry_issue_status', { issue_id: '123', status: 'resolved' }],
  ['create_sentry_issue_comment', { issue_id: '123', comment_text: 'hi' }],
  ['bulk_update_issues', { project_slug: 'web', status: 'resolved' }],
  ['merge_issues', { issue_id: '123', target_ids: ['456'] }],
];

/** Tools that only read, and must keep working in read-only mode. */
const READ_TOOLS = [
  ['list_teams', {}],
  ['list_sentry_projects', {}],
  ['get_sentry_issue', { issue_id_or_url: '123' }],
];

describe('SENTRY_READ_ONLY enabled', () => {
  /** @type {StubSentry} */ let sentry;
  /** @type {McpServerProcess} */ let server;

  before(async () => {
    sentry = await new StubSentry().start();
    server = await McpServerProcess.start({
      sentryUrl: sentry.origin,
      env: { SENTRY_READ_ONLY: 'true' },
    });
  });

  after(async () => {
    await server?.stop();
    await sentry?.stop();
  });

  beforeEach(() => {
    sentry.reset();
    sentry.setDefault({ status: 200, body: {} });
  });

  for (const [name, args] of MUTATING_TOOLS) {
    it(`refuses ${name} without contacting Sentry`, async () => {
      const envelope = await server.callTool(name, args);

      assert.ok(envelope.error, `${name} must be refused in read-only mode`);
      assert.match(envelope.error.message, /read-only/i);
      assert.match(envelope.error.message, /SENTRY_READ_ONLY/);
      assert.strictEqual(sentry.requests.length, 0, 'a refused tool must not reach Sentry at all');
    });
  }

  for (const method of ['POST', 'PUT', 'DELETE']) {
    it(`refuses raw_sentry_api ${method} without contacting Sentry`, async () => {
      const envelope = await server.callTool('raw_sentry_api', {
        endpoint: 'issues/123/',
        method,
        body: { status: 'resolved' },
      });

      assert.ok(envelope.error, `raw_sentry_api ${method} must be refused in read-only mode`);
      assert.match(envelope.error.message, /read-only/i);
      assert.strictEqual(sentry.requests.length, 0, 'a refused call must not reach Sentry at all');
    });
  }

  it('refuses a lowercase raw_sentry_api method too', async () => {
    const envelope = await server.callTool('raw_sentry_api', { endpoint: 'issues/123/', method: 'post' });

    assert.ok(envelope.error, 'the method check must not be case-sensitive');
    assert.strictEqual(sentry.requests.length, 0);
  });

  it('still allows raw_sentry_api GET', async () => {
    sentry.setDefault({ status: 200, body: { id: '1' } });

    const envelope = await server.callTool('raw_sentry_api', { endpoint: 'issues/123/', method: 'GET' });

    assert.strictEqual(envelope.error, undefined);
    assert.deepStrictEqual(sentry.paths, ['/api/0/issues/123/']);
  });

  for (const [name, args] of READ_TOOLS) {
    it(`still allows ${name}`, async () => {
      sentry.setDefault({ status: 200, body: [] });

      const envelope = await server.callTool(name, args);

      assert.strictEqual(envelope.error, undefined, `${name} must keep working in read-only mode`);
      assert.ok(sentry.requests.length > 0, `${name} should have reached Sentry`);
    });
  }

  it('still serves the full tool list', async () => {
    // Read-only refuses calls; it does not hide tools, so a client's view of the
    // contract stays stable.
    const tools = await server.listTools();

    assert.strictEqual(tools.length, 24);
  });
});

describe('SENTRY_READ_ONLY unset (default)', () => {
  /** @type {StubSentry} */ let sentry;
  /** @type {McpServerProcess} */ let server;

  before(async () => {
    sentry = await new StubSentry().start();
    server = await McpServerProcess.start({ sentryUrl: sentry.origin });
  });

  after(async () => {
    await server?.stop();
    await sentry?.stop();
  });

  beforeEach(() => {
    sentry.reset();
    sentry.setDefault({ status: 200, body: {} });
  });

  for (const [name, args] of MUTATING_TOOLS) {
    it(`still allows ${name}`, async () => {
      const envelope = await server.callTool(name, args);

      assert.strictEqual(
        envelope.error,
        undefined,
        `${name} must keep working when read-only is not enabled: ${JSON.stringify(envelope.error)}`
      );
      assert.ok(sentry.requests.length > 0, `${name} should have reached Sentry`);
    });
  }

  it('still allows raw_sentry_api POST', async () => {
    const envelope = await server.callTool('raw_sentry_api', {
      endpoint: 'issues/123/',
      method: 'POST',
      body: { status: 'resolved' },
    });

    assert.strictEqual(envelope.error, undefined);
    assert.strictEqual(sentry.requests.length, 1);
    assert.strictEqual(sentry.requests[0].method, 'POST');
  });
});

describe('SENTRY_READ_ONLY value parsing', () => {
  /** Spawn a server with one SENTRY_READ_ONLY value and see if a mutation is refused. */
  async function mutationRefusedWith(value) {
    const sentry = await new StubSentry().start();
    const server = await McpServerProcess.start({
      sentryUrl: sentry.origin,
      env: { SENTRY_READ_ONLY: value },
    });
    try {
      const envelope = await server.callTool('update_sentry_issue_status', {
        issue_id: '123',
        status: 'resolved',
      });
      return Boolean(envelope.error);
    } finally {
      await server.stop();
      await sentry.stop();
    }
  }

  for (const value of ['true', '1', 'TRUE', ' true ']) {
    it(`treats ${JSON.stringify(value)} as enabled`, async () => {
      assert.strictEqual(await mutationRefusedWith(value), true);
    });
  }

  for (const value of ['false', '0', '', 'yes']) {
    it(`treats ${JSON.stringify(value)} as disabled`, async () => {
      assert.strictEqual(await mutationRefusedWith(value), false);
    });
  }
});
