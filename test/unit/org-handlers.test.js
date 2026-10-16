/**
 * Organization tool handlers (teams, tags, activity) with HTTP mocked by nock.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import nock from 'nock';

process.env.SENTRY_URL = 'https://sentry.test.local';
process.env.SENTRY_AUTH_TOKEN = 'test-token';
process.env.SENTRY_ORG_SLUG = 'org';

const { handleListTeams, handleGetIssueTags, handleGetIssueTagValues, handleListActivity } =
  await import('../../build/tools/org.js');

const BASE = 'https://sentry.test.local';
const json = (result, block = 0) => JSON.parse(result.content[block].text);
const nextLink = (cursor) => `<${BASE}/x/?cursor=${cursor}>; rel="next"; results="true"; cursor="${cursor}"`;

describe('get_issue_tag_values', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  const VALUES_PATH = '/api/0/organizations/org/issues/123/tags/browser/values/';
  const DETAILS_PATH = '/api/0/organizations/org/issues/123/tags/browser/';

  it('uses totalValues from the tag key details as the denominator', async () => {
    nock(BASE)
      .get(VALUES_PATH)
      .query(q => q.sort === 'count' && q.per_page === '1')
      .reply(200, [{ value: 'Chrome', count: 30, lastSeen: '2026-01-01T00:00:00Z' }], { Link: nextLink('0:1:0') });
    nock(BASE).get(DETAILS_PATH).reply(200, { key: 'browser', name: 'Browser', totalValues: 120, uniqueValues: 4 });

    const out = json(await handleGetIssueTagValues({ issue_id: '123', tag_key: 'browser', limit: 1 }));

    assert.strictEqual(out.total_count, 120);
    assert.strictEqual(out.total_count_source, 'tag_key_details');
    assert.strictEqual(out.total_values, 4);
    assert.strictEqual(out.values[0].percentage, '25.0%', 'a single returned value must not show 100%');
    assert.match(out._note, /1 most frequent of 4/);
  });

  it('falls back to the page sum, and says so, when tag key details fail', async () => {
    nock(BASE).get(VALUES_PATH).query(true).reply(200, [{ value: 'Chrome', count: 3 }, { value: 'Firefox', count: 1 }]);
    nock(BASE).get(DETAILS_PATH).reply(500, { detail: 'boom' });

    const out = json(await handleGetIssueTagValues({ issue_id: '123', tag_key: 'browser' }));

    assert.strictEqual(out.total_count, 4);
    assert.strictEqual(out.total_count_source, 'returned_values');
    assert.strictEqual(out.values[0].percentage, '75.0%');
    assert.match(out._note, /relative to the returned values/);
  });
});

describe('list_activity', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  it('unwraps {activity: [...]}, compacts users, and drops emails', async () => {
    nock(BASE)
      .get('/api/0/organizations/org/issues/123/activities/')
      .query(true)
      .reply(200, {
        activity: [
          {
            id: '3',
            type: 'note',
            dateCreated: '2026-01-03T00:00:00Z',
            data: { text: 'looking into it', mentions: [] },
            user: { id: '1', name: 'Ada', email: 'ada@example.com', avatar: { avatarType: 'gravatar' } },
          },
          {
            id: '2',
            type: 'assigned',
            dateCreated: '2026-01-02T00:00:00Z',
            data: { assignee: '1', assigneeEmail: 'ada@example.com', assigneeType: 'user' },
            user: null,
            sentry_app: { name: 'Bot' },
          },
          { id: '1', type: 'first_seen', dateCreated: '2026-01-01T00:00:00Z', data: {}, user: null },
        ],
      });

    const out = json(await handleListActivity({ issue_id: '123', limit: 2 }));

    assert.strictEqual(out.total_activities, 3);
    assert.strictEqual(out.returned_activities, 2);
    assert.deepStrictEqual(out.activities[0], {
      id: '3',
      type: 'note',
      dateCreated: '2026-01-03T00:00:00Z',
      user: 'Ada',
      data: { text: 'looking into it' },
    });
    assert.strictEqual(out.activities[1].user, 'Bot');
    assert.deepStrictEqual(out.activities[1].data, { assignee: '1', assigneeType: 'user' });
    assert.ok(!JSON.stringify(out).includes('@example.com'), 'emails must not be returned');
  });
});

describe('list_teams', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  it('returns compact teams with project slugs and notes further pages', async () => {
    nock(BASE)
      .get('/api/0/organizations/org/teams/')
      .reply(200, [
        {
          id: '1', slug: 'core', name: 'Core', memberCount: 3, isMember: true, avatar: { avatarType: 'letter_avatar' },
          projects: [{ id: '10', slug: 'web', name: 'Web', platform: 'javascript' }],
          externalTeams: [],
        },
      ], { Link: nextLink('0:100:0') });

    const result = await handleListTeams();
    const out = json(result);

    assert.deepStrictEqual(out.teams, [{ id: '1', slug: 'core', name: 'Core', memberCount: 3, projects: ['web'] }]);
    assert.match(out._note, /0:100:0/);
  });
});

describe('get_issue_tags', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  it('compacts top values and goes through the truncating result', async () => {
    nock(BASE)
      .get('/api/0/organizations/org/issues/123/tags/')
      .reply(200, [{
        key: 'browser', name: 'Browser', totalValues: 10, uniqueValues: 2,
        topValues: [{ key: 'browser', name: 'Chrome', value: 'Chrome', count: 7, firstSeen: 'a', lastSeen: 'b' }],
      }]);

    const out = json(await handleGetIssueTags({ issue_id: '123' }));

    assert.deepStrictEqual(out.tags[0].topValues, [{ value: 'Chrome', count: 7 }]);
    assert.strictEqual(out.tags[0].totalValues, 10);
  });
});
