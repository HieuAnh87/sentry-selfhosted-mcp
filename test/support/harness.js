/**
 * Shared test harness: a live MCP server over stdio, plus a stand-in Sentry API.
 *
 * `node --test` treats every .js file under test/ as a test file, so this module
 * is deliberately side-effect free and declares no tests of its own; the runner
 * reports it as a file containing zero tests.
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(HERE, '..', '..');

/**
 * The server the harness drives. Defaults to this repo's build; the override
 * exists so the same suite can be pointed at an installed tarball (CI packaging
 * smoke test) or at a pre-fix build when proving a regression test red.
 */
export const SERVER_ENTRY =
  process.env.SENTRY_MCP_TEST_ENTRY || path.join(REPO_ROOT, 'build', 'index.js');

export const TEST_ORG = 'test-org';

/**
 * Distinctive so a leak is unambiguous: any test that greps process output for
 * this string is asserting the token never reaches a log sink.
 */
export const TEST_TOKEN = 'sntrys-SECRET-TOKEN-MUST-NEVER-BE-LOGGED';

const PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

// ============================================================
// Stand-in Sentry API
// ============================================================

/**
 * Minimal HTTP server standing in for Sentry.
 *
 * nock cannot help here: the server under test runs in a *child* process, so
 * interception has to happen over a real socket.
 */
export class StubSentry {
  /** @type {{method: string, path: string, pathname: string, query: URLSearchParams, headers: object, body: string}[]} */
  requests = [];

  #server = null;
  #port = 0;
  #queue = [];
  #fallback = { status: 200, body: {} };

  /** Queue a one-shot response, consumed in FIFO order. */
  enqueue(responder) {
    this.#queue.push(responder);
    return this;
  }

  /** Response used once the queue is drained. */
  setDefault(responder) {
    this.#fallback = responder;
    return this;
  }

  /** Clear recorded traffic and queued responses between tests. */
  reset() {
    this.requests.length = 0;
    this.#queue.length = 0;
    this.#fallback = { status: 200, body: {} };
    return this;
  }

  get origin() {
    return `http://127.0.0.1:${this.#port}`;
  }

  /** Paths of every request that actually reached this server. */
  get paths() {
    return this.requests.map((r) => r.pathname);
  }

  async start() {
    this.#server = http.createServer((req, res) => this.#handle(req, res));
    this.#server.listen(0, '127.0.0.1');
    await once(this.#server, 'listening');
    this.#port = this.#server.address().port;
    return this;
  }

  async stop() {
    if (!this.#server) return;
    this.#server.closeAllConnections?.();
    this.#server.close();
    await once(this.#server, 'close');
    this.#server = null;
  }

  #handle(req, res) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const url = new URL(req.url, this.origin);
      this.requests.push({
        method: req.method,
        path: req.url,
        pathname: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });

      const responder = this.#queue.shift() ?? this.#fallback;
      const spec = typeof responder === 'function' ? await responder(req) : responder;

      if (spec.delayMs) await new Promise((r) => globalThis.setTimeout(r, spec.delayMs));
      if (spec.destroy) {
        res.destroy();
        return;
      }

      const status = spec.status ?? 200;
      // `raw` bypasses JSON.stringify so a test can serve a malformed body.
      const payload = spec.raw ?? JSON.stringify(spec.body ?? {});
      res.writeHead(status, { 'Content-Type': 'application/json', ...(spec.headers ?? {}) });
      res.end(payload);
    });
  }
}

// ============================================================
// MCP server over stdio
// ============================================================

/**
 * Drives `build/index.js` the way a real MCP client does: newline-delimited
 * JSON-RPC over stdio.
 *
 * Returns the raw JSON-RPC envelope rather than unwrapping it, because the
 * distinction that matters to these tests is *protocol error* (`envelope.error`)
 * versus *tool result carrying `isError: true`* (`envelope.result.isError`).
 */
export class McpServerProcess {
  #child = null;
  #stdoutBuffer = '';
  #stderr = '';
  #pending = new Map();
  #nextId = 1;
  #exited = false;

  static async start(options = {}) {
    const server = new McpServerProcess();
    await server.#start(options);
    return server;
  }

  /** Everything the server has written to stderr so far. */
  get stderr() {
    return this.#stderr;
  }

  /**
   * `entry` defaults to the real build. It is overridable so a pre-fix build can
   * be driven through the identical harness when proving a regression test red.
   */
  async #start({ sentryUrl = 'http://127.0.0.1:1', org = TEST_ORG, token = TEST_TOKEN, env = {}, entry = SERVER_ENTRY } = {}) {
    this.#child = spawn(process.execPath, [entry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SENTRY_URL: sentryUrl,
        SENTRY_AUTH_TOKEN: token,
        SENTRY_ORG_SLUG: org,
        // Never inherit the parent's read-only setting: each test states its own.
        SENTRY_READ_ONLY: '',
        ...env,
      },
    });

    this.#child.stdout.setEncoding('utf8');
    this.#child.stderr.setEncoding('utf8');
    this.#child.stdout.on('data', (chunk) => this.#onStdout(chunk));
    this.#child.stderr.on('data', (chunk) => { this.#stderr += chunk; });
    this.#child.on('exit', () => {
      this.#exited = true;
      for (const { reject, timer } of this.#pending.values()) {
        clearTimeout(timer);
        reject(new Error(`MCP server exited before responding. stderr:\n${this.#stderr}`));
      }
      this.#pending.clear();
    });

    await this.send('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'harness', version: '1.0.0' },
    });
    this.notify('notifications/initialized');
  }

  #onStdout(chunk) {
    this.#stdoutBuffer += chunk;
    let newline;
    while ((newline = this.#stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.#stdoutBuffer.slice(0, newline).trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // not a JSON-RPC frame
      }

      const waiter = this.#pending.get(message.id);
      if (!waiter) continue;
      this.#pending.delete(message.id);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  }

  /** Send a request; resolves with the whole JSON-RPC envelope. */
  send(method, params = {}, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    if (this.#exited) {
      return Promise.reject(new Error(`MCP server already exited. stderr:\n${this.#stderr}`));
    }

    const id = this.#nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${method}. stderr:\n${this.#stderr}`));
      }, timeoutMs);
      // Do not keep the event loop alive just for this timer.
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
    });

    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return promise;
  }

  notify(method, params = {}) {
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  /** @returns the JSON-RPC envelope for a tools/call request. */
  callTool(name, args = {}, options) {
    return this.send('tools/call', { name, arguments: args }, options);
  }

  async listTools() {
    const envelope = await this.send('tools/list');
    if (envelope.error) throw new Error(`tools/list failed: ${JSON.stringify(envelope.error)}`);
    return envelope.result.tools;
  }

  async stop() {
    if (!this.#child || this.#exited) return;
    this.#child.stdin.end();
    this.#child.kill();
    await once(this.#child, 'exit');
  }
}

/** Concatenated text of every text block in a tool result. */
export function toolText(result) {
  return (result?.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}
