// Event-related MCP tools

import { sentryClient } from '../api/client.js';
import { ORG_SLUG } from '../config.js';
import {
  extractEssentialEventEntry,
  extractBreadcrumbTrail,
  compactContexts,
  isInAppFrame,
  selectRelevantThread,
} from '../helpers/extract.js';
import { truncatedTextResult } from './issues.js';
import type { SentryEventEntry, ToolDefinition, ToolResult } from '../api/types.js';
import type { SentryEvent } from '../api/client.js';
import {
  isValidGetEventArgs,
  isValidListIssueEventsArgs,
  isValidListErrorEventsArgs,
  isValidGetStackFramesArgs,
  isValidCheckDsymArgs,
  isValidListBreadcrumbsArgs,
} from '../helpers/index.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// ============================================================
// Tool Definitions
// ============================================================

export const get_sentry_event_details_tool: ToolDefinition = {
  name: 'get_sentry_event_details',
  description: 'Retrieve details for a specific event ID within a project. IMPORTANT: For large events, always use limit parameter (e.g., limit: 10) to avoid token limits.',
  inputSchema: {
    type: 'object',
    properties: {
      project_slug: { type: 'string', description: 'The slug of the project.' },
      event_id: { type: 'string', description: 'The ID of the event.' },
      limit: {
        type: 'number',
        description: 'RECOMMENDED: Limit entries returned (default: 5).',
        minimum: 1,
        default: 5,
      },
      offset: {
        type: 'number',
        description: 'Offset for pagination through event entries.',
        minimum: 0,
        default: 0,
      },
      entry_type: {
        type: 'string',
        description: "Filter to specific entry type ('exception', 'message', 'breadcrumbs', 'request', 'threads', 'debugmeta', 'contexts').",
        enum: ['exception', 'message', 'breadcrumbs', 'request', 'threads', 'debugmeta', 'contexts'],
      },
    },
    required: ['project_slug', 'event_id'],
  },
};

export const list_issue_events_tool: ToolDefinition = {
  name: 'list_issue_events',
  description: 'List all events for a specific issue. Useful to see all occurrences of an error over time.',
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'string', description: 'Numeric issue ID or short ID (e.g. PROJ-1A2).' },
      limit: { type: 'number', description: 'Max events (1-100, default: 25).', minimum: 1, maximum: 100 },
      cursor: { type: 'string', description: 'Pagination cursor.' },
      full: { type: 'boolean', description: 'Include full event details (default: false).', default: false },
    },
    required: ['issue_id'],
  },
};

export const list_error_events_tool: ToolDefinition = {
  name: 'list_error_events',
  description: 'List error events in a project. Search across all events without knowing the issue ID.',
  inputSchema: {
    type: 'object',
    properties: {
      project_slug: { type: 'string', description: 'The slug of the project.' },
      limit: { type: 'number', description: 'Max events (1-100, default: 25).', minimum: 1, maximum: 100 },
      cursor: { type: 'string', description: 'Pagination cursor.' },
      query: { type: 'string', description: 'Sentry search query.' },
      full: { type: 'boolean', description: 'Include full event details (default: false).', default: false },
    },
    required: ['project_slug'],
  },
};

export const get_stack_frames_tool: ToolDefinition = {
  name: 'get_stack_frames',
  description: 'Extract structured stack trace frames from an event. Optimized for debugging.',
  inputSchema: {
    type: 'object',
    properties: {
      project_slug: { type: 'string', description: 'The slug of the project.' },
      event_id: { type: 'string', description: 'The event ID.' },
      in_app_only: { type: 'boolean', description: 'Filter to only application frames (default: false).', default: false },
      max_frames: { type: 'number', description: 'Max frames to return (default: 50).', minimum: 1, maximum: 100, default: 50 },
    },
    required: ['project_slug', 'event_id'],
  },
};

export const check_dsym_status_tool: ToolDefinition = {
  name: 'check_dsym_status',
  description: 'Check if debug symbols (dSYM files) are missing for iOS/macOS crashes.',
  inputSchema: {
    type: 'object',
    properties: {
      project_slug: { type: 'string', description: 'Project slug.' },
      event_id: { type: 'string', description: 'Optional: Specific event ID.' },
    },
    required: ['project_slug'],
  },
};

