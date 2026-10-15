// Issue-related MCP tools

import { AxiosError } from 'axios';
import { sentryClient } from '../api/client.js';
import { ORG_SLUG } from '../config.js';
import { truncateResponse } from '../helpers/truncate.js';
import type { PageInfo } from '../helpers/pagination.js';
import { filterObjectFields } from '../helpers/filter.js';
import { extractEssentialIssueFields, extractEssentialEventEntry } from '../helpers/extract.js';
import { grepFilter, estimateTokens, generateGrepSuggestions } from '../helpers/grep.js';
import type { ToolResult, ToolDefinition } from '../api/types.js';
import type { SentryEvent } from '../api/client.js';
import {
  isIssueId,
  isValidGetIssueArgs,
  isValidListProjectsArgs,
  isValidListIssuesArgs,
  isValidSearchIssuesArgs,
  isValidUpdateIssueArgs,
  isValidCreateCommentArgs,
  isValidGetIssueHashesArgs,
  isValidBulkUpdateArgs,
} from '../helpers/index.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// Innermost frames kept per exception when the caller does not ask for more
const DEFAULT_STACK_FRAMES = 5;
// Hashes per page; passed to Sentry so the page and its cursor stay aligned
const HASHES_PER_PAGE = 25;

// ============================================================
// Tool Definitions
// ============================================================

export const get_sentry_issue_tool: ToolDefinition = {
  name: 'get_sentry_issue',
  description: 'Retrieve a Sentry issue by numeric ID, short ID (e.g. PROJ-1A2) or issue URL. Returns essential issue fields only; the stacktrace is NOT included unless include_latest_event is true, which adds the latest event\'s exception (innermost max_stack_frames frames per exception), message and recent breadcrumbs. Supports field filtering, grep and automatic truncation.',
  inputSchema: {
    type: 'object',
    properties: {
      issue_id_or_url: {
        type: 'string',
        description: 'Numeric issue ID or short ID (e.g. PROJ-1A2), or a full Sentry issue URL.',
      },
      include_latest_event: {
        type: 'boolean',
        description: 'Also fetch the latest event (exception with stack frames, message, recent breadcrumbs). Default: false, so no stacktrace is returned.',
        default: false,
      },
      include_fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional: List of fields to include (whitelist). Use dot notation for nested fields (e.g., "latest_event.entries").',
      },
      exclude_fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional: List of fields to exclude (blacklist). Use dot notation for nested fields.',
      },
      grep_pattern: {
        type: 'string',
        description: 'Optional: Regex pattern to filter response content.',
      },
      max_stack_frames: {
        type: 'number',
        description: 'Optional: Innermost stack frames kept per exception in latest_event (default: 5). Only applies with include_latest_event.',
      },
    },
    required: ['issue_id_or_url'],
  },
};

export const list_sentry_projects_tool: ToolDefinition = {
  name: 'list_sentry_projects',
  description: 'List projects in the configured Sentry organization (essential fields only). When more projects exist, the result carries a next_cursor; pass it as cursor to get the next page.',
  inputSchema: {
    type: 'object',
    properties: {
      cursor: { type: 'string', description: 'Optional: pagination cursor (next_cursor from a previous call).' },
    },
    required: [],
  },
};

export const list_sentry_issues_tool: ToolDefinition = {
  name: 'list_sentry_issues',
  description: 'List issues for a specific project, optionally filtering by query or status. Supports pagination.',
  inputSchema: {
    type: 'object',
    properties: {
      project_slug: { type: 'string', description: 'The slug of the project.' },
      query: { type: 'string', description: 'Optional Sentry search query.' },
      status: { type: 'string', enum: ['resolved', 'unresolved', 'ignored'], description: 'Filter by status.' },
      limit: { type: 'number', description: 'Max issues (1-100, default: 25).', minimum: 1, maximum: 100 },
      cursor: { type: 'string', description: 'Pagination cursor (next_cursor from a previous call).' },
    },
    required: ['project_slug'],
  },
};

export const list_issues_tool: ToolDefinition = {
  name: 'list_issues',
  description: 'List issues using Sentry search query syntax (e.g., "is:unresolved environment:production"). More powerful than list_sentry_issues which is project-scoped.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Sentry search query (e.g., "is:unresolved environment:production level:error").',
      },
      sort: {
        type: 'string',
        enum: ['date', 'priority', 'freq', 'user'],
        description: 'Sort order (default: date).',
        default: 'date',
      },
      limit: {
        type: 'number',
        description: 'Max issues (1-100, default: 25).',
        minimum: 1,
        maximum: 100,
      },
      cursor: { type: 'string', description: 'Pagination cursor (next_cursor from a previous call).' },
    },
    required: [],
  },
};

