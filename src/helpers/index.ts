// Type guards for tool argument validation

// ============================================================
// Shared Validators
// ============================================================

// Sentry issue/group IDs are numeric; slugs and opaque IDs must never carry path separators
const NUMERIC_ID_PATTERN = /^\d+$/;
// Short IDs are `<PROJECT-SLUG>-<base32>` (e.g. `WEB-1A3`, `my-project-2B`). Project slugs are
// `[a-z0-9_-]`, so no dots, slashes, percent escapes or whitespace can appear.
const SHORT_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?-[A-Za-z0-9]+$/;
const MAX_ISSUE_ID_LENGTH = 128;
// Dots are legal in slugs but `.` / `..` are path segments: encodeURIComponent leaves
// them intact and the URL parser then normalizes them away, dropping the org segment.
const SLUG_PATTERN = /^(?!\.+$)[a-z0-9._-]+$/i;
const ID_TOKEN_PATTERN = /^[a-zA-Z0-9_-]+$/;

// Allowlists mirroring the enums declared in each tool's inputSchema
const ISSUE_STATUSES = ['resolved', 'ignored', 'unresolved'];
const ISSUE_SORTS = ['date', 'priority', 'freq', 'user'];
const RELEASE_SORTS = ['date', 'semver'];
const RELEASE_DATE_FILTERS = ['adopted', 'unadopted'];
const EVENT_ENTRY_TYPES = ['exception', 'message', 'breadcrumbs', 'request', 'threads', 'debugmeta', 'contexts'];

const UNBOUNDED = Number.MAX_SAFE_INTEGER;
const MAX_BULK_ISSUE_IDS = 100;

const isObject = (args: unknown): args is Record<string, unknown> =>
  typeof args === 'object' && args !== null;

const isString = (value: unknown): boolean => typeof value === 'string';
const isBoolean = (value: unknown): boolean => typeof value === 'boolean';
const isNumericId = (value: unknown): boolean => typeof value === 'string' && NUMERIC_ID_PATTERN.test(value);

/** A numeric issue ID or a short ID such as `PROJ-1A2`. Never contains path structure. */
export const isIssueId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= MAX_ISSUE_ID_LENGTH &&
  (NUMERIC_ID_PATTERN.test(value) || SHORT_ID_PATTERN.test(value));
const isSlug = (value: unknown): boolean => typeof value === 'string' && SLUG_PATTERN.test(value);
const isIdToken = (value: unknown): boolean => typeof value === 'string' && ID_TOKEN_PATTERN.test(value);
const isStringArray = (value: unknown): boolean => Array.isArray(value) && value.every(item => typeof item === 'string');
const isEnum = (value: unknown, allowed: string[]): boolean => typeof value === 'string' && allowed.includes(value);
const isNumberInRange = (value: unknown, min: number, max: number): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const isOptional = (value: unknown, check: (value: unknown) => boolean): boolean =>
  value === undefined || check(value);

// ============================================================
// Issue Tool Type Guards
// ============================================================

export const isValidListProjectsArgs = (args: unknown): args is {
  cursor?: string;
} =>
  isObject(args) &&
  isOptional(args.cursor, isString);

export const isValidGetIssueArgs = (args: unknown): args is {
  issue_id_or_url: string;
  include_latest_event?: boolean;
  include_fields?: string[];
  exclude_fields?: string[];
  grep_pattern?: string;
  max_stack_frames?: number;
} =>
  isObject(args) &&
  // Accepts a numeric ID or a full issue URL; the handler extracts and re-validates the ID
  isString(args.issue_id_or_url) &&
  isOptional(args.include_latest_event, isBoolean) &&
  isOptional(args.include_fields, isStringArray) &&
  isOptional(args.exclude_fields, isStringArray) &&
  isOptional(args.grep_pattern, isString) &&
  isOptional(args.max_stack_frames, value => isNumberInRange(value, 0, UNBOUNDED));