export const list_breadcrumbs_tool: ToolDefinition = {
  name: 'list_breadcrumbs',
  description: 'Extract all breadcrumbs from an event, showing the trail of events leading up to an error.',
  inputSchema: {
    type: 'object',
    properties: {
      project_slug: { type: 'string', description: 'Project slug.' },
      event_id: { type: 'string', description: 'Event ID.' },
      limit: {
        type: 'number',
        description: 'Max breadcrumbs to return (1-100, default: 50).',
        minimum: 1,
        maximum: 100,
        default: 50,
      },
      type: {
        type: 'string',
        description: 'Filter by breadcrumb type (e.g., "default", "http", "navigation", "error").',
      },
    },
    required: ['project_slug', 'event_id'],
  },
};

// ============================================================
// Helpers
// ============================================================

type Rec = Record<string, unknown>;

const isRecord = (value: unknown): value is Rec =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Entry types shown first when no entry_type is requested
const PRIORITY_ENTRY_TYPES = ['exception', 'message', 'breadcrumbs', 'request'];

/** Priority entry types first (in priority order), then the rest in event order. */
function prioritizeEntries<T extends { type: string }>(entries: T[]): T[] {
  const rank = (type: string) => {
    const index = PRIORITY_ENTRY_TYPES.indexOf(type);
    return index === -1 ? PRIORITY_ENTRY_TYPES.length : index;
  };
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry.type) - rank(b.entry.type) || a.index - b.index)
    .map(({ entry }) => entry);
}

/**
 * Event tags as `{key, value}`. Sentry's event serializers return
 * `[{key, value}]`; raw event JSON uses `[key, value]` pairs. Accepts both.
 */
function compactTags(tags: unknown, max = 5): { key: unknown; value: unknown }[] | undefined {
  if (!Array.isArray(tags)) return undefined;
  return tags.slice(0, max).map(tag => {
    if (Array.isArray(tag)) return { key: tag[0], value: tag[1] };
    if (isRecord(tag)) return { key: tag.key, value: tag.value };
    return { key: tag, value: undefined };
  });
}

/**
 * Query params for a Sentry list endpoint. Sentry pages with `per_page`
 * (`limit` is ignored by these endpoints but kept for compatibility).
 */
function listParams(limit: number | undefined, cursor: string | undefined): Record<string, string | number | boolean> {
  const pageSize = limit ?? 25;
  const params: Record<string, string | number | boolean> = { limit: pageSize, per_page: pageSize };
  if (cursor) params.cursor = cursor;
  return params;
}

function compactEventSummary(event: SentryEvent): Record<string, unknown> {
  return {
    id: event.id,
    eventID: event.eventID,
    dateCreated: event.dateCreated,
    message: event.message || event.title,
    platform: event.platform,
    tags: compactTags(event.tags),
    user: event.user ? { id: event.user.id, email: event.user.email } : null,
  };
}

// ============================================================
// Tool Handlers
// ============================================================

export async function handleGetSentryEventDetails(args: unknown): Promise<ToolResult> {
  if (!isValidGetEventArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for get_sentry_event_details.');
  }

  console.error(`Fetching event ${args.event_id} for project ${args.project_slug}`);
  const eventData = await sentryClient.getEvent(ORG_SLUG, args.project_slug, args.event_id);
  const output: Rec = { ...eventData };

  const offset = args.offset ?? 0;
  const limit = args.limit ?? 5;

  if (Array.isArray(eventData.entries)) {
    const entries = eventData.entries;
    const totalEntries = entries.length;
    const availableTypes = [...new Set(entries.map((e) => e.type))];

    if (args.entry_type === 'contexts') {
      // Contexts (os, browser, runtime, trace, ...) are a top-level event field, not an entry.
      const contexts = compactContexts(eventData.contexts);
      output.entries = [];
      output.contexts = contexts;
      if (Object.keys(contexts).length === 0) output.entriesError = 'This event has no contexts.';
      output.pagination_info = {
        total_entries: totalEntries,
        showing: 0,
        available_types: availableTypes,
        tip: "Contexts are a top-level event field, returned under 'contexts' (scalar fields only).",
      };
    } else {
      const ordered = args.entry_type
        ? entries.filter((e) => e.type === args.entry_type)
        : prioritizeEntries(entries);
      const selected = ordered.slice(offset, offset + limit);

      if (args.entry_type && ordered.length === 0) {
        output.entriesError = `No entries of type '${args.entry_type}' found. Available types: ${availableTypes.join(', ')}`;
      } else if (selected.length === 0 && ordered.length > 0) {
        output.entriesError = `offset ${offset} is past the last of ${ordered.length} matching entries.`;
      }

      const extracted = selected.map(entry => extractEssentialEventEntry(entry));
      const nextOffset = offset + selected.length;
      output.entries = extracted;
      output.pagination_info = {
        total_entries: totalEntries,
        matching_entries: ordered.length,
        offset,
        showing: extracted.length,
        next_offset: selected.length > 0 && nextOffset < ordered.length ? nextOffset : undefined,
        entry_types: extracted.map((e) => (e as Rec).type),
        available_types: availableTypes,
        tip: args.entry_type
          ? `Showing only '${args.entry_type}' entries.`
          : "Showing prioritized entries. Use entry_type='exception' to see only stack traces, or entry_type='contexts' for os/browser/runtime contexts.",
      };
    }
  }

  // Remove large fields (contexts stay, in compact form, only when requested)
  const fieldsToRemove = ['sdk', 'packages', 'user', 'request', 'environment'];
  if (args.entry_type !== 'contexts') fieldsToRemove.push('contexts');
  for (const field of fieldsToRemove) {
    if (output[field]) {
      output[`_${field}_removed`] = true;
      delete output[field];
    }
  }

  return truncatedTextResult(output);
}