export const update_sentry_issue_status_tool: ToolDefinition = {
  name: 'update_sentry_issue_status',
  description: 'Update the status of a Sentry issue. Returns the issue id, short ID, title and new status.',
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'string', description: 'Numeric issue ID or short ID (e.g. PROJ-1A2)' },
      status: { type: 'string', enum: ['resolved', 'ignored', 'unresolved'], description: 'New status.' },
    },
    required: ['issue_id', 'status'],
  },
};

export const create_sentry_issue_comment_tool: ToolDefinition = {
  name: 'create_sentry_issue_comment',
  description: 'Add a comment to a Sentry issue. Returns the new comment id.',
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'string', description: 'Numeric issue ID or short ID (e.g. PROJ-1A2)' },
      comment_text: { type: 'string', description: 'Comment text.' },
    },
    required: ['issue_id', 'comment_text'],
  },
};

export const get_issue_hashes_tool: ToolDefinition = {
  name: 'get_issue_hashes',
  description: 'Get the fingerprint hashes for an issue (25 per page). Useful for understanding why events are grouped together. Paginate with cursor.',
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'string', description: 'Numeric issue ID or short ID (e.g. PROJ-1A2)' },
      cursor: { type: 'string', description: 'Pagination cursor (next_cursor from a previous call).' },
    },
    required: ['issue_id'],
  },
};

export const bulk_update_issues_tool: ToolDefinition = {
  name: 'bulk_update_issues',
  description: 'Bulk update issues in one project (resolve, ignore, unresolve, assign, mark seen). '
    + 'Scope: exactly one of issue_ids or query is required. issue_ids changes only those issues; '
    + 'query changes EVERY issue in the project that matches the Sentry search (up to 1000 per call). '
    + 'A call with neither is refused, because Sentry would otherwise change every unresolved issue in the project.',
  inputSchema: {
    type: 'object',
    properties: {
      project_slug: { type: 'string', description: 'Project slug.' },
      query: {
        type: 'string',
        description: 'Sentry search query selecting the issues to change (e.g., "is:unresolved environment:staging"). Every matching issue in the project is changed. Use either query or issue_ids.',
      },
      issue_ids: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 100,
        description: 'Numeric issue IDs to change (1-100). Only these issues are changed. Use either issue_ids or query.',
      },
      status: {
        type: 'string',
        enum: ['resolved', 'ignored', 'unresolved'],
        description: 'New status.',
      },
      assigned_to: { type: 'string', description: 'Team or user to assign to.' },
      has_seen: { type: 'boolean', description: 'Mark issues as seen.' },
    },
    required: ['project_slug'],
  },
};

// ============================================================
// Utility Functions
// ============================================================

/**
 * Resolve tool input to an identifier Sentry's organization issue endpoints accept:
 * a numeric ID, a short ID (`WEB-1A3`), or the ID in a Sentry issue URL such as
 * `https://sentry.example.com/organizations/acme/issues/123/?project=4`.
 */
export const getIssueId = (input: string): string | null => {
  const value = input.trim();
  if (!value) return null;
  if (isIssueId(value)) return value;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const segments = url.pathname.split('/').filter(Boolean);
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i] === 'issues' && isIssueId(segments[i + 1])) return segments[i + 1];
  }
  return null;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const extractEssentialHash = (hash: unknown): unknown => {
  if (typeof hash === 'string') return { id: hash };
  if (!hash || typeof hash !== 'object') return { _truncated: true };

  const h = hash as Record<string, unknown>;
  const latestEvent = h.latestEvent as Record<string, unknown> | undefined;
  return {
    id: h.id,
    latestEvent: latestEvent ? {
      id: latestEvent.id,
      eventID: latestEvent.eventID,
      dateCreated: latestEvent.dateCreated,
      message: latestEvent.message || latestEvent.title,
    } : undefined,
  };
};

/**
 * Serialize a payload as tool text, prepending the truncation note when one applies.
 * When another page exists, its cursor goes in a second content block so the
 * first block keeps its existing shape for callers that parse it.
 */
