// Data extraction utilities for compact, debugging-focused payloads
//
// Field names follow Sentry's event API serialization (camelCase: `inApp`,
// `lineNo`, `absPath`, ...), see `get_api_context` in src/sentry/interfaces/*.py.

type Rec = Record<string, unknown>;

const isRecord = (value: unknown): value is Rec =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Last `n` items; `n <= 0` keeps nothing (`slice(-0)` would keep everything). */
const tail = <T>(items: T[], n: number): T[] => (n > 0 ? items.slice(-n) : []);

function truncateString(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...[truncated ${value.length - max} chars]` : value;
}

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

// ============================================================
// Stack frames
// ============================================================

/** Sentry's API serializes `inApp`; raw event JSON (and older payloads) use `in_app`. */
export function isInAppFrame(frame: unknown): boolean {
  if (!isRecord(frame)) return false;
  return (frame.inApp ?? frame.in_app) === true;
}

/**
 * Source lines around the frame's line. Sentry sends `context` as `[lineNo, line]`
 * pairs (usually 5 before, the line itself, 5 after). Keeps pairs within ±radius
 * of `lineNo`; without a usable line number, keeps the middle `2*radius+1` entries.
 */
export function sourceContextWindow(context: unknown, lineNo: unknown, radius = 3): unknown[] | undefined {
  if (!Array.isArray(context) || context.length === 0) return undefined;

  if (typeof lineNo === 'number') {
    const near = context.filter(
      entry => Array.isArray(entry) && typeof entry[0] === 'number' && Math.abs(entry[0] - lineNo) <= radius
    );
    if (near.length > 0) return near;
  }

  const size = radius * 2 + 1;
  const start = Math.max(0, Math.floor((context.length - size) / 2));
  return context.slice(start, start + size);
}

/** Compact frame shape shared by exception and thread stack traces. */
export function compactFrame(frame: unknown): Record<string, unknown> {
  const f = isRecord(frame) ? frame : {};
  const lineNo = f.lineNo ?? f.lineno;
  return {
    filename: f.filename,
    function: f.function ?? f.rawFunction,
    lineNo,
    colNo: f.colNo ?? f.colno,
    absPath: f.absPath ?? f.abs_path,
    inApp: f.inApp ?? f.in_app,
    // Native frames without symbols only have an address to go on
    instructionAddr: f.function || f.rawFunction ? undefined : f.instructionAddr ?? f.instruction_addr,
    context: sourceContextWindow(f.context, lineNo),
    vars: isRecord(f.vars) && Object.keys(f.vars).length > 0 ? '...' : undefined,
  };
}

function stackFrames(stacktrace: unknown): unknown[] | undefined {
  if (!isRecord(stacktrace) || !Array.isArray(stacktrace.frames)) return undefined;
  return stacktrace.frames;
}

/**
 * The thread most relevant to a crash: the crashed one, else the current one,
 * else the first thread that carries a stack trace.
 */
export function selectRelevantThread(threads: unknown): Rec | undefined {
  if (!Array.isArray(threads)) return undefined;
  const candidates = threads.filter(isRecord);
  return (
    candidates.find(t => t.crashed === true) ??
    candidates.find(t => t.current === true) ??
    candidates.find(t => (stackFrames(t.stacktrace)?.length ?? 0) > 0) ??
    candidates[0]
  );
}

// ============================================================
// Event entries
// ============================================================

/**
 * Extract essential fields from event entries (exception, message, breadcrumbs).
 * Reduces size while keeping debugging-relevant information.
 */
export interface ExtractEntryOptions {
  /** Innermost frames kept per exception/thread (default 5). */
  maxFrames?: number;
}

const REQUEST_HEADER_ALLOWLIST = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'content-length',
  'content-type',
  'host',
  'origin',
  'referer',
  'user-agent',
  'x-forwarded-proto',
  'x-request-id',
]);
const REQUEST_DATA_MAX_CHARS = 1000;
const REQUEST_VALUE_MAX_CHARS = 300;
const SENSITIVE_PARAM = /token|secret|passw|auth|session|cookie|api[_-]?key|^key$|signature|sig$|code$/i;
const DEBUG_IMAGES_SHOWN = 20;

/** Mask values of sensitive-looking query parameters inside a URL or query string. */
function redactQueryString(value: string): string {
  return value.replace(/([?&;]|^)([^=&;#?]+)=([^&;#]*)/g, (match, sep: string, key: string) =>
    SENSITIVE_PARAM.test(key) ? `${sep}${key}=[Filtered]` : match
  );
}

function compactQuery(query: unknown): unknown {
  if (typeof query === 'string') return truncateString(redactQueryString(query), REQUEST_VALUE_MAX_CHARS);
  if (!Array.isArray(query)) return undefined;
  return query.slice(0, 20).map(pair => {
    if (!Array.isArray(pair)) return pair;
    const [key, value] = pair;
    if (typeof key === 'string' && SENSITIVE_PARAM.test(key)) return [key, '[Filtered]'];
    return [key, typeof value === 'string' ? truncateString(value, REQUEST_VALUE_MAX_CHARS) : value];
  });
}

/** Allowlisted headers only. Sentry sends `[name, value]` pairs; plain objects are accepted too. */
function compactHeaders(headers: unknown): Record<string, unknown> | undefined {
  const pairs: unknown[][] = Array.isArray(headers)
    ? headers.filter(Array.isArray)
    : isRecord(headers)
      ? Object.entries(headers)
      : [];

  const out: Record<string, unknown> = {};
  for (const [name, value] of pairs) {
    if (typeof name !== 'string' || !REQUEST_HEADER_ALLOWLIST.has(name.toLowerCase())) continue;
    out[name] = typeof value === 'string' ? truncateString(redactQueryString(value), REQUEST_VALUE_MAX_CHARS) : value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function compactRequestBody(body: unknown): unknown {
  if (body === undefined || body === null) return undefined;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  if (text === undefined) return undefined;
  if (text.length <= REQUEST_DATA_MAX_CHARS) return body;
  return truncateString(text, REQUEST_DATA_MAX_CHARS);
}

/**
 * The HTTP request without cookies, environment, or credential headers:
 * only allowlisted headers survive, and sensitive query values are masked.
 */
function extractRequestEntry(data: Rec): Record<string, unknown> {
  return {
    method: data.method,
    url: typeof data.url === 'string' ? redactQueryString(data.url) : data.url,
    query: compactQuery(data.query),
    fragment: data.fragment || undefined,
    inferredContentType: data.inferredContentType,
    headers: compactHeaders(data.headers),
    data: compactRequestBody(data.data),
  };
}

function extractThreadsEntry(data: Rec, maxFrames: number): Record<string, unknown> {
  const values = Array.isArray(data.values) ? data.values : [];
  const thread = selectRelevantThread(values);
  const frames = thread ? stackFrames(thread.stacktrace) : undefined;

  return {
    total_threads: values.length,
    thread: thread
      ? {
          id: thread.id,
          name: thread.name,
          crashed: thread.crashed,
          current: thread.current,
          state: thread.state,
          stacktrace: frames
            ? { total_frames: frames.length, frames: tail(frames, maxFrames).map(compactFrame) }
            : undefined,
        }
      : undefined,
    _note: values.length > 1 ? 'Only the crashed (or current) thread is shown.' : undefined,
  };
}

function basename(path: unknown): unknown {
  if (typeof path !== 'string') return path;
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function extractDebugMetaEntry(data: Rec): Record<string, unknown> {
  const images = Array.isArray(data.images) ? data.images : [];
  return {
    image_count: images.length,
    images: images.slice(0, DEBUG_IMAGES_SHOWN).map(image => {
      const img = isRecord(image) ? image : {};
      return {
        type: img.type,
        code_file: basename(img.code_file ?? img.name),
        debug_id: img.debug_id ?? img.uuid,
        arch: img.arch,
      };
    }),
    _note: images.length > DEBUG_IMAGES_SHOWN
      ? `Showing ${DEBUG_IMAGES_SHOWN} of ${images.length} images. Use check_dsym_status for missing symbols.`
      : undefined,
  };
}

export function extractEssentialEventEntry(entry: unknown, options: ExtractEntryOptions = {}): unknown {
  const maxFrames = options.maxFrames ?? 5;
  if (!entry || typeof entry !== 'object') return { _truncated: true };

  const e = entry as Record<string, unknown>;
  const data = isRecord(e.data) ? e.data : undefined;

  if (e.type === 'exception') {
    if (data?.values) {
      return {
        type: e.type,
        data: {
          values: (data.values as unknown[]).map((exc: unknown) => {
            const excData = isRecord(exc) ? exc : {};
            const frames = stackFrames(excData.stacktrace);
            return {
              type: excData.type,
              value: excData.value,
              mechanism: excData.mechanism,
              threadId: excData.threadId,
              stacktrace: frames ? { frames: tail(frames, maxFrames).map(compactFrame) } : undefined,
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
    if (data?.values) {
      const values = data.values as unknown[];
      return {
        type: e.type,
        data: { values: values.slice(-10) },
      };
    }
  }

  if (e.type === 'request' && data) {
    return { type: e.type, data: extractRequestEntry(data) };
  }

  if (e.type === 'threads' && data) {
    return { type: e.type, data: extractThreadsEntry(data, maxFrames) };
  }

  if (e.type === 'debugmeta' && data) {
    return { type: e.type, data: extractDebugMetaEntry(data) };
  }

  return { type: e.type, _truncated: true };
}

// ============================================================
// Contexts
// ============================================================

/**
 * Compact view of an event's top-level `contexts` (os, browser, runtime, device,
 * trace, ...). Contexts are not an entry. Keeps scalar fields per context,
 * shortens long strings, and summarizes nested values instead of inlining them.
 */
export function compactContexts(contexts: unknown, maxStringLength = 200): Record<string, unknown> {
  if (!isRecord(contexts)) return {};

  const out: Record<string, unknown> = {};
  for (const [name, context] of Object.entries(contexts)) {
    if (!isRecord(context)) {
      out[name] = typeof context === 'string' ? truncateString(context, maxStringLength) : context;
      continue;
    }
    const compact: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(context)) {
      if (value === null || value === undefined) continue;
      if (typeof value === 'string') compact[key] = truncateString(value, maxStringLength);
      else if (Array.isArray(value)) compact[key] = `[array(${value.length})]`;
      else if (typeof value === 'object') compact[key] = `[object(${Object.keys(value).length} keys)]`;
      else compact[key] = value;
    }
    out[name] = compact;
  }
  return out;
}

// ============================================================
// Breadcrumbs
// ============================================================

export interface BreadcrumbTrail {
  /** Breadcrumbs matching the filter, before `limit` is applied. */
  total: number;
  /** The most recent `limit` matching breadcrumbs, oldest first. */
  breadcrumbs: unknown[];
}

/**
 * Breadcrumbs are recorded oldest first; the ones nearest the error are at the
 * end, so the most recent `limit` are kept.
 */
export function extractBreadcrumbTrail(eventData: unknown, limit: number = 50, typeFilter?: string): BreadcrumbTrail {
  if (!isRecord(eventData) || !Array.isArray(eventData.entries)) return { total: 0, breadcrumbs: [] };

  const matching: unknown[] = [];
  for (const entry of eventData.entries) {
    if (!isRecord(entry) || entry.type !== 'breadcrumbs') continue;
    const values = isRecord(entry.data) && Array.isArray(entry.data.values) ? entry.data.values : [];
    for (const crumb of values) {
      const c = isRecord(crumb) ? crumb : {};
      const type = c.type || 'default';
      if (typeFilter && type !== typeFilter) continue;
      matching.push({
        type,
        category: c.category,
        message: c.message,
        timestamp: c.timestamp,
        level: c.level,
        data: c.data,
      });
    }
  }

  return { total: matching.length, breadcrumbs: tail(matching, limit) };
}

/**
 * Extract breadcrumb entries from event data: the most recent `limit` matching ones.
 */
export function extractBreadcrumbs(eventData: unknown, limit: number = 50, typeFilter?: string): unknown[] {
  return extractBreadcrumbTrail(eventData, limit, typeFilter).breadcrumbs;
}
