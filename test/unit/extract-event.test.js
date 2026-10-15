/**
 * Pure extraction tests for helpers/extract.ts against Sentry's event API shape
 * (camelCase frames, `[lineNo, line]` context pairs, `[name, value]` headers).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

process.env.SENTRY_URL = process.env.SENTRY_URL || 'https://sentry.test.local';
process.env.SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN || 'test-token';
process.env.SENTRY_ORG_SLUG = process.env.SENTRY_ORG_SLUG || 'org';

const {
  extractEssentialEventEntry,
  extractBreadcrumbs,
  extractBreadcrumbTrail,
  sourceContextWindow,
  compactContexts,
  isInAppFrame,
} = await import('../../build/helpers/extract.js');

/** Sentry's usual 11-line context: 5 before, the line, 5 after. */
const elevenLineContext = (lineNo) =>
  Array.from({ length: 11 }, (_, i) => [lineNo - 5 + i, `line ${lineNo - 5 + i}`]);

describe('extract: frames', () => {
  it('reads the camelCase inApp flag Sentry returns, and the snake_case fallback', () => {
    assert.strictEqual(isInAppFrame({ inApp: true }), true);
    assert.strictEqual(isInAppFrame({ in_app: true }), true);
    assert.strictEqual(isInAppFrame({ inApp: false, in_app: true }), false);
    assert.strictEqual(isInAppFrame({}), false);
  });

  it('keeps context lines within ±3 of lineNo from an 11-line context', () => {
    const window = sourceContextWindow(elevenLineContext(42), 42);
    assert.deepStrictEqual(window.map(([n]) => n), [39, 40, 41, 42, 43, 44, 45]);
  });

  it('falls back to the middle 7 entries without a usable lineNo', () => {
    const window = sourceContextWindow(elevenLineContext(42), null);
    assert.deepStrictEqual(window.map(([n]) => n), [39, 40, 41, 42, 43, 44, 45]);
  });

  it('exception frames carry the source window instead of an empty context', () => {
    const entry = {
      type: 'exception',
      data: {
        values: [{
          type: 'TypeError',
          value: 'x is undefined',
          stacktrace: { frames: [{ filename: 'app.js', function: 'run', lineNo: 10, inApp: true, context: elevenLineContext(10) }] },
        }],
      },
    };
    const out = extractEssentialEventEntry(entry);
    const frame = out.data.values[0].stacktrace.frames[0];
    assert.strictEqual(frame.context.length, 7);
    assert.deepStrictEqual(frame.context[3], [10, 'line 10']);
    assert.strictEqual(frame.inApp, true);
  });

  it('honours maxFrames, keeping the innermost frames', () => {
    const frames = Array.from({ length: 8 }, (_, i) => ({ function: `fn${i}` }));
    const out = extractEssentialEventEntry(
      { type: 'exception', data: { values: [{ stacktrace: { frames } }] } },
      { maxFrames: 2 }
    );
    assert.deepStrictEqual(out.data.values[0].stacktrace.frames.map(f => f.function), ['fn6', 'fn7']);
  });
});

describe('extract: request entry', () => {
  const entry = {
    type: 'request',
    data: {
      method: 'POST',
      url: 'https://app.example.com/api/login?access_token=abc123&page=2',
      query: [['page', '2'], ['api_key', 'sekret']],
      headers: [
        ['Accept', 'application/json'],
        ['Authorization', 'Bearer sntrys-SECRET'],
        ['Content-Type', 'application/json'],
        ['Cookie', 'sessionid=SECRET-COOKIE'],
        ['User-Agent', 'curl/8'],
        ['X-Api-Key', 'SECRET-KEY'],
      ],
      cookies: [['sessionid', 'SECRET-COOKIE']],
      env: { REMOTE_ADDR: '10.0.0.1' },
      data: { blob: 'x'.repeat(5000) },
    },
  };

  it('keeps method, url, query and allowlisted headers', () => {
    const out = extractEssentialEventEntry(entry);
    assert.strictEqual(out.type, 'request');
    assert.strictEqual(out.data.method, 'POST');
    assert.match(out.data.url, /page=2/);
    assert.deepStrictEqual(out.data.headers, {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'curl/8',
    });
    assert.deepStrictEqual(out.data.query, [['page', '2'], ['api_key', '[Filtered]']]);
  });

  it('never leaks Cookie, Authorization, cookies, env or credential query values', () => {
    const text = JSON.stringify(extractEssentialEventEntry(entry));
    assert.ok(!/SECRET/.test(text), `leaked a secret: ${text}`);
    assert.ok(!/abc123/.test(text), 'leaked a URL access token');
    assert.ok(!/authorization|cookie/i.test(text), `leaked a credential header: ${text}`);
    assert.ok(!/REMOTE_ADDR/.test(text));
  });

  it('truncates the body to about 1000 characters', () => {
    const out = extractEssentialEventEntry(entry);
    assert.strictEqual(typeof out.data.data, 'string');
    assert.ok(out.data.data.length < 1100, `body is ${out.data.data.length} chars`);
  });
});

