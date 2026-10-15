/**
 * Release tool handlers with HTTP mocked by nock.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import nock from 'nock';

process.env.SENTRY_URL = 'https://sentry.test.local';
process.env.SENTRY_AUTH_TOKEN = 'test-token';
process.env.SENTRY_ORG_SLUG = 'org';

const { handleListReleases } = await import('../../build/tools/releases.js');

const BASE = 'https://sentry.test.local';
const json = (result, block = 0) => JSON.parse(result.content[block].text);

describe('list_releases', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  it('projects releases to a compact shape and appends the pagination block', async () => {
    nock(BASE)
      .get('/api/0/organizations/org/releases/')
      .query(q => q.per_page === '1' && q.cursor === 'c1')
      .reply(200, [{
        version: 'web@1.2.3+abc',
        shortVersion: '1.2.3',
        dateCreated: '2026-01-01T00:00:00Z',
        dateReleased: null,
        newGroups: 2,
        firstEvent: '2026-01-01T01:00:00Z',
        lastEvent: '2026-01-02T00:00:00Z',
        projects: [{ id: 1, slug: 'web', name: 'Web', healthData: { big: true } }],
        authors: [{ email: 'dev@example.com' }],
        lastCommit: { message: 'x'.repeat(500) },
        versionInfo: { package: 'web' },
      }], { Link: `<${BASE}/x/?cursor=c2>; rel="next"; results="true"; cursor="c2"` });

    const result = await handleListReleases({ limit: 1, cursor: 'c1' });
    const out = json(result);

    assert.deepStrictEqual(out.releases, [{
      version: 'web@1.2.3+abc',
      shortVersion: '1.2.3',
      dateCreated: '2026-01-01T00:00:00Z',
      dateReleased: null,
      newGroups: 2,
      projects: ['web'],
      firstEvent: '2026-01-01T01:00:00Z',
      lastEvent: '2026-01-02T00:00:00Z',
    }]);
    assert.match(out._note, /get_release_details/);
    assert.strictEqual(json(result, 1).next_cursor, 'c2');
    assert.strictEqual(json(result, 1).has_more, true);
  });
});
