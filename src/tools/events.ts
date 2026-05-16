// Event-related MCP tools

import { sentryClient } from '../api/client.js';
import { ORG_SLUG } from '../config.js';
import { truncateResponse, truncateStackTraces } from '../helpers/truncate.js';
import { filterObjectFields } from '../helpers/filter.js';
import { extractEssentialEventEntry, extractBreadcrumbs } from '../helpers/extract.js';
import { grepFilter } from '../helpers/grep.js';
import type { ToolDefinition, ToolResult } from '../api/types.js';
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
      issue_id: { type: 'string', description: 'The ID of the issue.' },
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
// Tool Handlers
// ============================================================

export async function handleGetSentryEventDetails(args: unknown): Promise<ToolResult> {
  if (!isValidGetEventArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for get_sentry_event_details.');
  }

  console.error(`Fetching event ${args.event_id} for project ${args.project_slug}`);
  const eventData = await sentryClient.getEvent(ORG_SLUG, args.project_slug, args.event_id);

  const offset = args.offset || 0;
  const limit = args.limit || 5;

  if (eventData.entries && Array.isArray(eventData.entries)) {
    const totalEntries = eventData.entries.length;
    let selectedEntries: SentryEvent['entries'] = [];

    if (args.entry_type) {
      selectedEntries = eventData.entries
        .filter((e) => e.type === args.entry_type)
        .slice(offset, offset + limit);

      if (selectedEntries.length === 0) {
        eventData.entries = [];
        eventData.entriesError = `No entries of type '${args.entry_type}' found. Available types: ${[...new Set(eventData.entries.map((e) => e.type))].join(', ')}`;
      }
    } else {
      const priorityTypes = ['exception', 'message', 'breadcrumbs', 'request'];
      const importantEntries: SentryEvent['entries'] = [];

      for (const type of priorityTypes) {
        const entry = eventData.entries.find((e) => e.type === type);
        if (entry && importantEntries.length < limit) {
          importantEntries.push(entry);
        }
      }

      if (importantEntries.length < limit) {
        const otherEntries = eventData.entries
          .filter((e) => !priorityTypes.includes(e.type))
          .slice(0, limit - importantEntries.length);
        importantEntries.push(...otherEntries);
      }

      selectedEntries = importantEntries;
    }

    const extractedEntries = selectedEntries.map(extractEssentialEventEntry);
    eventData.entries = extractedEntries as SentryEvent['entries'];
    (eventData as Record<string, unknown>).pagination_info = {
      total_entries: totalEntries,
      showing: extractedEntries.length,
      entry_types: extractedEntries.map((e) => (e as Record<string, unknown>).type),
      available_types: [...new Set(selectedEntries.map((e) => e.type))],
      tip: args.entry_type
        ? `Showing only '${args.entry_type}' entries.`
        : "Showing prioritized entries. Use entry_type='exception' to see only stack traces.",
    };
  }

  // Remove large fields
  const fieldsToRemove = ['sdk', 'packages', 'contexts', 'user', 'request', 'environment'];
  for (const field of fieldsToRemove) {
    if ((eventData as Record<string, unknown>)[field]) {
      (eventData as Record<string, unknown>)[`_${field}_removed`] = true;
      delete (eventData as Record<string, unknown>)[field];
    }
  }

  const { data, truncated, pagination_info } = truncateResponse(eventData);
  let resultText = JSON.stringify(data, null, 2);
  if (truncated && pagination_info) {
    resultText = `${pagination_info}\n\n${resultText}`;
  }

  return { content: [{ type: 'text', text: resultText }] };
}

export async function handleListIssueEvents(args: unknown): Promise<ToolResult> {
  if (!isValidListIssueEventsArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for list_issue_events.');
  }

  const params: Record<string, string | number | boolean> = {};
  if (args.limit) params.limit = args.limit;
  if (args.cursor) params.cursor = args.cursor;
  if (args.full) params.full = args.full;
  if (!params.limit) params.limit = 25;

  console.error(`Listing events for issue ${args.issue_id}`);
  const rawEvents = await sentryClient.listIssueEvents(args.issue_id, params);

  let eventData: unknown = rawEvents;
  if (!args.full && Array.isArray(rawEvents)) {
    eventData = rawEvents.map((event: SentryEvent) => ({
      id: event.id,
      eventID: event.eventID,
      dateCreated: event.dateCreated,
      message: event.message || event.title,
      platform: event.platform,
      tags: (event.tags as [string, string][])?.slice(0, 5),
      user: event.user ? { id: event.user.id, email: event.user.email } : null,
    }));
  }

  const { data, truncated, pagination_info } = truncateResponse(eventData);
  let resultText = JSON.stringify(data, null, 2);
  if (truncated && pagination_info) {
    resultText = `${pagination_info}\n\n${resultText}`;
  }

  return { content: [{ type: 'text', text: resultText }] };
}

