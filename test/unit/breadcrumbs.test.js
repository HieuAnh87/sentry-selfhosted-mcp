import { describe, it } from 'node:test';
import assert from 'node:assert';

process.env.SENTRY_URL = process.env.SENTRY_URL || 'https://sentry.test.local';
process.env.SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN || 'token';
process.env.SENTRY_ORG_SLUG = process.env.SENTRY_ORG_SLUG || 'org';

const { compactBreadcrumb, extractBreadcrumbTrail, extractEssentialEventEntry } = await import('../../build/helpers/extract.js');

// Shape of a structlog breadcrumb from a live self-hosted Sentry (python SDK)
const STRUCTLOG_CRUMB = {
  type: 'log',
  timestamp: '2026-10-13T00:08:30Z',
  level: 'warning',
  category: 'aio_pika.robust_connection',
  message: 'Connection attempt failed: [Errno 111] Connection refused. Reconnecting after 5 seconds.',
  data: {
    _from_structlog: false,
    _record: '<LogRecord: aio_pika.robust_connection, 30, \u001b[2m2026-10-13 00:08:30\u001b[0m [\u001b[33mwarning\u001b[0m] ' + 'x'.repeat(800),
    attempt: 3,
    url: 'amqp://guest:******@rabbitmq:5672//',
  },
};

describe('helpers/extract — breadcrumb compaction', () => {
  it('drops underscore-prefixed logging internals and keeps useful data', () => {
    const crumb = compactBreadcrumb(STRUCTLOG_CRUMB);

    assert.strictEqual(crumb.data._record, undefined);
    assert.strictEqual(crumb.data._from_structlog, undefined);
    assert.strictEqual(crumb.data.attempt, 3);
    assert.strictEqual(crumb.data.url, 'amqp://guest:******@rabbitmq:5672//');
    assert.ok(JSON.stringify(crumb).length < 400, `compact crumb is ${JSON.stringify(crumb).length} chars`);
  });

  it('strips ANSI colour codes and clips long messages', () => {
    const crumb = compactBreadcrumb({ message: '\u001b[31mred\u001b[0m ' + 'y'.repeat(2000) });

    assert.ok(!crumb.message.includes('\u001b'));
    assert.ok(crumb.message.startsWith('red '));
    assert.match(crumb.message, /more chars\]$/);
    assert.ok(crumb.message.length < 600);
  });

  it('clips long data values and omits empty data', () => {
    const crumb = compactBreadcrumb({ data: { body: 'z'.repeat(1000), nested: { a: 'b'.repeat(500) } } });
    assert.ok(crumb.data.body.length < 250);
    assert.ok(crumb.data.nested.length < 250, 'oversized nested values are serialized and clipped');

    assert.strictEqual(compactBreadcrumb({ data: { _only: 'internal' } }).data, undefined);
  });

  it('applies to both list_breadcrumbs trails and event entries', () => {
    const event = { entries: [{ type: 'breadcrumbs', data: { values: [STRUCTLOG_CRUMB, STRUCTLOG_CRUMB] } }] };

    const trail = extractBreadcrumbTrail(event, 10);
    assert.strictEqual(trail.total, 2);
    assert.strictEqual(trail.breadcrumbs[0].data._record, undefined);

    const entry = extractEssentialEventEntry(event.entries[0]);
    assert.strictEqual(entry.data.values[0].data._record, undefined);
  });
});
