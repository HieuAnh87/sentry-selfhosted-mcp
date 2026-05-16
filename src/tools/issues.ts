// Issue-related MCP tools

import { AxiosError } from 'axios';
import { sentryClient } from '../api/client.js';
import { ORG_SLUG } from '../config.js';
import { truncateResponse } from '../helpers/truncate.js';
import { filterObjectFields } from '../helpers/filter.js';
import { extractEssentialIssueFields, extractEssentialEventEntry } from '../helpers/extract.js';
import { grepFilter, estimateTokens, generateGrepSuggestions } from '../helpers/grep.js';
import { truncateStackTraces } from '../helpers/truncate.js';
import type { ToolResult, ToolDefinition } from '../api/types.js';
import type { SentryEvent } from '../api/client.js';
import {
  isValidGetIssueArgs,
  isValidListIssuesArgs,
  isValidSearchIssuesArgs,
  isValidUpdateIssueArgs,
  isValidCreateCommentArgs,
  isValidGetIssueHashesArgs,
  isValidBulkUpdateArgs,
} from '../helpers/index.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// ============================================================
// Tool Definitions
// ============================================================

export const get_sentry_issue_tool: ToolDefinition = {
  name: 'get_sentry_issue',
  description: 'Retrieve details for a specific Sentry issue by ID or URL, including the stacktrace from the latest event. Supports filtering and automatic truncation to reduce response size.',
  inputSchema: {
    type: 'object',
    properties: {
      issue_id_or_url: {
        type: 'string',
        description: 'Sentry issue ID or full issue URL. Issue ID is a number e.g: 123456',
      },
      include_latest_event: {
        type: 'boolean',
        description: 'Include latest event details (default: false to reduce response size)',
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
        description: 'Optional: Maximum number of stack trace frames to return (default: all).',
      },
    },
    required: ['issue_id_or_url'],
  },
};

export const list_sentry_projects_tool: ToolDefinition = {
  name: 'list_sentry_projects',
  description: 'List all projects within the configured Sentry organization.',
  inputSchema: {
    type: 'object',
    properties: {},
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
      cursor: { type: 'string', description: 'Pagination cursor.' },
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
      cursor: { type: 'string', description: 'Pagination cursor.' },
    },
    required: [],
  },
};

export const update_sentry_issue_status_tool: ToolDefinition = {
  name: 'update_sentry_issue_status',
  description: 'Update the status of a Sentry issue.',
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'string', description: 'The ID of the issue.' },
      status: { type: 'string', enum: ['resolved', 'ignored', 'unresolved'], description: 'New status.' },
    },
    required: ['issue_id', 'status'],
  },
};

export const create_sentry_issue_comment_tool: ToolDefinition = {
  name: 'create_sentry_issue_comment',
  description: 'Add a comment to a Sentry issue.',
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'string', description: 'Issue ID.' },
      comment_text: { type: 'string', description: 'Comment text.' },
    },
    required: ['issue_id', 'comment_text'],
  },
};

export const get_issue_hashes_tool: ToolDefinition = {
  name: 'get_issue_hashes',
  description: 'Get the fingerprint hashes for an issue. Useful for understanding why events are grouped together.',
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'string', description: 'Issue ID.' },
      cursor: { type: 'string', description: 'Pagination cursor.' },
    },
    required: ['issue_id'],
  },
};

