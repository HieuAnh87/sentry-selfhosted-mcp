#!/usr/bin/env node

/**
 * Smoke test: the built server starts and speaks MCP over stdio.
 *
 * Deliberately shallow — tool schemas are covered by test/tools.test.js and
 * behaviour by test/e2e/. This is the "is the artifact runnable at all" check,
 * which is also what the packaging job in CI runs against an installed tarball.
 *
 * Runs both under `node --test` and directly via `npm run test:smoke`; failures
 * are assertions, so the runner reports which check failed and why.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';

import { McpServerProcess, SERVER_ENTRY } from './support/harness.js';

describe('smoke: built server', () => {
  /** @type {McpServerProcess} */
  let server;

  before(async () => {
    server = await McpServerProcess.start();
  });

  after(async () => {
    await server?.stop();
  });

  it('has a built entry point', () => {
    assert.ok(fs.existsSync(SERVER_ENTRY), `missing build artifact: ${SERVER_ENTRY}. Run npm run build.`);
  });

  it('responds to initialize with its server info', async () => {
    const envelope = await server.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '1.0.0' },
    });

    assert.strictEqual(envelope.error, undefined, `initialize failed: ${JSON.stringify(envelope.error)}`);
    assert.strictEqual(envelope.result.serverInfo.name, 'sentry-selfhosted-mcp');
    assert.ok(envelope.result.serverInfo.version, 'server should report a version');
    assert.ok(envelope.result.capabilities.tools, 'server should advertise tool capability');
  });

  it('responds to tools/list with a non-empty tool array', async () => {
    const tools = await server.listTools();

    assert.ok(Array.isArray(tools), 'tools/list should return an array');
    assert.ok(tools.length > 0, 'tools/list should not be empty');
  });

  it('exposes the core debugging tools', async () => {
    const toolNames = (await server.listTools()).map((tool) => tool.name);

    const expected = [
      'get_sentry_issue',
      'list_sentry_projects',
      'list_sentry_issues',
      'get_sentry_event_details',
      'update_sentry_issue_status',
      'create_sentry_issue_comment',
      'raw_sentry_api',
      'get_stack_frames',
      'check_dsym_status',
      'list_issue_events',
      'get_issue_hashes',
      'list_error_events',
    ];

    const missing = expected.filter((name) => !toolNames.includes(name));
    assert.deepStrictEqual(missing, [], `missing tools: ${missing.join(', ')}`);
  });

  it('responds to resources/list', async () => {
    const envelope = await server.send('resources/list');

    assert.strictEqual(envelope.error, undefined, `resources/list failed: ${JSON.stringify(envelope.error)}`);
    assert.ok(Array.isArray(envelope.result.resources));
  });
});

describe('smoke: startup configuration', () => {
  /** Start the built server with a deliberately incomplete environment. */
  async function startWith(env) {
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // A bare environment, so a value in the developer's shell cannot mask a failure.
      env: { PATH: process.env.PATH, ...env },
    });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    const [code] = await once(child, 'exit');
    return { code, stderr };
  }

  const required = ['SENTRY_URL', 'SENTRY_AUTH_TOKEN', 'SENTRY_ORG_SLUG'];
  const complete = {
    SENTRY_URL: 'https://sentry.example.com',
    SENTRY_AUTH_TOKEN: 'test-token',
    SENTRY_ORG_SLUG: 'test-org',
  };

  for (const missing of required) {
    it(`refuses to start without ${missing}`, async () => {
      const env = { ...complete };
      delete env[missing];

      const { code, stderr } = await startWith(env);

      assert.notStrictEqual(code, 0, `server should exit non-zero without ${missing}`);
      assert.match(stderr, new RegExp(missing), `startup error should name ${missing}`);
    });
  }

  it('refuses to start with a malformed SENTRY_URL', async () => {
    const { code, stderr } = await startWith({ ...complete, SENTRY_URL: 'not-a-url' });

    assert.notStrictEqual(code, 0, 'server should exit non-zero for an invalid URL');
    assert.match(stderr, /SENTRY_URL/);
  });

  it('does not print the auth token when startup fails', async () => {
    const token = 'sntrys-SECRET-STARTUP-TOKEN';
    const { stderr } = await startWith({ SENTRY_URL: 'https://sentry.example.com', SENTRY_AUTH_TOKEN: token });

    assert.ok(!stderr.includes(token), `startup error leaked the auth token:\n${stderr}`);
  });
});
