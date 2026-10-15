// Advanced MCP tools: trace, grouping, merge

import { sentryClient } from '../api/client.js';
import { ORG_SLUG } from '../config.js';
import type { ToolDefinition, ToolResult, SentryIssue } from '../api/types.js';
import { isValidGetTraceArgs, isValidMergeIssuesArgs, isValidGetGroupingConfigArgs } from '../helpers/index.js';
import { truncatedTextResult } from './issues.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// Both trace endpoints default to (or are bounded by) a server-side window; ask
// explicitly for the self-hosted default event retention so older traces are found.
const TRACE_STATS_PERIOD = '90d';
const DEFAULT_MAX_SPANS = 100;
// Per-span error references and top-level orphan errors kept in the output
const MAX_ERROR_REFS = 5;
const MAX_ORPHAN_ERRORS = 20;
// Grouping component summary bounds
const MAX_COMPONENT_DEPTH = 8;
const MAX_COMPONENT_LINES = 25;
const MAX_COMPONENT_VALUE_CHARS = 120;

// ============================================================
// Tool Definitions
// ============================================================

export const get_trace_details_tool: ToolDefinition = {
  name: 'get_trace_details',
  description: 'Get a distributed trace as a compact, flat list of spans/transactions (id, parent id, op, description, transaction, project, duration ms, start time, linked errors) in tree order with depth, plus totals and errors not attached to any span. Searches the last 90 days. Requires performance/tracing data.',
  inputSchema: {
    type: 'object',
    properties: {
      trace_id: { type: 'string', description: 'Trace ID (32-character hex string).' },
      max_spans: {
        type: 'number',
        description: 'Max spans to return (1-500, default: 100). Totals always cover the whole trace.',
        minimum: 1,
        maximum: 500,
        default: 100,
      },
    },
    required: ['trace_id'],
  },
};

export const get_grouping_config_tool: ToolDefinition = {
  name: 'get_grouping_config',
  description: 'Explain why events are grouped into an issue: takes the issue\'s latest event and returns its grouping breakdown — the grouping config, and per variant (e.g. app/system stack trace, fingerprint, message) whether it contributes, its hash, hint and a short summary of the contributing components. Compare hashes with get_issue_hashes.',
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'string', description: 'Numeric issue ID or short ID (e.g. PROJ-1A2)' },
    },
    required: ['issue_id'],
  },
};

export const merge_issues_tool: ToolDefinition = {
  name: 'merge_issues',
  description: 'Merge issues of the same project into one (error issues only; cross-project merges are refused). Sentry picks the surviving parent itself — the issue first seen earliest — which is not necessarily issue_id; the others become its children. The merge completes asynchronously in Sentry. Use after confirming the issues share a root cause.',
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'string', description: 'Numeric issue ID or short ID (e.g. PROJ-1A2)' },
      target_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Other issues to merge with issue_id: numeric IDs or short IDs, same project (max 10).',
        maxItems: 10,
      },
    },
    required: ['issue_id', 'target_ids'],
  },
};

// ============================================================
// Utility Functions
// ============================================================

type Rec = Record<string, unknown>;

const asRecord = (value: unknown): Rec | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : undefined;

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : undefined;

const num = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
};

const round = (value: number | undefined): number | undefined =>
  value === undefined ? undefined : Math.round(value * 100) / 100;

/** Epoch seconds become ISO strings; ISO strings pass through. */
const toIso = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value !== '' && !Number.isFinite(Number(value))) return value;
  const seconds = num(value);
  if (seconds === undefined) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

const toEpoch = (value: unknown): number | undefined => {
  const seconds = num(value);
  if (seconds !== undefined) return seconds;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms / 1000;
  }
  return undefined;
};

/** One error linked to a trace, in either endpoint's vocabulary. */
interface TraceErrorRef {
  event_id?: string;
  issue?: string;
  title?: string;
  level?: string;
  project?: string;
  timestamp?: string;
}

