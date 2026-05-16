// Shared TypeScript interfaces for Sentry API

// ============================================================
// Sentry API Response Types
// ============================================================

export interface SentryIssue {
  id: string;
  shortId?: string;
  title: string;
  culprit?: string;
  permalink?: string;
  logger?: string;
  level?: string;
  status?: string;
  type?: string;
  platform?: string;
  project?: string;
  count?: string | number;
  userCount?: number;
  firstSeen?: string;
  lastSeen?: string;
  metadata?: Record<string, unknown>;
  annotations?: unknown;
  context?: Record<string, unknown>;
  tags?: unknown;
  [key: string]: unknown;
}

export interface SentryEvent {
  id: string;
  eventID?: string;
  dateCreated?: string;
  title?: string;
  message?: string;
  platform?: string;
  type?: string;
  groupID?: string;
  entries?: SentryEventEntry[];
  tags?: [string, string][];
  user?: { id?: string; email?: string; username?: string };
  contexts?: Record<string, unknown>;
  sdk?: unknown;
  errors?: SentryEventError[];
  [key: string]: unknown;
}

export interface SentryEventEntry {
  type: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SentryEventError {
  type: string;
  message?: string;
  data?: Record<string, unknown>;
}

export interface SentryRelease {
  version: string;
  dateReleased: string | null;
  dateCreated: string;
  commitCount?: number;
  authors?: SentryUser[];
  lastDeploy?: SentryDeploy;
  newGroups?: number;
  firstEvent?: string;
  lastEvent?: string;
  url?: string | null;
  ref?: string | null;
  shortVersion?: string;
  versionInfo?: {
    description?: string;
    version?: {
      raw?: string;
      [key: string]: unknown;
    };
  };
  stats?: Record<string, [string, number][]>;
  [key: string]: unknown;
}

export interface SentryDeploy {
  id: string;
  name: string;
  environment: string;
  dateStarted: string;
  dateFinished?: string;
  url?: string | null;
  [key: string]: unknown;
}

export interface SentryUser {
  id?: string;
  name?: string;
  email?: string;
  username?: string;
  ip_address?: string;
  [key: string]: unknown;
}

export interface SentryTeam {
  id: string;
  slug: string;
  name: string;
  dateCreated?: string;
  isMember?: boolean;
  memberCount?: number;
}

export interface SentryTag {
  key: string;
  name: string;
  topValues: SentryTagValue[];
  totalValues?: number;
}

export interface SentryTagValue {
  value: string;
  count: number;
  name?: string;
  lastSeen?: string;
  firstSeen?: string;
}

export interface SentryActivity {
  id: string;
  type: string;
  dateCreated: string;
  data: Record<string, unknown>;
  user?: SentryUser | null;
  env?: string;
  issue?: string;
}

export interface SentryTrace {
  traceId: string;
  spans?: SentrySpan[];
  duration?: number;
  startTimestamp?: number;
  endTimestamp?: number;
  [key: string]: unknown;
}

export interface SentrySpan {
  spanId: string;
  traceId?: string;
  parentSpanId?: string;
  op?: string;
  description?: string;
  startTimestamp?: number;
  timestamp?: number;
  tags?: Record<string, string>;
  status?: string;
  data?: Record<string, unknown>;
  exclusiveTime?: number;
  [key: string]: unknown;
}

export interface SentryGroupingConfig {
  id: string;
  name: string;
  enhancements?: string;
}

export interface SentryProject {
  id: string;
  slug: string;
  name: string;
  platform?: string;
  dateCreated?: string;
  firstEvent?: string;
  team?: string;
  teams?: { id: string; slug: string; name: string }[];
}

// ============================================================
// MCP Tool Types
// ============================================================

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  errorCode?: number;
}

// ============================================================
// Pagination
// ============================================================

export interface PaginationParams {
  limit?: number;
  cursor?: string;
  offset?: number;
}

export interface PaginationMeta {
  cursor?: string;
  hasMore?: boolean;
  total?: number;
}

// ============================================================
// Filtering & Truncation
// ============================================================

export interface FilterParams {
  include_fields?: string[];
  exclude_fields?: string[];
  grep_pattern?: string;
}

export interface TruncateResult<T> {
  data: T;
  truncated: boolean;
  pagination_info?: string;
}

// ============================================================
// Stack Frame Types
// ============================================================

export interface StackFrame {
  function: string;
  filename: string | null;
  line_no: number | null;
  col_no: number | null;
  in_app: boolean;
  module: string | null;
  package: string | null;
  instruction_addr: string | null;
  symbol_addr: string | null;
  absPath?: string | null;
  context?: (string | null)[];
  vars?: unknown;
  rawFunction?: string;
}

export interface ExtractedFrames {
  event_id: string;
  total_frames: number;
  returned_frames: number;
  in_app_only: boolean;
  frames: StackFrame[];
}

// ============================================================
// Breadcrumb Types
// ============================================================

export interface Breadcrumb {
  type: string;
  category?: string;
  message?: string;
  timestamp?: string;
  level?: string;
  data?: Record<string, unknown>;
}

export interface BreadcrumbResult {
  event_id: string;
  total_breadcrumbs: number;
  returned_breadcrumbs: number;
  type_filter?: string;
  breadcrumbs: Breadcrumb[];
}

// ============================================================
// dSYM Types
// ============================================================

export interface MissingDsym {
  type: string;
  message: string;
  image_path?: string;
  image_uuid?: string;
  image_name?: string;
}

export interface DsymResult {
  project: string;
  event_id?: string;
  has_missing_symbols: boolean;
  missing_count: number;
  missing_symbols: MissingDsym[];
  recommendation: string;
}
