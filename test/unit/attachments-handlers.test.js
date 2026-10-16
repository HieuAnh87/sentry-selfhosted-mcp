/**
 * Handlers for list_event_attachments, get_event_attachment, list_user_feedback and whoami.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import nock from 'nock';

process.env.SENTRY_URL = process.env.SENTRY_URL || 'https://sentry.test.local';
process.env.SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN || 'token';
process.env.SENTRY_ORG_SLUG = process.env.SENTRY_ORG_SLUG || 'org';

const { handleListEventAttachments, handleGetEventAttachment, handleListUserFeedback } =
  await import('../../build/tools/attachments.js');
const { handleWhoami } = await import('../../build/tools/account.js');

const BASE = 'https://sentry.test.local';
const ATTACHMENT = '/api/0/projects/org/web/events/abc/attachments/12/';
const json = (result, block = 0) => JSON.parse(result.content[block].text);
const meta = (over = {}) => ({
  id: '12', event_id: 'abc', type: 'event.attachment', name: 'app.log',
  mimetype: 'text/plain', size: 40, dateCreated: 'd', headers: { 'Content-Type': 'text/plain' }, ...over,
});

describe('list_event_attachments', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  it('lists an issue\'s attachments compactly with a next cursor', async () => {
    nock(BASE)
      .get('/api/0/organizations/org/issues/WEB-1/attachments/')
      .query({ per_page: 25, limit: 25 })
      .reply(200, [meta()], { Link: '<x>; rel="next"; results="true"; cursor="0:25:0"' });

    const result = await handleListEventAttachments({ issue_id: 'WEB-1' });
    const out = json(result);

    assert.deepStrictEqual(out.attachments[0], { id: '12', event_id: 'abc', name: 'app.log', type: 'event.attachment', mimetype: 'text/plain', size: 40, dateCreated: 'd' });
    assert.strictEqual(json(result, 1).next_cursor, '0:25:0');
  });

  it('lists one event\'s attachments', async () => {
    const scope = nock(BASE).get('/api/0/projects/org/web/events/abc/attachments/').query(true).reply(200, []);

    const out = json(await handleListEventAttachments({ project_slug: 'web', event_id: 'abc' }));

    assert.ok(scope.isDone());
    assert.strictEqual(out.returned_attachments, 0);
    assert.ok(out._note);
  });

  it('refuses an ambiguous selection', async () => {
    await assert.rejects(handleListEventAttachments({ issue_id: '1', project_slug: 'web', event_id: 'abc' }), /either issue_id/);
  });
});

describe('get_event_attachment', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  it('returns a text attachment\'s contents', async () => {
    nock(BASE).get(ATTACHMENT).reply(200, meta());
    nock(BASE).get(ATTACHMENT).query({ download: '1' }).reply(200, 'line one\nline two ERROR boom\n', { 'Content-Type': 'text/plain' });

    const out = json(await handleGetEventAttachment({ project_slug: 'web', event_id: 'abc', attachment_id: '12' }));

    assert.strictEqual(out.content, 'line one\nline two ERROR boom\n');
    assert.strictEqual(out.truncated, false);
  });

  it('keeps the tail of a long log and says so', async () => {
    const log = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    nock(BASE).get(ATTACHMENT).reply(200, meta({ size: log.length }));
    nock(BASE).get(ATTACHMENT).query({ download: '1' }).reply(200, log);

    const out = json(await handleGetEventAttachment({ project_slug: 'web', event_id: 'abc', attachment_id: '12', max_chars: 20 }));

    assert.strictEqual(out.truncated, true);
    assert.strictEqual(out.content.length, 20);
    assert.ok(out.content.endsWith('line 199'));
  });

  it('greps the whole file when grep_pattern is set', async () => {
    nock(BASE).get(ATTACHMENT).reply(200, meta());
    nock(BASE).get(ATTACHMENT).query({ download: '1' }).reply(200, 'ok\nfine\nERROR boom\nok\n');

    const out = json(await handleGetEventAttachment({ project_slug: 'web', event_id: 'abc', attachment_id: '12', grep_pattern: 'error' }));

    assert.strictEqual(out.grep.total_matches, 1);
    assert.ok(out.grep.grep_results.some(line => line.includes('ERROR boom')));
  });

  it('does not download a minidump', async () => {
    const download = nock(BASE).get(ATTACHMENT).query({ download: '1' }).reply(200, 'MDMP');
    nock(BASE).get(ATTACHMENT).reply(200, meta({ type: 'event.minidump', mimetype: 'application/x-minidump' }));

    const out = json(await handleGetEventAttachment({ project_slug: 'web', event_id: 'abc', attachment_id: '12' }));

    assert.strictEqual(out.content, null);
    assert.match(out._note, /binary/);
    assert.strictEqual(download.isDone(), false);
  });

  it('refuses binary bytes behind a text-looking type', async () => {
    nock(BASE).get(ATTACHMENT).reply(200, meta());
    nock(BASE).get(ATTACHMENT).query({ download: '1' }).reply(200, Buffer.from([0, 0, 0, 1, 2, 0, 0, 0]));

    const out = json(await handleGetEventAttachment({ project_slug: 'web', event_id: 'abc', attachment_id: '12' }));

    assert.strictEqual(out.content, null);
  });

  it('reports a redirect to external storage instead of following it with the token', async () => {
    const elsewhere = nock('https://storage.example.com').get(() => true).reply(200, 'secret');
    nock(BASE).get(ATTACHMENT).reply(200, meta());
    nock(BASE).get(ATTACHMENT).query({ download: '1' }).reply(302, '', { Location: 'https://storage.example.com/blob' });

    const out = json(await handleGetEventAttachment({ project_slug: 'web', event_id: 'abc', attachment_id: '12' }));

    assert.match(out._note, /external storage/);
    assert.strictEqual(elsewhere.isDone(), false);
  });

  it('refuses attachments above the download limit without downloading', async () => {
    const download = nock(BASE).get(ATTACHMENT).query({ download: '1' }).reply(200, 'x');
    nock(BASE).get(ATTACHMENT).reply(200, meta({ size: 50 * 1024 * 1024 }));

    const out = json(await handleGetEventAttachment({ project_slug: 'web', event_id: 'abc', attachment_id: '12' }));

    assert.match(out._note, /download limit/);
    assert.strictEqual(download.isDone(), false);
  });
});

describe('list_user_feedback', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  it('omits reporter emails and keeps comments and the issue', async () => {
    nock(BASE)
      .get('/api/0/projects/org/web/user-reports/')
      .query(true)
      .reply(200, [{
        id: '1', eventID: 'abc', name: 'Jane', email: 'jane@example.com', comments: 'It crashed when I clicked save',
        dateCreated: 'd', user: { email: 'jane@example.com' }, issue: { id: '7', shortId: 'WEB-7', title: 'boom', stats: {} },
      }]);

    const result = await handleListUserFeedback({ project_slug: 'web' });
    const out = json(result);

    assert.ok(!result.content[0].text.includes('jane@example.com'), 'emails must not be returned');
    assert.deepStrictEqual(out.feedback[0], {
      id: '1', event_id: 'abc', name: 'Jane', comments: 'It crashed when I clicked save', dateCreated: 'd',
      issue: { id: '7', shortId: 'WEB-7', title: 'boom' },
    });
  });

  it('points at issue-based feedback when there are no user reports', async () => {
    nock(BASE).get('/api/0/organizations/org/issues/7/user-reports/').query(true).reply(200, []);

    const out = json(await handleListUserFeedback({ issue_id: '7' }));

    assert.match(out._note, /issue\.category:feedback/);
  });
});

describe('whoami', () => {
  beforeEach(() => nock.cleanAll());
  afterEach(() => nock.cleanAll());

  it('reports scopes, the reachable org and tools the scopes rule out', async () => {
    nock(BASE).get('/api/0/').reply(200, {
      version: '0',
      auth: { scopes: ['event:read', 'org:read', 'project:read', 'team:read'] },
      user: { id: '3', name: 'Dev', username: 'dev', email: 'dev@example.com', avatar: {} },
    });
    nock(BASE).get('/api/0/organizations/org/').reply(200, { slug: 'org', name: 'Org', features: ['a'] });

    const out = json(await handleWhoami({}));

    assert.deepStrictEqual(out.user, { id: '3', name: 'Dev', username: 'dev' });
    assert.deepStrictEqual(out.organization, { slug: 'org', name: 'Org', reachable: true });
    const missing = Object.fromEntries(out.tools_unavailable_with_these_scopes.map(t => [t.tool, t.missing_scope]));
    assert.strictEqual(missing.merge_issues, 'event:write');
    assert.strictEqual(missing.list_releases, 'project:releases');
    assert.strictEqual(missing.get_sentry_issue, undefined, 'event:read tools are available');
  });

  it('treats write and admin scopes as granting read', async () => {
    nock(BASE).get('/api/0/').reply(200, { auth: { scopes: ['event:admin', 'org:write', 'project:releases'] }, user: null });
    nock(BASE).get('/api/0/organizations/org/').reply(200, { slug: 'org' });

    const out = json(await handleWhoami({}));

    assert.deepStrictEqual(out.tools_unavailable_with_these_scopes, []);
  });

  it('reports an unreachable organization without failing', async () => {
    nock(BASE).get('/api/0/').reply(200, { auth: { scopes: ['event:read'] }, user: { id: '1' } });
    nock(BASE).get('/api/0/organizations/org/').reply(404, { detail: 'The requested resource does not exist' });

    const out = json(await handleWhoami({}));

    assert.strictEqual(out.organization.reachable, false);
    assert.strictEqual(out.organization.slug, 'org');
  });
});