export function truncatedTextResult(payload: unknown, page?: PageInfo): ToolResult {
  const { data, truncated, pagination_info } = truncateResponse(payload);
  let resultText = JSON.stringify(data, null, 2);
  if (truncated && pagination_info) {
    resultText = `${pagination_info}\n\n${resultText}`;
  }

  const content: ToolResult['content'] = [{ type: 'text', text: resultText }];
  if (page?.hasMore && page.nextCursor) {
    content.push({
      type: 'text',
      text: JSON.stringify({
        next_cursor: page.nextCursor,
        has_more: true,
        hint: 'More results exist. Call this tool again with cursor set to next_cursor.',
      }),
    });
  }

  return { content };
}

// Sentry error bodies can be whole HTML pages from a proxy; keep messages short.
const MAX_ERROR_BODY_CHARS = 500;

const capText = (text: string, max = MAX_ERROR_BODY_CHARS): string =>
  text.length > max ? `${text.slice(0, max)}...[truncated ${text.length - max} chars]` : text;

/** Sentry's own explanation (`{"detail": "..."}`), when the body carries one. */
const sentryDetail = (data: unknown): string | undefined => {
  const detail = asRecord(data)?.detail;
  if (typeof detail === 'string' && detail.trim()) return capText(detail.trim());
  if (Array.isArray(detail) && detail.length > 0 && detail.every(item => typeof item === 'string')) {
    return capText(detail.join('; '));
  }
  return undefined;
};

const bodySnippet = (data: unknown): string => {
  if (data === undefined || data === null || data === '') return '(empty)';
  let text: string;
  try {
    text = typeof data === 'string' ? data : JSON.stringify(data);
  } catch {
    text = String(data);
  }
  return capText(text);
};

const retryAfter = (error: AxiosError): string | undefined => {
  const headers = error.response?.headers as Record<string, unknown> | undefined;
  const value = headers?.['retry-after'];
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value).trim();
  // Delta-seconds or an HTTP date; anything else is not worth echoing back.
  return /^[\w ,:+-]{1,64}$/.test(text) ? text : undefined;
};

/**
 * Turn an Axios failure into a tool error message. Built only from the status,
 * Sentry's response body and axios' own message — never from the request
 * config — so the Authorization header cannot leak into it.
 */
const mapAxiosError = (error: AxiosError, toolName: string): string => {
  if (!error.response) {
    return `Sentry API error for ${toolName}: ${error.message}`;
  }

  const { status, data } = error.response;
  const detail = sentryDetail(data);
  const said = detail ? ` Sentry said: ${detail}` : '';

  if (status === 401 || status === 403) {
    return `Sentry API permission denied for ${toolName} (HTTP ${status}). Check auth token validity and its scopes.${said}`;
  }
  if (status === 404) {
    return `Sentry resource not found for ${toolName} (HTTP 404). Check IDs/slugs: verify the issue ID or short ID, event ID or project slug — list_sentry_projects lists project slugs and list_issues finds issues.${said}`;
  }
  if (status === 429) {
    const after = retryAfter(error);
    const wait = after ? ` Retry-After: ${after} — wait that long before retrying.` : ' Wait before retrying.';
    return `Sentry API rate limit hit for ${toolName} (HTTP 429).${wait}${said}`;
  }
  return `Sentry API error for ${toolName}: ${error.message}. Status: ${status}. Response: ${detail ?? bodySnippet(data)}`;
};

/** Latest event reduced to what helps debugging; never the raw event. */
const compactLatestEvent = (event: SentryEvent, maxFrames: number): Record<string, unknown> => {
  const base = {
    id: event.id,
    eventID: event.eventID,
    dateCreated: event.dateCreated,
    title: event.title,
  };
  if (!Array.isArray(event.entries)) {
    return { ...base, message: event.message };
  }

  const entries: unknown[] = [];
  const omitted: string[] = [];
  for (const entry of event.entries) {
    const compact = extractEssentialEventEntry(entry, { maxFrames });
    if (asRecord(compact)?._truncated) {
      omitted.push(String(entry?.type ?? 'unknown'));
    } else {
      entries.push(compact);
    }
  }

  return {
    ...base,
    entries,
    omitted_entry_types: omitted.length > 0 ? omitted : undefined,
    _note: 'Event condensed. Use get_sentry_event_details for full event data.',
  };
};

// ============================================================
// Tool Handlers
// ============================================================

