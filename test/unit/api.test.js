import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import nock from 'nock';

process.env.SENTRY_URL = process.env.SENTRY_URL || 'https://sentry.test.local';
process.env.SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN || 'token';
process.env.SENTRY_ORG_SLUG = process.env.SENTRY_ORG_SLUG || 'org';

const { sentryClient } = await import('../../build/api/client.js');

const BASE = 'https://sentry.test.local';

describe('api/client', () => {
  beforeEach(() => {
    nock.cleanAll();
  });

  afterEach(() => {
    assert.equal(nock.isDone(), true, `Pending mocks: ${nock.pendingMocks().join(', ')}`);
  });

  it('getIssue calls the organization-scoped issue endpoint', async () => {
    nock(BASE)
      .get('/api/0/organizations/org/issues/123/')
      .reply(200, { id: '123', title: 'Issue 123' });

    const issue = await sentryClient.getIssue('123');
    assert.equal(issue.id, '123');
  });

  it('listProjectIssues sends params correctly', async () => {
    nock(BASE)
      .get('/api/0/projects/org/mobile/issues/')
      .query({ limit: 10, query: 'is:unresolved' })
      .reply(200, [{ id: '1' }]);

    const { data: issues } = await sentryClient.listProjectIssues('org', 'mobile', {
      limit: 10,
      query: 'is:unresolved',
    });
    assert.equal(Array.isArray(issues), true);
    assert.equal(issues.length, 1);
  });

  it('getRelease URL-encodes version', async () => {
    const version = 'release/1.2.3+build';
    const encoded = encodeURIComponent(version);

    nock(BASE)
      .get(`/api/0/organizations/org/releases/${encoded}/`)
      .reply(200, { version });

    const release = await sentryClient.getRelease('org', version);
    assert.equal(release.version, version);
  });

  it('getIssueTagValues URL-encodes tag key', async () => {
    const tagKey = 'user.email';
    const encoded = encodeURIComponent(tagKey);

    nock(BASE)
      .get(`/api/0/organizations/org/issues/999/tags/${encoded}/values/`)
      .query({ limit: 5 })
      .reply(200, [{ value: 'a@x.com', count: 2 }]);

    const { data: values } = await sentryClient.getIssueTagValues('999', tagKey, { limit: 5 });
    assert.equal(values[0].value, 'a@x.com');
  });

});