const errorRef = (raw: unknown): TraceErrorRef => {
  const e = asRecord(raw) ?? {};
  return {
    event_id: str(e.event_id),
    issue: str(e.short_id) ?? str(e.issue_short_id) ?? str(e.issue_id) ?? str(e.issue),
    title: str(e.title) ?? str(e.description) ?? str(e.message),
    level: str(e.level),
    project: str(e.project_slug),
    timestamp: toIso(e.start_timestamp ?? e.timestamp),
  };
};

export interface TraceSpanSummary {
  id?: string;
  parent_id?: string;
  depth: number;
  kind: string;
  op?: string;
  description?: string;
  transaction?: string;
  project?: string;
  duration_ms?: number;
  start_timestamp?: string;
  error_count?: number;
  error_ids?: string[];
  error_issues?: string[];
}

export interface NormalizedTrace {
  source: 'trace' | 'events-trace' | 'unknown';
  spans: TraceSpanSummary[];
  orphan_errors: TraceErrorRef[];
  total_spans: number;
  total_errors: number;
  projects: string[];
  start_timestamp?: string;
  end_timestamp?: string;
  duration_ms?: number;
}

/**
 * Flatten either trace response into one compact span list.
 *
 * - `organizations/{org}/trace/{id}/` returns a list of items; spans and uptime
 *   checks nest `children`, `errors` and `occurrences`, and errors/occurrences
 *   not attached to a span appear at the top level. `duration` is milliseconds,
 *   timestamps are epoch seconds.
 * - `organizations/{org}/events-trace/{id}/` (older) returns
 *   `{transactions, orphan_errors}`; transactions nest `children` and carry
 *   `errors` and `performance_issues`. `transaction.duration` is milliseconds.
 */
export function normalizeTrace(raw: unknown): NormalizedTrace {
  const spans: TraceSpanSummary[] = [];
  const orphanErrors: TraceErrorRef[] = [];
  const projects = new Set<string>();
  let totalErrors = 0;
  let minStart: number | undefined;
  let maxEnd: number | undefined;

  const legacy = asRecord(raw);
  const source: NormalizedTrace['source'] = Array.isArray(raw)
    ? 'trace'
    : legacy && ('transactions' in legacy || 'orphan_errors' in legacy) ? 'events-trace' : 'unknown';
  const roots = source === 'trace' ? asArray(raw) : asArray(legacy?.transactions);

  const track = (start: unknown, end: unknown, durationMs: number | undefined): void => {
    const s = toEpoch(start);
    let e = toEpoch(end);
    if (e === undefined && s !== undefined && durationMs !== undefined) e = s + durationMs / 1000;
    if (s !== undefined) minStart = minStart === undefined ? s : Math.min(minStart, s);
    if (e !== undefined) maxEnd = maxEnd === undefined ? e : Math.max(maxEnd, e);
  };

  // Iterative pre-order walk; never recurses, so a deep trace cannot overflow the stack.
  const stack: Array<{ node: unknown; parentId?: string; depth: number }> = [];
  for (let i = roots.length - 1; i >= 0; i--) stack.push({ node: roots[i], depth: 0 });

  while (stack.length > 0) {
    const { node, parentId, depth } = stack.pop()!;
    const n = asRecord(node);
    if (!n) continue;

    const eventType = str(n.event_type);
    if (eventType === 'error' || eventType === 'occurrence') {
      // A bare error/occurrence item: top-level in the new endpoint
      totalErrors++;
      const ref = errorRef(n);
      if (ref.project) projects.add(ref.project);
      if (orphanErrors.length < MAX_ORPHAN_ERRORS) orphanErrors.push(ref);
      continue;
    }

    const linked = [...asArray(n.errors), ...asArray(n.occurrences), ...asArray(n.performance_issues)];
    totalErrors += linked.length;

    const project = str(n.project_slug);
    if (project) projects.add(project);

    const isLegacy = source === 'events-trace';
    const id = isLegacy ? str(n.event_id) : str(n.event_id) ?? str(n.span_id);
    const durationMs = isLegacy ? num(n['transaction.duration']) : num(n.duration);
    const kind = isLegacy
      ? 'transaction'
      : eventType === 'uptime_check' ? 'uptime_check' : n.is_transaction === true ? 'transaction' : 'span';

    track(n.start_timestamp, isLegacy ? n.timestamp : n.end_timestamp, durationMs);

    const refs = linked.map(errorRef);
    const errorIds = refs.map(ref => ref.event_id).filter((v): v is string => !!v).slice(0, MAX_ERROR_REFS);
    const errorIssues = [...new Set(refs.map(ref => ref.issue).filter((v): v is string => !!v))].slice(0, MAX_ERROR_REFS);

    spans.push({
      id,
      parent_id: (isLegacy ? str(n.parent_event_id) : str(n.parent_span_id)) ?? parentId,
      depth,
      kind,
      op: str(n.op) ?? str(n['transaction.op']),
      description: str(n.description) ?? str(n.name),
      transaction: str(n.transaction),
      project,
      duration_ms: round(durationMs),
      start_timestamp: toIso(n.start_timestamp),
      error_count: linked.length > 0 ? linked.length : undefined,
      error_ids: errorIds.length > 0 ? errorIds : undefined,
      error_issues: errorIssues.length > 0 ? errorIssues : undefined,
    });

    const children = asArray(n.children);
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i], parentId: id, depth: depth + 1 });
    }
  }

  for (const raw of asArray(legacy?.orphan_errors)) {
    totalErrors++;
    const ref = errorRef(raw);
    if (ref.project) projects.add(ref.project);
    if (orphanErrors.length < MAX_ORPHAN_ERRORS) orphanErrors.push(ref);
  }

  return {
    source,
    spans,
    orphan_errors: orphanErrors,
    total_spans: spans.length,
    total_errors: totalErrors,
    projects: [...projects].sort(),
    start_timestamp: toIso(minStart),
    end_timestamp: toIso(maxEnd),
    duration_ms: minStart !== undefined && maxEnd !== undefined ? round((maxEnd - minStart) * 1000) : undefined,
  };
}

