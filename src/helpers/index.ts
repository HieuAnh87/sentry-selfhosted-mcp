// Type guards for tool argument validation

// ============================================================
// Issue Tool Type Guards
// ============================================================

export const isValidGetIssueArgs = (args: unknown): args is {
  issue_id_or_url: string;
  include_latest_event?: boolean;
  include_fields?: string[];
  exclude_fields?: string[];
  grep_pattern?: string;
  max_stack_frames?: number;
} =>
  typeof args === 'object' && args !== null &&
  typeof (args as Record<string, unknown>).issue_id_or_url === 'string' &&
  ((args as Record<string, unknown>).include_latest_event === undefined || typeof (args as Record<string, unknown>).include_latest_event === 'boolean') &&
  ((args as Record<string, unknown>).include_fields === undefined || Array.isArray((args as Record<string, unknown>).include_fields)) &&
  ((args as Record<string, unknown>).exclude_fields === undefined || Array.isArray((args as Record<string, unknown>).exclude_fields)) &&
  ((args as Record<string, unknown>).grep_pattern === undefined || typeof (args as Record<string, unknown>).grep_pattern === 'string') &&
  ((args as Record<string, unknown>).max_stack_frames === undefined || typeof (args as Record<string, unknown>).max_stack_frames === 'number');

export const isValidListIssuesArgs = (args: unknown): args is {
  project_slug: string;
  query?: string;
  status?: string;
  limit?: number;
  cursor?: string;
} =>
  typeof args === 'object' && args !== null &&
  typeof (args as Record<string, unknown>).project_slug === 'string' &&
  ((args as Record<string, unknown>).query === undefined || typeof (args as Record<string, unknown>).query === 'string') &&
  ((args as Record<string, unknown>).status === undefined || typeof (args as Record<string, unknown>).status === 'string') &&
  ((args as Record<string, unknown>).limit === undefined || ((typeof (args as Record<string, unknown>).limit === 'number') && ((args as Record<string, unknown>).limit as number) > 0 && ((args as Record<string, unknown>).limit as number) <= 100)) &&
  ((args as Record<string, unknown>).cursor === undefined || typeof (args as Record<string, unknown>).cursor === 'string');

export const isValidSearchIssuesArgs = (args: unknown): args is {
  query?: string;
  sort?: string;
  limit?: number;
  cursor?: string;
} =>
  typeof args === 'object' && args !== null &&
  ((args as Record<string, unknown>).query === undefined || typeof (args as Record<string, unknown>).query === 'string') &&
  ((args as Record<string, unknown>).sort === undefined || typeof (args as Record<string, unknown>).sort === 'string') &&
  ((args as Record<string, unknown>).limit === undefined || ((typeof (args as Record<string, unknown>).limit === 'number') && ((args as Record<string, unknown>).limit as number) > 0 && ((args as Record<string, unknown>).limit as number) <= 100)) &&
  ((args as Record<string, unknown>).cursor === undefined || typeof (args as Record<string, unknown>).cursor === 'string');

export const isValidUpdateIssueArgs = (args: unknown): args is {
  issue_id: string;
  status: 'resolved' | 'ignored' | 'unresolved';
} =>
  typeof args === 'object' && args !== null &&
  typeof (args as Record<string, unknown>).issue_id === 'string' &&
  typeof (args as Record<string, unknown>).status === 'string' &&
  ['resolved', 'ignored', 'unresolved'].includes((args as Record<string, unknown>).status as string);

export const isValidCreateCommentArgs = (args: unknown): args is {
  issue_id: string;
  comment_text: string;
} =>
  typeof args === 'object' && args !== null &&
  typeof (args as Record<string, unknown>).issue_id === 'string' &&
  typeof (args as Record<string, unknown>).comment_text === 'string';

export const isValidGetIssueHashesArgs = (args: unknown): args is {
  issue_id: string;
  cursor?: string;
} =>
  typeof args === 'object' && args !== null &&
  typeof (args as Record<string, unknown>).issue_id === 'string' &&
  ((args as Record<string, unknown>).cursor === undefined || typeof (args as Record<string, unknown>).cursor === 'string');