export async function handleListIssueEvents(args: unknown): Promise<ToolResult> {
  if (!isValidListIssueEventsArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for list_issue_events.');
  }

  const params = listParams(args.limit, args.cursor);
  if (args.full) params.full = args.full;

  console.error(`Listing events for issue ${args.issue_id}`);
  const page = await sentryClient.listIssueEvents(args.issue_id, params);
  const rawEvents = page.data;

  const eventData: unknown = !args.full && Array.isArray(rawEvents)
    ? rawEvents.map(compactEventSummary)
    : rawEvents;

  return truncatedTextResult(eventData, page);
}

export async function handleListErrorEvents(args: unknown): Promise<ToolResult> {
  if (!isValidListErrorEventsArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for list_error_events.');
  }

  const params = listParams(args.limit, args.cursor);
  if (args.query) params.query = args.query;
  if (args.full) params.full = args.full;

  console.error(`Listing error events for project ${args.project_slug}`);
  const page = await sentryClient.listProjectEvents(ORG_SLUG, args.project_slug, params);
  const rawEvents = page.data;

  const eventData: unknown = !args.full && Array.isArray(rawEvents)
    ? rawEvents.map((event: SentryEvent) => {
        const { id, eventID, dateCreated, message, platform, tags, user } = compactEventSummary(event);
        return { id, eventID, groupID: event.groupID, dateCreated, message, platform, type: event.type, tags, user };
      })
    : rawEvents;

  return truncatedTextResult(eventData, page);
}

function exceptionValues(entries: SentryEventEntry[]): Rec[] {
  const values: Rec[] = [];
  for (const entry of entries) {
    if (entry.type !== 'exception' || !isRecord(entry.data) || !Array.isArray(entry.data.values)) continue;
    values.push(...entry.data.values.filter(isRecord));
  }
  return values;
}

function framesOf(container: Rec | undefined): unknown[] {
  const stacktrace = container?.stacktrace;
  return isRecord(stacktrace) && Array.isArray(stacktrace.frames) ? stacktrace.frames : [];
}

/**
 * Raw frames from the exception stack traces; if none carry one (common for
 * native/Java crashes whose exception only references a thread), from the
 * referenced or crashing thread instead.
 */
function collectRawFrames(entries: SentryEventEntry[]): { frames: unknown[]; note?: string } {
  const exceptions = exceptionValues(entries);
  const frames = exceptions.flatMap(exc => framesOf(exc));
  if (frames.length > 0) return { frames };

  const threadsEntry = entries.find((e) => e.type === 'threads');
  const threadsData = threadsEntry?.data;
  const threads = isRecord(threadsData) && Array.isArray(threadsData.values)
    ? threadsData.values.filter(isRecord)
    : [];
  const threadId = exceptions.find(exc => exc.threadId !== undefined && exc.threadId !== null)?.threadId;
  const thread = (threadId !== undefined ? threads.find(t => t.id === threadId) : undefined)
    ?? selectRelevantThread(threads);
  const threadFrames = framesOf(thread);
  if (!thread || threadFrames.length === 0) return { frames: [] };

  const label = thread.crashed === true ? 'crashed' : thread.current === true ? 'current' : 'first';
  const name = thread.name ? `, "${String(thread.name)}"` : '';
  return {
    frames: threadFrames,
    note: `No exception stack trace; frames are from the ${label} thread (id ${String(thread.id)}${name}).`,
  };
}