describe('extract: threads entry', () => {
  it('returns the crashed thread with compact frames limited to maxFrames', () => {
    const frames = Array.from({ length: 9 }, (_, i) => ({ function: `fn${i}`, lineNo: i + 1, inApp: i % 2 === 0, vars: { a: 1 } }));
    const entry = {
      type: 'threads',
      data: {
        values: [
          { id: 1, name: 'main', current: true, crashed: false, stacktrace: { frames: [{ function: 'idle' }] } },
          { id: 7, name: 'worker', current: false, crashed: true, stacktrace: { frames } },
        ],
      },
    };
    const out = extractEssentialEventEntry(entry, { maxFrames: 3 });
    assert.strictEqual(out.data.total_threads, 2);
    assert.strictEqual(out.data.thread.id, 7);
    assert.strictEqual(out.data.thread.name, 'worker');
    assert.strictEqual(out.data.thread.stacktrace.total_frames, 9);
    assert.deepStrictEqual(out.data.thread.stacktrace.frames.map(f => f.function), ['fn6', 'fn7', 'fn8']);
    assert.strictEqual(out.data.thread.stacktrace.frames[0].vars, '...');
    assert.ok(!('_truncated' in out));
  });
});

describe('extract: debugmeta entry', () => {
  it('reports image count and the first 20 images with basename only', () => {
    const images = Array.from({ length: 25 }, (_, i) => ({
      type: 'macho',
      code_file: `/private/var/containers/Bundle/Application/X/App.app/Frameworks/Lib${i}.framework/Lib${i}`,
      debug_id: `id-${i}`,
      arch: 'arm64',
      image_addr: '0x1000',
    }));
    const out = extractEssentialEventEntry({ type: 'debugmeta', data: { images } });
    assert.strictEqual(out.data.image_count, 25);
    assert.strictEqual(out.data.images.length, 20);
    assert.deepStrictEqual(out.data.images[0], { type: 'macho', code_file: 'Lib0', debug_id: 'id-0', arch: 'arm64' });
    assert.match(out.data._note, /20 of 25/);
  });

  it('handles Windows paths', () => {
    const out = extractEssentialEventEntry({
      type: 'debugmeta',
      data: { images: [{ type: 'pe', code_file: 'C:\\Program Files\\App\\app.dll', debug_id: 'd' }] },
    });
    assert.strictEqual(out.data.images[0].code_file, 'app.dll');
  });
});

describe('extract: contexts', () => {
  it('keeps scalar fields and summarizes nested ones', () => {
    const out = compactContexts({
      os: { name: 'iOS', version: '17.2', type: 'os' },
      trace: { trace_id: 't', span_id: 's', data: { a: 1, b: 2 } },
      app: { app_name: 'A', permissions: ['x', 'y'] },
    });
    assert.deepStrictEqual(out.os, { name: 'iOS', version: '17.2', type: 'os' });
    assert.strictEqual(out.trace.trace_id, 't');
    assert.strictEqual(out.trace.data, '[object(2 keys)]');
    assert.strictEqual(out.app.permissions, '[array(2)]');
  });
});

describe('extract: breadcrumbs', () => {
  const event = {
    entries: [{
      type: 'breadcrumbs',
      data: { values: Array.from({ length: 30 }, (_, i) => ({ type: i % 3 === 0 ? 'http' : 'default', message: `crumb ${i}` })) },
    }],
  };

  it('returns the most recent N, not the oldest, with the pre-limit total', () => {
    const trail = extractBreadcrumbTrail(event, 5);
    assert.strictEqual(trail.total, 30);
    assert.deepStrictEqual(trail.breadcrumbs.map(c => c.message), ['crumb 25', 'crumb 26', 'crumb 27', 'crumb 28', 'crumb 29']);
  });

  it('applies the type filter before limiting', () => {
    const trail = extractBreadcrumbTrail(event, 2, 'http');
    assert.strictEqual(trail.total, 10);
    assert.deepStrictEqual(trail.breadcrumbs.map(c => c.message), ['crumb 24', 'crumb 27']);
  });

  it('extractBreadcrumbs stays an array of the tail', () => {
    const crumbs = extractBreadcrumbs(event, 1);
    assert.strictEqual(crumbs.length, 1);
    assert.strictEqual(crumbs[0].message, 'crumb 29');
  });
});