export const isValidBulkUpdateArgs = (args: unknown): args is {
  project_slug: string;
  query?: string;
  status?: 'resolved' | 'ignored' | 'unresolved';
  assigned_to?: string;
  has_seen?: boolean;
} =>
  typeof args === 'object' && args !== null &&
  typeof (args as Record<string, unknown>).project_slug === 'string' &&
  ((args as Record<string, unknown>).query === undefined || typeof (args as Record<string, unknown>).query === 'string') &&
  ((args as Record<string, unknown>).status === undefined || ['resolved', 'ignored', 'unresolved'].includes((args as Record<string, unknown>).status as string)) &&
  ((args as Record<string, unknown>).assigned_to === undefined || typeof (args as Record<string, unknown>).assigned_to === 'string') &&
  ((args as Record<string, unknown>).has_seen === undefined || typeof (args as Record<string, unknown>).has_seen === 'boolean');

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
  typeof args === 'object' && args !== null &&
  typeof (args as Record<string, unknown>).project_slug === 'string' &&
  typeof (args as Record<string, unknown>).event_id === 'string' &&
  ((args as Record<string, unknown>).limit === undefined || (typeof (args as Record<string, unknown>).limit === 'number' && ((args as Record<string, unknown>).limit as number) > 0)) &&
  ((args as Record<string, unknown>).offset === undefined || (typeof (args as Record<string, unknown>).offset === 'number' && ((args as Record<string, unknown>).offset as number) >= 0)) &&
  ((args as Record<string, unknown>).entry_type === undefined || typeof (args as Record<string, unknown>).entry_type === 'string');

export const isValidListIssueEventsArgs = (args: unknown): args is {
  issue_id: string;
  limit?: number;
  cursor?: string;
  full?: boolean;
} =>
  typeof args === 'object' && args !== null &&
  typeof (args as Record<string, unknown>).issue_id === 'string' &&
  ((args as Record<string, unknown>).limit === undefined || ((typeof (args as Record<string, unknown>).limit === 'number') && ((args as Record<string, unknown>).limit as number) > 0 && ((args as Record<string, unknown>).limit as number) <= 100)) &&
  ((args as Record<string, unknown>).cursor === undefined || typeof (args as Record<string, unknown>).cursor === 'string') &&
  ((args as Record<string, unknown>).full === undefined || typeof (args as Record<string, unknown>).full === 'boolean');

export const isValidListErrorEventsArgs = (args: unknown): args is {
  project_slug: string;
  limit?: number;
  cursor?: string;
  query?: string;
  full?: boolean;
} =>
  typeof args === 'object' && args !== null &&
  typeof (args as Record<string, unknown>).project_slug === 'string' &&
  ((args as Record<string, unknown>).limit === undefined || ((typeof (args as Record<string, unknown>).limit === 'number') && ((args as Record<string, unknown>).limit as number) > 0 && ((args as Record<string, unknown>).limit as number) <= 100)) &&
  ((args as Record<string, unknown>).cursor === undefined || typeof (args as Record<string, unknown>).cursor === 'string') &&
  ((args as Record<string, unknown>).query === undefined || typeof (args as Record<string, unknown>).query === 'string') &&
  ((args as Record<string, unknown>).full === undefined || typeof (args as Record<string, unknown>).full === 'boolean');

export const isValidGetStackFramesArgs = (args: unknown): args is {
  project_slug: string;
  event_id: string;
  in_app_only?: boolean;
  max_frames?: number;
} =>
  typeof args === 'object' && args !== null &&
  typeof (args as Record<string, unknown>).project_slug === 'string' &&
  typeof (args as Record<string, unknown>).event_id === 'string' &&
  ((args as Record<string, unknown>).in_app_only === undefined || typeof (args as Record<string, unknown>).in_app_only === 'boolean') &&
  ((args as Record<string, unknown>).max_frames === undefined || typeof (args as Record<string, unknown>).max_frames === 'number');

export const isValidCheckDsymArgs = (args: unknown): args is {
  project_slug: string;
  event_id?: string;
} =>
  typeof args === 'object' && args !== null &&
  typeof (args as Record<string, unknown>).project_slug === 'string' &&
  ((args as Record<string, unknown>).event_id === undefined || typeof (args as Record<string, unknown>).event_id === 'string');