export async function handleListErrorEvents(args: unknown): Promise<ToolResult> {
  if (!isValidListErrorEventsArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for list_error_events.');
  }

  const params: Record<string, string | number | boolean> = {};
  if (args.limit) params.limit = args.limit;
  if (args.cursor) params.cursor = args.cursor;
  if (args.query) params.query = args.query;
  if (args.full) params.full = args.full;
  if (!params.limit) params.limit = 25;

  console.error(`Listing error events for project ${args.project_slug}`);
  const rawEvents = await sentryClient.listProjectEvents(ORG_SLUG, args.project_slug, params);

  let eventData: unknown = rawEvents;
  if (!args.full && Array.isArray(rawEvents)) {
    eventData = rawEvents.map((event: SentryEvent) => ({
      id: event.id,
      eventID: event.eventID,
      groupID: event.groupID,
      dateCreated: event.dateCreated,
      message: event.message || event.title,
      platform: event.platform,
      type: event.type,
      tags: (event.tags as [string, string][])?.slice(0, 5),
      user: event.user ? { id: event.user.id, email: event.user.email } : null,
    }));
  }

  const { data, truncated, pagination_info } = truncateResponse(eventData);
  let resultText = JSON.stringify(data, null, 2);
  if (truncated && pagination_info) {
    resultText = `${pagination_info}\n\n${resultText}`;
  }

  return { content: [{ type: 'text', text: resultText }] };
}

export async function handleGetStackFrames(args: unknown): Promise<ToolResult> {
  if (!isValidGetStackFramesArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for get_stack_frames.');
  }

  console.error(`Extracting stack frames from event ${args.event_id}`);
  const eventData = await sentryClient.getEvent(ORG_SLUG, args.project_slug, args.event_id);

  const frames: Record<string, unknown>[] = [];

  if (eventData.entries && Array.isArray(eventData.entries)) {
    for (const entry of eventData.entries) {
      if (entry.type === 'exception') {
        const data = entry.data as Record<string, unknown> | undefined;
        if (data?.values) {
          const values = data.values as unknown[];
          for (const exc of values) {
            const excData = exc as Record<string, unknown>;
            const stacktrace = excData.stacktrace as Record<string, unknown> | undefined;
            if (stacktrace?.frames) {
              const frameList = stacktrace.frames as unknown[];
              for (const f of frameList) {
                const frame = f as Record<string, unknown>;
                if (args.in_app_only && !frame.in_app) continue;

                frames.push({
                  function: frame.function || frame.rawFunction || '<unknown>',
                  filename: frame.filename || frame.absPath || null,
                  line_no: frame.lineNo || null,
                  col_no: frame.colNo || null,
                  in_app: frame.in_app || false,
                  module: frame.module || null,
                  package: frame.package || null,
                  instruction_addr: frame.instructionAddr || null,
                  symbol_addr: frame.symbolAddr || null,
                });
              }
            }
          }
        }
      }
    }
  }

  const maxFrames = args.max_frames || 50;
  const limitedFrames = frames.slice(-maxFrames);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        event_id: args.event_id,
        total_frames: frames.length,
        returned_frames: limitedFrames.length,
        in_app_only: args.in_app_only || false,
        frames: limitedFrames,
      }, null, 2),
    }],
  };
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
    const issuesResponse = await sentryClient.listProjectIssues(ORG_SLUG, args.project_slug, { limit: 1 });

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

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        project: args.project_slug,
        event_id: eventData.eventID || args.event_id,
        has_missing_symbols: hasMissingSymbols,
        missing_count: missingDsyms.length,
        missing_symbols: missingDsyms,
        recommendation: hasMissingSymbols
          ? "Upload missing dSYM files to Sentry to see full function names. Use 'sentry-cli upload-dif' command."
          : 'All debug symbols are present for this event.',
      }, null, 2),
    }],
  };
}

export async function handleListBreadcrumbs(args: unknown): Promise<ToolResult> {
  if (!isValidListBreadcrumbsArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for list_breadcrumbs.');
  }

  console.error(`Extracting breadcrumbs from event ${args.event_id}`);
  const eventData = await sentryClient.getEvent(ORG_SLUG, args.project_slug, args.event_id);

  const limit = args.limit || 50;
  const breadcrumbs = extractBreadcrumbs(eventData, limit, args.type);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        event_id: args.event_id,
        total_breadcrumbs: breadcrumbs.length,
        returned_breadcrumbs: breadcrumbs.length,
        type_filter: args.type || 'all',
        breadcrumbs,
      }, null, 2),
    }],
  };
}