/** Slug of an issue's project; Sentry serializes `project` as an object. */
const issueProjectSlug = (issue: SentryIssue): string | undefined => {
  const project = issue.project as unknown;
  if (typeof project === 'string') return project || undefined;
  return str(asRecord(project)?.slug);
};

const clip = (value: string): string =>
  value.length > MAX_COMPONENT_VALUE_CHARS ? `${value.slice(0, MAX_COMPONENT_VALUE_CHARS)}...` : value;

/**
 * Summarize a grouping component tree as `path: value` lines for the parts that
 * contribute to the hash, e.g. `exception/stacktrace/frame/function: handle`.
 */
export function summarizeComponent(component: unknown): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  let truncated = false;

  const walk = (node: unknown, path: string[], depth: number): void => {
    if (lines.length >= MAX_COMPONENT_LINES) {
      truncated = true;
      return;
    }
    const c = asRecord(node);
    if (!c || c.contributes === false) return;
    if (depth > MAX_COMPONENT_DEPTH) {
      truncated = true;
      return;
    }

    const here = [...path, str(c.id) ?? str(c.name) ?? '?'];
    const primitives: string[] = [];
    for (const value of asArray(c.values)) {
      if (value !== null && typeof value === 'object') {
        walk(value, here, depth + 1);
      } else if (value !== null && value !== undefined) {
        primitives.push(String(value));
      }
    }
    if (primitives.length > 0) {
      if (lines.length >= MAX_COMPONENT_LINES) {
        truncated = true;
        return;
      }
      lines.push(`${here.join('/')}: ${clip(primitives.join(' '))}`);
    }
  };

  walk(component, [], 0);
  return { lines, truncated };
}

/** Compact view of one grouping-info variant. */
export function summarizeVariant(fallbackKey: string, raw: unknown): Rec {
  const v = asRecord(raw) ?? {};
  const contributes = v.contributes === true;
  const summary: Rec = {
    key: str(v.key) ?? fallbackKey,
    type: v.type,
    description: v.description,
    contributes,
    hash: v.hash ?? null,
    hint: v.hint ?? null,
  };
  if (v.hashMismatch === true) summary.hash_mismatch = true;

  // Fingerprint and checksum variants carry their inputs directly
  if (Array.isArray(v.values)) summary.fingerprint = v.values.slice(0, 10).map(value => clip(String(value)));
  if (Array.isArray(v.client_values)) summary.client_fingerprint = v.client_values.slice(0, 10).map(value => clip(String(value)));
  if (typeof v.matched_rule === 'string') summary.matched_rule = clip(v.matched_rule);
  if (typeof v.checksum === 'string') summary.checksum = v.checksum;

  if (contributes && v.component) {
    const { lines, truncated } = summarizeComponent(v.component);
    if (lines.length > 0) summary.contributing_components = lines;
    if (truncated) summary.contributing_components_truncated = true;
  }
  return summary;
}