export async function handleGetStackFrames(args: unknown): Promise<ToolResult> {
  if (!isValidGetStackFramesArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for get_stack_frames.');
  }

  console.error(`Extracting stack frames from event ${args.event_id}`);
  const eventData = await sentryClient.getEvent(ORG_SLUG, args.project_slug, args.event_id);

  const inAppOnly = args.in_app_only ?? false;
  const { frames: rawFrames, note } = collectRawFrames(Array.isArray(eventData.entries) ? eventData.entries : []);

  const frames: Record<string, unknown>[] = [];
  for (const f of rawFrames) {
    const frame = isRecord(f) ? f : {};
    const inApp = isInAppFrame(frame);
    if (inAppOnly && !inApp) continue;

    frames.push({
      function: frame.function || frame.rawFunction || '<unknown>',
      filename: frame.filename || frame.absPath || null,
      line_no: frame.lineNo ?? null,
      col_no: frame.colNo ?? null,
      in_app: inApp,
      module: frame.module ?? null,
      package: frame.package ?? null,
      instruction_addr: frame.instructionAddr ?? null,
      symbol_addr: frame.symbolAddr ?? null,
    });
  }

  const maxFrames = args.max_frames ?? 50;
  const limitedFrames = maxFrames > 0 ? frames.slice(-maxFrames) : [];

  return truncatedTextResult({
    event_id: args.event_id,
    total_frames: frames.length,
    returned_frames: limitedFrames.length,
    in_app_only: inAppOnly,
    frames: limitedFrames,
    _note: note,
  });
}

export async function handleCheckDsymStatus(args: unknown): Promise<ToolResult> {
  if (!isValidCheckDsymArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for check_dsym_status.');
  }

  console.error(`Checking dSYM status for project ${args.project_slug}`);
  let eventData: SentryEvent;

  if (args.event_id) {
    eventData = await sentryClient.getEvent(ORG_SLUG, args.project_slug, args.event_id);
  } else {
    const issuesResponse = (await sentryClient.listProjectIssues(ORG_SLUG, args.project_slug, { limit: 1 })).data;

    if (!issuesResponse || issuesResponse.length === 0) {
      return {
        content: [{ type: 'text', text: 'No recent issues found in project. Cannot check dSYM status.' }],
      };
    }

    const latestEvent = await sentryClient.getLatestEventForIssue(ORG_SLUG, issuesResponse[0].id);
    eventData = latestEvent as SentryEvent;
  }

  const missingDsyms: Record<string, unknown>[] = [];
  if (eventData.errors && Array.isArray(eventData.errors)) {
    for (const error of eventData.errors) {
      if (error.type === 'native_missing_dsym' || error.type === 'proguard_missing_mapping') {
        missingDsyms.push({
          type: error.type,
          message: error.message,
          image_path: error.data?.image_path,
          image_uuid: error.data?.image_uuid,
          image_name: error.data?.image_name,
        });
      }
    }
  }

  const hasMissingSymbols = missingDsyms.length > 0;

  return truncatedTextResult({
    project: args.project_slug,
    event_id: eventData.eventID || args.event_id,
    has_missing_symbols: hasMissingSymbols,
    missing_count: missingDsyms.length,
    missing_symbols: missingDsyms,
    recommendation: hasMissingSymbols
      ? "Upload missing dSYM files to Sentry to see full function names. Use 'sentry-cli upload-dif' command."
      : 'All debug symbols are present for this event.',
  });
}

export async function handleListBreadcrumbs(args: unknown): Promise<ToolResult> {
  if (!isValidListBreadcrumbsArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for list_breadcrumbs.');
  }

  console.error(`Extracting breadcrumbs from event ${args.event_id}`);
  const eventData = await sentryClient.getEvent(ORG_SLUG, args.project_slug, args.event_id);

  const limit = args.limit ?? 50;
  const { total, breadcrumbs } = extractBreadcrumbTrail(eventData, limit, args.type);

  return truncatedTextResult({
    event_id: args.event_id,
    total_breadcrumbs: total,
    returned_breadcrumbs: breadcrumbs.length,
    type_filter: args.type || 'all',
    breadcrumbs,
    _note: breadcrumbs.length < total
      ? `Showing the ${breadcrumbs.length} most recent of ${total} breadcrumbs (oldest first).`
      : undefined,
  });
}

