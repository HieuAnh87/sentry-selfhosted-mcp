// Data extraction utilities for compact, debugging-focused payloads

/**
 * Extract only essential fields from Sentry issue data.
 * Reduces response size while keeping important information.
 */
export function extractEssentialIssueFields(issueData: unknown): Record<string, unknown> {
  if (!issueData || typeof issueData !== 'object') return {};

  const data = issueData as Record<string, unknown>;
  const essential: Record<string, unknown> = {
    id: data.id,
    shortId: data.shortId,
    title: data.title,
    culprit: data.culprit,
    permalink: data.permalink,
    logger: data.logger,
    level: data.level,
    status: data.status,
    type: data.type,
    platform: data.platform,
    project: data.project,
    count: data.count,
    userCount: data.userCount,
    firstSeen: data.firstSeen,
    lastSeen: data.lastSeen,
    metadata: data.metadata,
  };

  // Add truncation note if large fields exist
  if (data.annotations || data.context || data.tags) {
    essential._note = 'Full issue details truncated. Use get_sentry_event_details for stack traces and event data.';
  }

  return essential;
}

/**
 * Extract essential fields from event entries (exception, message, breadcrumbs).
 * Reduces size while keeping debugging-relevant information.
 */
export function extractEssentialEventEntry(entry: unknown): unknown {
  if (!entry || typeof entry !== 'object') return { _truncated: true };

  const e = entry as Record<string, unknown>;

  if (e.type === 'exception') {
    const data = e.data as Record<string, unknown> | undefined;
    if (data?.values) {
      return {
        type: e.type,
        data: {
          values: (data.values as unknown[]).map((exc: unknown) => {
            const excData = exc as Record<string, unknown>;
            const stacktrace = excData.stacktrace as Record<string, unknown> | undefined;
            const frames = stacktrace?.frames as unknown[] | undefined;
            return {
              type: excData.type,
              value: excData.value,
              mechanism: excData.mechanism,
              stacktrace: frames ? {
                frames: frames.slice(-5).map((frame: unknown) => {
                  const f = frame as Record<string, unknown>;
                  const context = f.context as unknown[] | undefined;
                  return {
                    filename: f.filename,
                    function: f.function,
                    lineNo: f.lineNo,
                    colNo: f.colNo,
                    absPath: f.absPath,
                    context: context?.slice(-3, 4),
                    vars: typeof f.vars === 'object' && Object.keys(f.vars || {}).length > 0 ? '...' : undefined,
                  };
                }),
              } : undefined,
            };
          }),
        },
      };
    }
  }

  if (e.type === 'message') {
    return entry;
  }

  if (e.type === 'breadcrumbs') {
    const data = e.data as Record<string, unknown> | undefined;
    if (data?.values) {
      const values = data.values as unknown[];
      return {
        type: e.type,
        data: { values: values.slice(-10) },
      };
    }
  }

  return { type: e.type, _truncated: true };
}

/**
 * Extract breadcrumb entries from event data.
 */
export function extractBreadcrumbs(eventData: unknown, limit: number = 50, typeFilter?: string): unknown[] {
  if (!eventData || typeof eventData !== 'object') return [];

  const data = eventData as Record<string, unknown>;
  const breadcrumbs: unknown[] = [];

  if (data.entries && Array.isArray(data.entries)) {
    for (const entry of data.entries) {
      const e = entry as Record<string, unknown>;
      if (e.type === 'breadcrumbs') {
        const entryData = e.data as Record<string, unknown> | undefined;
        if (entryData?.values) {
          const values = entryData.values as unknown[];
          for (const crumb of values) {
            const c = crumb as Record<string, unknown>;
            if (typeFilter && c.type !== typeFilter) continue;
            breadcrumbs.push({
              type: c.type || 'default',
              category: c.category,
              message: c.message,
              timestamp: c.timestamp,
              level: c.level,
              data: c.data,
            });
            if (breadcrumbs.length >= limit) break;
          }
        }
      }
      if (breadcrumbs.length >= limit) break;
    }
  }

  return breadcrumbs;
}