export const isValidListIssuesArgs = (args: unknown): args is {
  project_slug: string;
  query?: string;
  status?: string;
  limit?: number;
  cursor?: string;
  full?: boolean;
} =>
  isObject(args) &&
  isSlug(args.project_slug) &&
  isOptional(args.query, isString) &&
  isOptional(args.status, value => isEnum(value, ISSUE_STATUSES)) &&
  isOptional(args.limit, value => isNumberInRange(value, 1, 100)) &&
  isOptional(args.cursor, isString) &&
  isOptional(args.full, isBoolean);

export const isValidSearchIssuesArgs = (args: unknown): args is {
  query?: string;
  sort?: string;
  limit?: number;
  cursor?: string;
  full?: boolean;
} =>
  isObject(args) &&
  isOptional(args.query, isString) &&
  isOptional(args.sort, value => isEnum(value, ISSUE_SORTS)) &&
  isOptional(args.limit, value => isNumberInRange(value, 1, 100)) &&
  isOptional(args.cursor, isString) &&
  isOptional(args.full, isBoolean);

export const isValidUpdateIssueArgs = (args: unknown): args is {
  issue_id: string;
  status: 'resolved' | 'ignored' | 'unresolved';
} =>
  isObject(args) &&
  isIssueId(args.issue_id) &&
  isEnum(args.status, ISSUE_STATUSES);

export const isValidCreateCommentArgs = (args: unknown): args is {
  issue_id: string;
  comment_text: string;
} =>
  isObject(args) &&
  isIssueId(args.issue_id) &&
  isString(args.comment_text);

export const isValidGetIssueHashesArgs = (args: unknown): args is {
  issue_id: string;
  cursor?: string;
} =>
  isObject(args) &&
  isIssueId(args.issue_id) &&
  isOptional(args.cursor, isString);

export const isValidBulkUpdateArgs = (args: unknown): args is {
  project_slug: string;
  query?: string;
  issue_ids?: string[];
  status?: 'resolved' | 'ignored' | 'unresolved';
  assigned_to?: string;
  has_seen?: boolean;
} =>
  isObject(args) &&
  isSlug(args.project_slug) &&
  isOptional(args.query, isString) &&
  // Numeric only: the bulk endpoint filters `id=` against numeric group IDs and does not resolve short IDs
  isOptional(args.issue_ids, value =>
    Array.isArray(value) && value.length >= 1 && value.length <= MAX_BULK_ISSUE_IDS && value.every(isNumericId)) &&
  isOptional(args.status, value => isEnum(value, ISSUE_STATUSES)) &&
  isOptional(args.assigned_to, isString) &&
  isOptional(args.has_seen, isBoolean);

// ============================================================
// Event Tool Type Guards
// ============================================================

export const isValidGetEventArgs = (args: unknown): args is {
  project_slug: string;
  event_id: string;
  limit?: number;
  offset?: number;
  entry_type?: string;
} =>
  isObject(args) &&
  isSlug(args.project_slug) &&
  isIdToken(args.event_id) &&
  isOptional(args.limit, value => isNumberInRange(value, 1, UNBOUNDED)) &&
  isOptional(args.offset, value => isNumberInRange(value, 0, UNBOUNDED)) &&
  isOptional(args.entry_type, value => isEnum(value, EVENT_ENTRY_TYPES));

export const isValidListIssueEventsArgs = (args: unknown): args is {
  issue_id: string;
  limit?: number;
  cursor?: string;
  full?: boolean;
} =>
  isObject(args) &&
  isIssueId(args.issue_id) &&
  isOptional(args.limit, value => isNumberInRange(value, 1, 100)) &&
  isOptional(args.cursor, isString) &&
  isOptional(args.full, isBoolean);

export const isValidListErrorEventsArgs = (args: unknown): args is {
  project_slug: string;
  limit?: number;
  cursor?: string;
  query?: string;
  full?: boolean;
} =>
  isObject(args) &&
  isSlug(args.project_slug) &&
  isOptional(args.limit, value => isNumberInRange(value, 1, 100)) &&
  isOptional(args.cursor, isString) &&
  isOptional(args.query, isString) &&
  isOptional(args.full, isBoolean);