export const bulk_update_issues_tool: ToolDefinition = {
  name: 'bulk_update_issues',
  description: 'Bulk update multiple issues at once (resolve, ignore, unresolve, assign). Useful for triaging many issues.',
  inputSchema: {
    type: 'object',
    properties: {
      project_slug: { type: 'string', description: 'Project slug.' },
      query: {
        type: 'string',
        description: 'Sentry search query to select issues (e.g., "is:unresolved environment:staging").',
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

const getIssueId = (input: string): string | null => {
  try {
    const url = new URL(input);
    const pathParts = url.pathname.split('/');
    const issuesIndex = pathParts.indexOf('issues');
    if (issuesIndex !== -1 && pathParts.length > issuesIndex + 1) {
      const potentialId = pathParts[issuesIndex + 1];
      if (/^\d+$/.test(potentialId)) return potentialId;
    }
  } catch {
    if (/^\d+$/.test(input)) return input;
  }
  return null;
};

const mapAxiosError = (error: AxiosError, toolName: string): string => {
  let message = `Sentry API error for ${toolName}: ${error.message}`;
  if (error.response) {
    message += ` Status: ${error.response.status}. Response: ${JSON.stringify(error.response.data)}`;
    if (error.response.status === 401 || error.response.status === 403) {
      message = `Sentry API permission denied for ${toolName}. Check auth token validity and permissions.`;
    } else if (error.response.status === 404) {
      message = `Sentry resource not found for ${toolName}. Check IDs/slugs.`;
    }
  }
  return message;
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
    throw new McpError(ErrorCode.InvalidParams, `Could not extract issue ID from: ${args.issue_id_or_url}`);
  }

  console.error(`Fetching Sentry issue ${issueId} from sentryClient`);

  const issueResponse = await sentryClient.getIssue(issueId);
  let issueData = extractEssentialIssueFields(issueResponse);
  let combinedData: Record<string, unknown> = { ...issueData, latest_event: null };

  if (args.include_latest_event) {
    try {
      console.error(`Fetching latest event for issue ${issueId} in org ${ORG_SLUG}`);
      const eventResponse = await sentryClient.getLatestEventForIssue(ORG_SLUG, issueId) as SentryEvent;

      if (eventResponse.entries) {
        combinedData.latest_event = {
          id: eventResponse.id,
          eventID: eventResponse.eventID,
          dateCreated: eventResponse.dateCreated,
          entries: eventResponse.entries.slice(0, 3).map(extractEssentialEventEntry),
          _note: 'Event truncated. Use get_sentry_event_details for full event data.',
        };
      } else {
        combinedData.latest_event = eventResponse;
      }
    } catch (eventError) {
      console.warn(`Could not fetch latest event for issue ${issueId}.`, eventError);
    }
  }

  if (args.max_stack_frames) {
    combinedData = truncateStackTraces(combinedData, args.max_stack_frames) as Record<string, unknown>;
  }

  if (args.include_fields || args.exclude_fields) {
    combinedData = filterObjectFields(combinedData, args.include_fields, args.exclude_fields) as Record<string, unknown>;
  }

  if (args.grep_pattern) {
    combinedData = grepFilter(combinedData, args.grep_pattern) as Record<string, unknown>;
  }

  return { content: [{ type: 'text', text: JSON.stringify(combinedData, null, 2) }] };
}

export async function handleListSentryProjects(): Promise<ToolResult> {
  console.error(`Fetching projects for org ${ORG_SLUG}`);
  const response = await sentryClient.listProjects(ORG_SLUG);
  return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
}

export async function handleListSentryIssues(args: unknown): Promise<ToolResult> {
  if (!isValidListIssuesArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for list_sentry_issues.');
  }

  const params: Record<string, string | number> = {};
  if (args.query) params.query = args.query;
  if (args.status) params.query = `${params.query || ''} is:${args.status}`.trim();
  if (args.limit) params.limit = args.limit;
  if (args.cursor) params.cursor = args.cursor;
  if (!params.limit) params.limit = 25;

  console.error(`Fetching issues for project ${args.project_slug} in org ${ORG_SLUG}`);
  const response = await sentryClient.listProjectIssues(ORG_SLUG, args.project_slug, params);

  const { data, truncated, pagination_info } = truncateResponse(response);
  let resultText = JSON.stringify(data, null, 2);
  if (truncated && pagination_info) {
    resultText = `${pagination_info}\n\n${resultText}`;
  }

  return { content: [{ type: 'text', text: resultText }] };
}

export async function handleListIssues(args: unknown): Promise<ToolResult> {
  if (!isValidSearchIssuesArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for list_issues.');
  }

  const params: Record<string, string | number> = {};
  if (args.query) params.query = args.query;
  if (args.sort) params.sort = args.sort;
  if (args.limit) params.limit = args.limit;
  if (args.cursor) params.cursor = args.cursor;
  if (!params.limit) params.limit = 25;

  console.error(`Searching issues in org ${ORG_SLUG} with query: ${args.query || '(none)'}`);
  const response = await sentryClient.searchIssues(ORG_SLUG, params);

  const { data, truncated, pagination_info } = truncateResponse(response);
  let resultText = JSON.stringify(data, null, 2);
  if (truncated && pagination_info) {
    resultText = `${pagination_info}\n\n${resultText}`;
  }

  return { content: [{ type: 'text', text: resultText }] };
}

export async function handleUpdateIssueStatus(args: unknown): Promise<ToolResult> {
  if (!isValidUpdateIssueArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for update_sentry_issue_status.');
  }

  console.error(`Updating issue ${args.issue_id} status to ${args.status}`);
  const response = await sentryClient.updateIssue(args.issue_id, { status: args.status });
  return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
}

export async function handleCreateComment(args: unknown): Promise<ToolResult> {
  if (!isValidCreateCommentArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for create_sentry_issue_comment.');
  }

  console.error(`Adding comment to issue ${args.issue_id}`);
  const response = await sentryClient.createIssueComment(args.issue_id, args.comment_text);
  return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
}

export async function handleGetIssueHashes(args: unknown): Promise<ToolResult> {
  if (!isValidGetIssueHashesArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for get_issue_hashes.');
  }

  const params: Record<string, string> = {};
  if (args.cursor) params.cursor = args.cursor;

  console.error(`Getting hashes for issue ${args.issue_id}`);
  const response = await sentryClient.getIssueHashes(args.issue_id, params);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        issue_id: args.issue_id,
        hashes: response,
        explanation: 'Hashes represent fingerprints used to group events. Events with matching hashes are grouped into the same issue.',
      }, null, 2),
    }],
  };
}

export async function handleBulkUpdateIssues(args: unknown): Promise<ToolResult> {
  if (!isValidBulkUpdateArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for bulk_update_issues.');
  }

  const body: Record<string, unknown> = {};
  if (args.query) body.query = args.query;
  if (args.status) body.status = args.status;
  if (args.assigned_to) body.assignedTo = args.assigned_to;
  if (args.has_seen !== undefined) body.hasSeen = args.has_seen;

  console.error(`Bulk updating issues in project ${args.project_slug}`);
  const response = await sentryClient.bulkUpdateProjectIssues(ORG_SLUG, args.project_slug, body);
  return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
}

// ============================================================
// Error Handler
// ============================================================

export function handleToolError(error: unknown, toolName: string): ToolResult {
  console.error(`Error calling tool ${toolName}:`, error);

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