export const isValidListBreadcrumbsArgs = (args: unknown): args is {
  project_slug: string;
  event_id: string;
  limit?: number;
  type?: string;
} =>
  typeof args === 'object' && args !== null &&
  typeof (args as Record<string, unknown>).project_slug === 'string' &&
  typeof (args as Record<string, unknown>).event_id === 'string' &&
  ((args as Record<string, unknown>).limit === undefined || ((typeof (args as Record<string, unknown>).limit === 'number') && ((args as Record<string, unknown>).limit as number) > 0 && ((args as Record<string, unknown>).limit as number) <= 100)) &&
  ((args as Record<string, unknown>).type === undefined || typeof (args as Record<string, unknown>).type === 'string');

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
  typeof args === 'object' && args !== null &&
  ((args as Record<string, unknown>).query === undefined || typeof (args as Record<string, unknown>).query === 'string') &&
  ((args as Record<string, unknown>).date === undefined || typeof (args as Record<string, unknown>).date === 'string') &&
  ((args as Record<string, unknown>).limit === undefined || ((typeof (args as Record<string, unknown>).limit === 'number') && ((args as Record<string, unknown>).limit as number) > 0 && ((args as Record<string, unknown>).limit as number) <= 100)) &&
  ((args as Record<string, unknown>).cursor === undefined || typeof (args as Record<string, unknown>).cursor === 'string') &&
  ((args as Record<string, unknown>).sort === undefined || typeof (args as Record<string, unknown>).sort === 'string');

export const isValidGetReleaseArgs = (args: unknown): args is {
  version: string;
  full?: boolean;
} =>
  typeof args === 'object' && args !== null &&
  typeof (args as Record<string, unknown>).version === 'string' &&
  ((args as Record<string, unknown>).full === undefined || typeof (args as Record<string, unknown>).full === 'boolean');

// ============================================================
// Organization Tool Type Guards
// ============================================================

export const isValidGetIssueTagsArgs = (args: unknown): args is {
  issue_id: string;
} =>
  typeof args === 'object' && args !== null &&
  typeof (args as Record<string, unknown>).issue_id === 'string';

export const isValidGetIssueTagValuesArgs = (args: unknown): args is {
  issue_id: string;
  tag_key: string;
  limit?: number;
} =>
  typeof args === 'object' && args !== null &&
  typeof (args as Record<string, unknown>).issue_id === 'string' &&
  typeof (args as Record<string, unknown>).tag_key === 'string' &&
  ((args as Record<string, unknown>).limit === undefined || ((typeof (args as Record<string, unknown>).limit === 'number') && ((args as Record<string, unknown>).limit as number) > 0 && ((args as Record<string, unknown>).limit as number) <= 100));

export const isValidListActivityArgs = (args: unknown): args is {
  issue_id: string;
  limit?: number;
  cursor?: string;
} =>
  typeof args === 'object' && args !== null &&
  typeof (args as Record<string, unknown>).issue_id === 'string' &&
  ((args as Record<string, unknown>).limit === undefined || ((typeof (args as Record<string, unknown>).limit === 'number') && ((args as Record<string, unknown>).limit as number) > 0 && ((args as Record<string, unknown>).limit as number) <= 100)) &&
  ((args as Record<string, unknown>).cursor === undefined || typeof (args as Record<string, unknown>).cursor === 'string');

// ============================================================
// Advanced Tool Type Guards
// ============================================================

export const isValidGetTraceArgs = (args: unknown): args is {
  trace_id: string;
  max_spans?: number;
} =>
  typeof args === 'object' && args !== null &&
  typeof (args as Record<string, unknown>).trace_id === 'string' &&
  ((args as Record<string, unknown>).max_spans === undefined || ((typeof (args as Record<string, unknown>).max_spans === 'number') && ((args as Record<string, unknown>).max_spans as number) > 0 && ((args as Record<string, unknown>).max_spans as number) <= 500));

export const isValidMergeIssuesArgs = (args: unknown): args is {
  issue_id: string;
  target_ids: string[];
} =>
  typeof args === 'object' && args !== null &&
  typeof (args as Record<string, unknown>).issue_id === 'string' &&
  Array.isArray((args as Record<string, unknown>).target_ids) &&
  ((args as Record<string, unknown>).target_ids as unknown[]).every(t => typeof t === 'string') &&
  ((args as Record<string, unknown>).target_ids as unknown[]).length <= 10;

export const isValidGetGroupingConfigArgs = (args: unknown): args is {
  issue_id: string;
} =>
  typeof args === 'object' && args !== null &&
  typeof (args as Record<string, unknown>).issue_id === 'string';

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
  typeof args === 'object' && args !== null &&
  typeof (args as Record<string, unknown>).endpoint === 'string' &&
  ((args as Record<string, unknown>).method === undefined || typeof (args as Record<string, unknown>).method === 'string') &&
  ((args as Record<string, unknown>).params === undefined || typeof (args as Record<string, unknown>).params === 'object') &&
  ((args as Record<string, unknown>).body === undefined || typeof (args as Record<string, unknown>).body === 'object') &&
  ((args as Record<string, unknown>).grep_pattern === undefined || typeof (args as Record<string, unknown>).grep_pattern === 'string');