/**
 * Normalize the grouping-info response. Current Sentry returns
 * `{grouping_config, variants: {key: variant}}`; older versions return the
 * variants map itself, with the config id on each component variant.
 */
export function summarizeGroupingInfo(info: unknown): { grouping_config: unknown; variants: Rec[] } {
  const body = asRecord(info) ?? {};
  const wrapped = asRecord(body.variants);
  const variantMap = wrapped && !('type' in wrapped && 'hash' in wrapped) ? wrapped : body;

  let groupingConfig: unknown = wrapped ? body.grouping_config : undefined;
  const variants: Rec[] = [];
  for (const [key, raw] of Object.entries(variantMap)) {
    const variant = asRecord(raw);
    if (!variant) continue;
    if (groupingConfig === undefined) groupingConfig = asRecord(variant.config)?.id;
    variants.push(summarizeVariant(key, variant));
  }

  // Contributing variants first: they are the ones that decide the grouping
  variants.sort((a, b) => Number(b.contributes) - Number(a.contributes));
  return { grouping_config: groupingConfig ?? null, variants };
}

const readMergeOutcome = (response: unknown): { merged: boolean; parent?: string; children?: string[] } => {
  const merge = asRecord(asRecord(response)?.merge);
  if (!merge) return { merged: false };
  return {
    merged: true,
    parent: str(merge.parent),
    children: asArray(merge.children).map(child => str(child)).filter((v): v is string => !!v),
  };
};

// ============================================================
// Tool Handlers
// ============================================================

export async function handleGetTraceDetails(args: unknown): Promise<ToolResult> {
  if (!isValidGetTraceArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for get_trace_details.');
  }

  console.error(`Fetching trace ${args.trace_id}`);
  const raw = await sentryClient.getTrace(args.trace_id, { statsPeriod: TRACE_STATS_PERIOD });
  const trace = normalizeTrace(raw);

  const maxSpans = args.max_spans ? Math.floor(args.max_spans) : DEFAULT_MAX_SPANS;
  const spans = trace.spans.slice(0, maxSpans);
  const capped = spans.length < trace.spans.length;

  let note: string | undefined;
  if (trace.source === 'unknown') {
    note = 'Unrecognized trace response shape; nothing could be extracted. Inspect it with raw_sentry_api.';
  } else if (trace.total_spans === 0 && trace.total_errors === 0) {
    note = `No spans or errors found for this trace in the last ${TRACE_STATS_PERIOD}. It may be older, mistyped, or the project may not send performance data.`;
  } else if (capped) {
    note = `Showing the first ${spans.length} of ${trace.total_spans} spans in tree order. Raise max_spans (up to 500) to see more.`;
  }

  return truncatedTextResult({
    trace_id: args.trace_id,
    source_endpoint: trace.source,
    stats_period: TRACE_STATS_PERIOD,
    start_timestamp: trace.start_timestamp,
    end_timestamp: trace.end_timestamp,
    duration_ms: trace.duration_ms,
    projects: trace.projects,
    total_spans: trace.total_spans,
    total_errors: trace.total_errors,
    returned_spans: spans.length,
    capped,
    spans,
    orphan_errors: trace.orphan_errors.length > 0 ? trace.orphan_errors : undefined,
    _note: note,
  });
}

