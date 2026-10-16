// Sentry cursor pagination — parsing of the `Link` response header

export interface PageInfo {
  /** Cursor for the next page; present only when Sentry reports more results. */
  nextCursor?: string;
  hasMore: boolean;
}

// One link entry: <url>; rel="next"; results="true"; cursor="0:100:0"
const LINK_ENTRY_PATTERN = /<[^>]*>((?:\s*;\s*[a-z]+="[^"]*")*)/gi;
const LINK_ATTRIBUTE_PATTERN = /([a-z]+)="([^"]*)"/gi;

/**
 * Read the `rel="next"` entry of Sentry's `Link` header.
 * Only the `cursor` attribute is used: the URL is built from Sentry's configured
 * system URL, which is often wrong behind a proxy, and is never followed.
 */
export function parseLinkHeader(link: string | undefined): PageInfo {
  if (!link) return { hasMore: false };

  for (const [, attributeText] of link.matchAll(LINK_ENTRY_PATTERN)) {
    const attributes: Record<string, string> = {};
    for (const [, key, value] of attributeText.matchAll(LINK_ATTRIBUTE_PATTERN)) {
      attributes[key.toLowerCase()] = value;
    }

    if (attributes.rel !== 'next') continue;
    if (attributes.results !== 'true' || !attributes.cursor) return { hasMore: false };
    return { nextCursor: attributes.cursor, hasMore: true };
  }

  return { hasMore: false };
}
