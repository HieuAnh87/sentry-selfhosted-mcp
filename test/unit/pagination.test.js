import { describe, it } from 'node:test';
import assert from 'node:assert';

const { parseLinkHeader } = await import('../../build/helpers/pagination.js');

describe('helpers/pagination — parseLinkHeader', () => {
  it('returns no next page for a missing header', () => {
    assert.deepStrictEqual(parseLinkHeader(undefined), { hasMore: false });
    assert.deepStrictEqual(parseLinkHeader(''), { hasMore: false });
  });

  it('reads the cursor attribute of the next link', () => {
    const link =
      '<https://s/api/0/x/?&cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", ' +
      '<https://s/api/0/x/?&cursor=1700000000000:0:0>; rel="next"; results="true"; cursor="1700000000000:0:0"';
    assert.deepStrictEqual(parseLinkHeader(link), { nextCursor: '1700000000000:0:0', hasMore: true });
  });

  it('treats results="false" on the next link as the last page', () => {
    const link = '<https://s/x>; rel="next"; results="false"; cursor="0:50:0"';
    assert.deepStrictEqual(parseLinkHeader(link), { hasMore: false });
  });

  it('ignores the URL so a wrong system URL behind a proxy cannot leak in', () => {
    const link = '<http://internal-host:9000/api/0/x/?cursor=evil>; rel="next"; results="true"; cursor="0:25:0"';
    assert.strictEqual(parseLinkHeader(link).nextCursor, '0:25:0');
  });

  it('returns no next page when only a previous link exists', () => {
    const link = '<https://s/x>; rel="previous"; results="true"; cursor="0:0:1"';
    assert.deepStrictEqual(parseLinkHeader(link), { hasMore: false });
  });
});