export async function handleGetGroupingConfig(args: unknown): Promise<ToolResult> {
  if (!isValidGetGroupingConfigArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for get_grouping_config.');
  }

  console.error(`Fetching grouping info for issue ${args.issue_id}`);
  const [issue, event] = await Promise.all([
    sentryClient.getIssue(args.issue_id),
    sentryClient.getLatestEventForIssue(ORG_SLUG, args.issue_id),
  ]);

  const projectSlug = issueProjectSlug(issue);
  if (!projectSlug) {
    throw new Error(`Sentry did not report a project for issue ${args.issue_id}; cannot look up grouping info.`);
  }
  const eventId = str(event.eventID) ?? str(event.id);
  if (!eventId) {
    throw new Error(`Issue ${args.issue_id} has no latest event to explain grouping with.`);
  }

  const info = await sentryClient.getGroupingInfo(projectSlug, eventId);
  const { grouping_config, variants } = summarizeGroupingInfo(info);

  return truncatedTextResult({
    issue_id: str(issue.id) ?? args.issue_id,
    short_id: issue.shortId,
    project: projectSlug,
    event_id: eventId,
    grouping_config,
    contributing_variants: variants.filter(v => v.contributes).map(v => v.key),
    variants,
    explanation: 'Grouping breakdown of the issue\'s latest event. Each contributing variant produces a hash; an event joins this issue when one of its hashes matches the issue\'s hashes (see get_issue_hashes). Non-contributing variants were computed but ignored, usually for the reason in hint.',
  });
}

export async function handleMergeIssues(args: unknown): Promise<ToolResult> {
  if (!isValidMergeIssuesArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for merge_issues.');
  }

  const requested = [...new Set([args.issue_id, ...args.target_ids])];
  if (requested.length < 2) {
    throw new McpError(ErrorCode.InvalidParams, 'merge_issues needs at least one target_ids entry that differs from issue_id.');
  }

  // Resolve short IDs to numeric IDs and learn each issue's project
  const issues = await Promise.all(requested.map(id => sentryClient.getIssue(id)));
  const resolved = issues.map((issue, i) => ({
    input: requested[i],
    id: str(issue.id) ?? requested[i],
    shortId: issue.shortId,
    project: issueProjectSlug(issue),
  }));

  const unique = resolved.filter((issue, i) => resolved.findIndex(other => other.id === issue.id) === i);
  if (unique.length < 2) {
    throw new McpError(ErrorCode.InvalidParams, 'merge_issues: issue_id and target_ids all refer to the same issue; nothing to merge.');
  }

  const missingProject = unique.find(issue => !issue.project);
  if (missingProject) {
    // Sentry's answer, not the caller's input, is at fault: report it as a tool error.
    throw new Error(`merge_issues: Sentry did not report a project for issue ${missingProject.input}; nothing was merged.`);
  }

  const projects = [...new Set(unique.map(issue => issue.project!))];
  if (projects.length > 1) {
    const byProject = projects
      .map(project => `${project}: ${unique.filter(issue => issue.project === project).map(issue => issue.shortId ?? issue.id).join(', ')}`)
      .join('; ');
    throw new McpError(
      ErrorCode.InvalidParams,
      `merge_issues: the issues span ${projects.length} projects (${byProject}). Sentry only merges issues within one project.`
    );
  }

  const ids = unique.map(issue => issue.id);
  console.error(`Merging issues in project ${projects[0]}: ${ids.join(', ')}`);
  const response = await sentryClient.mergeIssues(projects[0], ids);
  const { merged, parent, children } = readMergeOutcome(response);
  const shortIdOf = (id?: string) => unique.find(issue => issue.id === id)?.shortId;

  if (!merged) {
    return truncatedTextResult({
      merged: false,
      project: projects[0],
      requested_issue_ids: ids,
      sentry_response: response === '' || response === undefined || response === null ? '(empty)' : response,
      explanation: 'Merge not confirmed — Sentry\'s response did not include a merge result (an empty response means it found none of the issues). Verify the issues in Sentry before relying on this.',
    });
  }

  return truncatedTextResult({
    merged: true,
    project: projects[0],
    parent,
    parent_short_id: shortIdOf(parent),
    children,
    children_short_ids: children?.map(shortIdOf),
    explanation: `Sentry kept ${shortIdOf(parent) ?? parent} as the parent (the issue first seen earliest)${parent !== unique[0].id ? ', not issue_id' : ''}; the children's events move into it. The merge finishes asynchronously in Sentry.`,
  });
}