export async function handleGetSentryIssue(args: unknown): Promise<ToolResult> {
  if (!isValidGetIssueArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for get_sentry_issue.');
  }

  const issueId = getIssueId(args.issue_id_or_url);
  if (!issueId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Could not extract an issue ID from: ${args.issue_id_or_url.slice(0, 200)}. Pass a numeric ID, a short ID like PROJ-1A2, or a Sentry issue URL.`
    );
  }

  const maxFrames = args.max_stack_frames !== undefined && args.max_stack_frames >= 1
    ? Math.floor(args.max_stack_frames)
    : DEFAULT_STACK_FRAMES;

  console.error(`Fetching Sentry issue ${issueId}`);

  // Both requests start together. The event promise is settled into a value
  // up front, so an issue failure never leaves it as an unhandled rejection.
  const issuePromise = sentryClient.getIssue(issueId);
  const eventPromise = args.include_latest_event
    ? sentryClient.getLatestEventForIssue(ORG_SLUG, issueId).then(
      event => ({ ok: true as const, event }),
      (error: unknown) => ({ ok: false as const, error })
    )
    : undefined;

  const issueResponse = await issuePromise;
  let combinedData: Record<string, unknown> = { ...extractEssentialIssueFields(issueResponse), latest_event: null };

  if (eventPromise) {
    const outcome = await eventPromise;
    if (outcome.ok) {
      combinedData.latest_event = compactLatestEvent(outcome.event, maxFrames);
    } else {
      const message = errorMessage(outcome.error);
      console.warn(`Could not fetch latest event for issue ${issueId}. ${message}`);
      combinedData.latest_event_error = message;
    }
  }

  if (args.include_fields || args.exclude_fields) {
    combinedData = filterObjectFields(combinedData, args.include_fields, args.exclude_fields) as Record<string, unknown>;
  }

  if (args.grep_pattern) {
    combinedData = grepFilter(combinedData, args.grep_pattern) as Record<string, unknown>;
  }

  return truncatedTextResult(combinedData);
}

/**
 * `args` is optional because older dispatchers call this handler with no
 * arguments; without them only the first page can be listed.
 */
export async function handleListSentryProjects(args?: unknown): Promise<ToolResult> {
  const input = args ?? {};
  if (!isValidListProjectsArgs(input)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for list_sentry_projects.');
  }

  console.error(`Fetching projects for org ${ORG_SLUG}`);
  const page = await sentryClient.listProjects(ORG_SLUG, input.cursor ? { cursor: input.cursor } : undefined);
  const raw = Array.isArray(page.data) ? page.data : [];

  const projects = raw.map(project => ({
    id: project.id,
    slug: project.slug,
    name: project.name,
    platform: project.platform,
    dateCreated: project.dateCreated,
    firstEvent: project.firstEvent,
    teams: project.teams?.map(team => team.slug),
  }));

  return truncatedTextResult({
    returned_projects: projects.length,
    has_more: page.hasMore,
    projects,
  }, page);
}

export async function handleListSentryIssues(args: unknown): Promise<ToolResult> {
  if (!isValidListIssuesArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for list_sentry_issues.');
  }

  const params: Record<string, string | number> = {};
  if (args.query) params.query = args.query;
  if (args.status) params.query = `${params.query || ''} is:${args.status}`.trim();
  if (args.limit !== undefined) params.limit = args.limit;
  if (args.cursor) params.cursor = args.cursor;
  if (params.limit === undefined) params.limit = 25;

  console.error(`Fetching issues for project ${args.project_slug} in org ${ORG_SLUG}`);
  const page = await sentryClient.listProjectIssues(ORG_SLUG, args.project_slug, params);

  return truncatedTextResult(page.data, page);
}

export async function handleListIssues(args: unknown): Promise<ToolResult> {
  if (!isValidSearchIssuesArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for list_issues.');
  }

  const params: Record<string, string | number> = {};
  if (args.query) params.query = args.query;
  if (args.sort) params.sort = args.sort;
  if (args.limit !== undefined) params.limit = args.limit;
  if (args.cursor) params.cursor = args.cursor;
  if (params.limit === undefined) params.limit = 25;

  console.error(`Searching issues in org ${ORG_SLUG} with query: ${args.query || '(none)'}`);
  const page = await sentryClient.searchIssues(ORG_SLUG, params);

  return truncatedTextResult(page.data, page);
}

export async function handleUpdateIssueStatus(args: unknown): Promise<ToolResult> {
  if (!isValidUpdateIssueArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for update_sentry_issue_status.');
  }

  console.error(`Updating issue ${args.issue_id} status to ${args.status}`);
  const response = asRecord(await sentryClient.updateIssue(args.issue_id, { status: args.status })) ?? {};

  return truncatedTextResult({
    updated: true,
    id: response.id ?? args.issue_id,
    shortId: response.shortId,
    title: response.title,
    status: response.status ?? args.status,
    substatus: response.substatus,
  });
}

export async function handleCreateComment(args: unknown): Promise<ToolResult> {
  if (!isValidCreateCommentArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for create_sentry_issue_comment.');
  }

  console.error(`Adding comment to issue ${args.issue_id}`);
  const response = asRecord(await sentryClient.createIssueComment(args.issue_id, args.comment_text)) ?? {};

  return truncatedTextResult({
    created: response.id !== undefined,
    comment_id: response.id,
    issue_id: args.issue_id,
    dateCreated: response.dateCreated,
  });
}

export async function handleGetIssueHashes(args: unknown): Promise<ToolResult> {
  if (!isValidGetIssueHashesArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for get_issue_hashes.');
  }

  const params: Record<string, string | number> = { per_page: HASHES_PER_PAGE };
  if (args.cursor) params.cursor = args.cursor;

  console.error(`Getting hashes for issue ${args.issue_id}`);
  const page = await sentryClient.getIssueHashes(args.issue_id, params);

  const rawHashes: unknown[] = Array.isArray(page.data) ? page.data : [];
  const hashes = rawHashes.map(extractEssentialHash);

  return truncatedTextResult({
    issue_id: args.issue_id,
    returned_hashes: hashes.length,
    has_more: page.hasMore,
    hashes,
    explanation: 'Hashes represent fingerprints used to group events. Events with matching hashes are grouped into the same issue.',
  }, page);
}

export async function handleBulkUpdateIssues(args: unknown): Promise<ToolResult> {
  if (!isValidBulkUpdateArgs(args)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Invalid args for bulk_update_issues. project_slug must be a slug; issue_ids, if given, must be 1-100 numeric issue IDs.'
    );
  }

  const query = args.query?.trim() ?? '';
  const issueIds = [...new Set(args.issue_ids ?? [])];

  if (!query && issueIds.length === 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'bulk_update_issues needs a selection: pass issue_ids (numeric issue IDs) or a non-empty query. '
      + 'Without one, Sentry applies the change to every unresolved issue in the project, so the call was refused.'
    );
  }
  if (query && issueIds.length > 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'bulk_update_issues takes either issue_ids or query, not both: Sentry ignores query when issue IDs are given. '
      + 'Drop one of them so the scope is unambiguous.'
    );
  }

  const body: Record<string, unknown> = {};
  if (args.status) body.status = args.status;
  if (args.assigned_to) body.assignedTo = args.assigned_to;
  if (args.has_seen !== undefined) body.hasSeen = args.has_seen;

  if (Object.keys(body).length === 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'bulk_update_issues has nothing to change: pass at least one of status, assigned_to or has_seen.'
    );
  }

  const selection = issueIds.length > 0 ? { issue_ids: issueIds } : { query };
  console.error(`Bulk updating issues in project ${args.project_slug}`);
  const response = await sentryClient.bulkUpdateProjectIssues(
    ORG_SLUG,
    args.project_slug,
    issueIds.length > 0 ? { ids: issueIds } : { query },
    body
  );

  // Sentry answers 204 with an empty body when the selection matched nothing.
  const result = asRecord(response);
  if (!result) {
    return truncatedTextResult({
      updated: false,
      project_slug: args.project_slug,
      selection,
      requested: body,
      _note: 'Sentry reported no matching issues; nothing was changed.',
    });
  }

  return truncatedTextResult({
    updated: true,
    project_slug: args.project_slug,
    selection,
    requested: body,
    applied: {
      status: result.status,
      statusDetails: result.statusDetails,
      assignedTo: result.assignedTo,
      hasSeen: result.hasSeen,
    },
    _note: issueIds.length > 0
      ? 'Applied to the listed issues that exist in this project.'
      : 'Applied to every issue in the project matching the query (Sentry caps one call at 1000 issues). Sentry does not report a count.',
  });
}

// ============================================================
// Error Handler
// ============================================================

export function handleToolError(error: unknown, toolName: string): ToolResult {
  console.error(`Error calling tool ${toolName}: ${errorMessage(error)}`);

  if (error instanceof McpError) {
    throw error;
  }

  let message = `Failed to execute tool ${toolName}.`;

  if (error instanceof AxiosError) {
    message = mapAxiosError(error, toolName);
  } else if (error instanceof Error) {
    message = error.message;
  }

  return { content: [{ type: 'text', text: message }], isError: true };
}

// Export grep utilities for raw_sentry_api
export { estimateTokens, generateGrepSuggestions };