export const isValidGetStackFramesArgs = (args: unknown): args is {
  project_slug: string;
  event_id: string;
  in_app_only?: boolean;
  max_frames?: number;
} =>
  isObject(args) &&
  isSlug(args.project_slug) &&
  isIdToken(args.event_id) &&
  isOptional(args.in_app_only, isBoolean) &&
  isOptional(args.max_frames, value => isNumberInRange(value, 1, 100));

export const isValidCheckDsymArgs = (args: unknown): args is {
  project_slug: string;
  event_id?: string;
} =>
  isObject(args) &&
  isSlug(args.project_slug) &&
  isOptional(args.event_id, isIdToken);

export const isValidListBreadcrumbsArgs = (args: unknown): args is {
  project_slug: string;
  event_id: string;
  limit?: number;
  type?: string;
} =>
  isObject(args) &&
  isSlug(args.project_slug) &&
  isIdToken(args.event_id) &&
  isOptional(args.limit, value => isNumberInRange(value, 1, 100)) &&
  isOptional(args.type, isString);

// ============================================================
// Release Tool Type Guards
// ============================================================

export const isValidListReleasesArgs = (args: unknown): args is {
  query?: string;
  date?: string;
  limit?: number;
  cursor?: string;
  sort?: string;
} =>
  isObject(args) &&
  isOptional(args.query, isString) &&
  isOptional(args.date, value => isEnum(value, RELEASE_DATE_FILTERS)) &&
  isOptional(args.limit, value => isNumberInRange(value, 1, 100)) &&
  isOptional(args.cursor, isString) &&
  isOptional(args.sort, value => isEnum(value, RELEASE_SORTS));

export const isValidGetReleaseArgs = (args: unknown): args is {
  version: string;
  full?: boolean;
} =>
  isObject(args) &&
  // Versions are free-form (semver, SHA, custom); the client URL-encodes them
  isString(args.version) &&
  isOptional(args.full, isBoolean);

// ============================================================
// Organization Tool Type Guards
// ============================================================

export const isValidGetIssueTagsArgs = (args: unknown): args is {
  issue_id: string;
} =>
  isObject(args) &&
  isIssueId(args.issue_id);

export const isValidGetIssueTagValuesArgs = (args: unknown): args is {
  issue_id: string;
  tag_key: string;
  limit?: number;
} =>
  isObject(args) &&
  isIssueId(args.issue_id) &&
  // Tag keys are free-form (e.g. "user.email"); the client URL-encodes them
  isString(args.tag_key) &&
  isOptional(args.limit, value => isNumberInRange(value, 1, 100));

export const isValidListActivityArgs = (args: unknown): args is {
  issue_id: string;
  limit?: number;
  cursor?: string;
} =>
  isObject(args) &&
  isIssueId(args.issue_id) &&
  isOptional(args.limit, value => isNumberInRange(value, 1, 100)) &&
  isOptional(args.cursor, isString);

// ============================================================
// Advanced Tool Type Guards
// ============================================================

export const isValidGetTraceArgs = (args: unknown): args is {
  trace_id: string;
  max_spans?: number;
} =>
  isObject(args) &&
  isIdToken(args.trace_id) &&
  isOptional(args.max_spans, value => isNumberInRange(value, 1, 500));

export const isValidMergeIssuesArgs = (args: unknown): args is {
  issue_id: string;
  target_ids: string[];
} =>
  isObject(args) &&
  isIssueId(args.issue_id) &&
  Array.isArray(args.target_ids) &&
  args.target_ids.every(isIssueId) &&
  args.target_ids.length <= 10;

export const isValidGetGroupingConfigArgs = (args: unknown): args is {
  issue_id: string;
} =>
  isObject(args) &&
  isIssueId(args.issue_id);

// ============================================================
// Raw API Type Guard
// ============================================================

export const isValidRawApiArgs = (args: unknown): args is {
  endpoint: string;
  method?: string;
  params?: Record<string, unknown>;
  body?: unknown;
  grep_pattern?: string;
} =>
  isObject(args) &&
  // The path itself is normalized and rejected in handleRawApi
  isString(args.endpoint) &&
  isOptional(args.method, isString) &&
  isOptional(args.params, value => typeof value === 'object') &&
  isOptional(args.body, value => typeof value === 'object') &&
  isOptional(args.grep_pattern, isString);
