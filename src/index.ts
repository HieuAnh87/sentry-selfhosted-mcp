#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios, { AxiosError } from 'axios';

// Read configuration from environment variables
const SENTRY_URL = process.env.SENTRY_URL;
const SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN;
const SENTRY_ORG_SLUG = process.env.SENTRY_ORG_SLUG; // Added Org Slug

if (!SENTRY_URL) {
  throw new Error('SENTRY_URL environment variable is required');
}
if (!SENTRY_AUTH_TOKEN) {
  throw new Error('SENTRY_AUTH_TOKEN environment variable is required');
}
if (!SENTRY_ORG_SLUG) {
  throw new Error('SENTRY_ORG_SLUG environment variable is required');
}


// Validate the URL format basic check
try {
  new URL(SENTRY_URL);
} catch (e) {
  throw new Error(`Invalid SENTRY_URL format: ${SENTRY_URL}`);
}

// Ensure URL doesn't end with a slash for consistency
const SENTRY_BASE_URL = SENTRY_URL.endsWith('/') ? SENTRY_URL.slice(0, -1) : SENTRY_URL;
const ORG_SLUG = SENTRY_ORG_SLUG;

// --- Argument Type Guards ---
const isValidGetIssueArgs = (args: any): args is {
  issue_id_or_url: string;
  include_latest_event?: boolean;
  include_fields?: string[];
  exclude_fields?: string[];
  grep_pattern?: string;
  max_stack_frames?: number;
} =>
  typeof args === 'object' && args !== null && typeof args.issue_id_or_url === 'string' &&
  (args.include_latest_event === undefined || typeof args.include_latest_event === 'boolean') &&
  (args.include_fields === undefined || Array.isArray(args.include_fields)) &&
  (args.exclude_fields === undefined || Array.isArray(args.exclude_fields)) &&
  (args.grep_pattern === undefined || typeof args.grep_pattern === 'string') &&
  (args.max_stack_frames === undefined || typeof args.max_stack_frames === 'number');

const isValidListIssuesArgs = (args: any): args is { project_slug: string; query?: string; status?: string; limit?: number; cursor?: string } =>
  typeof args === 'object' && args !== null && typeof args.project_slug === 'string' &&
  (args.query === undefined || typeof args.query === 'string') &&
  (args.status === undefined || typeof args.status === 'string') &&
  (args.limit === undefined || (typeof args.limit === 'number' && args.limit > 0 && args.limit <= 100)) &&
  (args.cursor === undefined || typeof args.cursor === 'string');

const isValidGetEventArgs = (args: any): args is { project_slug: string; event_id: string; limit?: number; offset?: number; entry_type?: string } =>
    typeof args === 'object' && args !== null && typeof args.project_slug === 'string' && typeof args.event_id === 'string' &&
    (args.limit === undefined || (typeof args.limit === 'number' && args.limit > 0)) &&
    (args.offset === undefined || (typeof args.offset === 'number' && args.offset >= 0)) &&
    (args.entry_type === undefined || typeof args.entry_type === 'string');

const isValidUpdateIssueArgs = (args: any): args is { issue_id: string; status: 'resolved' | 'ignored' | 'unresolved' } =>
    typeof args === 'object' && args !== null && typeof args.issue_id === 'string' &&
    typeof args.status === 'string' && ['resolved', 'ignored', 'unresolved'].includes(args.status);

const isValidCreateCommentArgs = (args: any): args is { issue_id: string; comment_text: string } =>
    typeof args === 'object' && args !== null && typeof args.issue_id === 'string' && typeof args.comment_text === 'string';

const isValidRawApiArgs = (args: any): args is { endpoint: string; method?: string; params?: Record<string, any>; body?: any; grep_pattern?: string } =>
    typeof args === 'object' && args !== null && typeof args.endpoint === 'string' &&
    (args.method === undefined || typeof args.method === 'string') &&
    (args.params === undefined || typeof args.params === 'object') &&
    (args.body === undefined || typeof args.body === 'object') &&
    (args.grep_pattern === undefined || typeof args.grep_pattern === 'string');

const isValidGetStackFramesArgs = (args: any): args is { project_slug: string; event_id: string; in_app_only?: boolean; max_frames?: number } =>
    typeof args === 'object' && args !== null && typeof args.project_slug === 'string' && typeof args.event_id === 'string' &&
    (args.in_app_only === undefined || typeof args.in_app_only === 'boolean') &&
    (args.max_frames === undefined || typeof args.max_frames === 'number');

const isValidCheckDsymArgs = (args: any): args is { project_slug: string; event_id?: string } =>
    typeof args === 'object' && args !== null && typeof args.project_slug === 'string' &&
    (args.event_id === undefined || typeof args.event_id === 'string');

// Phase 1: New tools
const isValidListIssueEventsArgs = (args: any): args is {
  issue_id: string;
  limit?: number;
  cursor?: string;
  full?: boolean;
} =>
    typeof args === 'object' && args !== null && typeof args.issue_id === 'string' &&
    (args.limit === undefined || (typeof args.limit === 'number' && args.limit > 0 && args.limit <= 100)) &&
    (args.cursor === undefined || typeof args.cursor === 'string') &&
    (args.full === undefined || typeof args.full === 'boolean');

const isValidGetIssueHashesArgs = (args: any): args is {
  issue_id: string;
  cursor?: string;
} =>
    typeof args === 'object' && args !== null && typeof args.issue_id === 'string' &&
    (args.cursor === undefined || typeof args.cursor === 'string');

const isValidListErrorEventsArgs = (args: any): args is {
  project_slug: string;
  limit?: number;
  cursor?: string;
  query?: string;
  full?: boolean;
} =>
    typeof args === 'object' && args !== null && typeof args.project_slug === 'string' &&
    (args.limit === undefined || (typeof args.limit === 'number' && args.limit > 0 && args.limit <= 100)) &&
    (args.cursor === undefined || typeof args.cursor === 'string') &&
    (args.query === undefined || typeof args.query === 'string') &&
    (args.full === undefined || typeof args.full === 'boolean');


// --- Helper Functions ---
const getIssueId = (input: string): string | null => {
  try {
    const url = new URL(input);
    const pathParts = url.pathname.split('/');
    const issuesIndex = pathParts.indexOf('issues');
    if (issuesIndex !== -1 && pathParts.length > issuesIndex + 1) {
      const potentialId = pathParts[issuesIndex + 1];
      if (/^\d+$/.test(potentialId)) return potentialId;
    }
  } catch (e) {
    if (/^\d+$/.test(input)) return input;
  }
  return null;
};

// Helper to extract only essential fields from Sentry issue data
const extractEssentialIssueFields = (issueData: any): any => {
  const essential: any = {
    id: issueData.id,
    shortId: issueData.shortId,
    title: issueData.title,
    culprit: issueData.culprit,
    permalink: issueData.permalink,
    logger: issueData.logger,
    level: issueData.level,
    status: issueData.status,
    type: issueData.type,
    platform: issueData.platform,
    project: issueData.project,
    count: issueData.count,
    userCount: issueData.userCount,
    firstSeen: issueData.firstSeen,
    lastSeen: issueData.lastSeen,
    metadata: issueData.metadata,
  };

  // Add a note about truncation
  if (issueData.annotations || issueData.context || issueData.tags) {
    essential._note = "Full issue details truncated. Use get_sentry_event_details for stack traces and event data.";
  }

  return essential;
};

// Helper to extract essential fields from event entries
const extractEssentialEventEntry = (entry: any): any => {
  if (entry.type === 'exception' && entry.data?.values) {
    return {
      type: entry.type,
      data: {
        values: entry.data.values.map((exc: any) => ({
          type: exc.type,
          value: exc.value,
          mechanism: exc.mechanism,
          stacktrace: exc.stacktrace ? {
            frames: exc.stacktrace.frames?.slice(-5).map((frame: any) => ({
              filename: frame.filename,
              function: frame.function,
              lineNo: frame.lineNo,
              colNo: frame.colNo,
              absPath: frame.absPath,
              context: frame.context?.slice(-3, 4), // 3 lines before and after
              vars: Object.keys(frame.vars || {}).length > 0 ? '...' : undefined
            }))
          } : undefined
        }))
      }
    };
  }

  if (entry.type === 'message') {
    return entry;
  }

  if (entry.type === 'breadcrumbs' && entry.data?.values) {
    return {
      type: entry.type,
      data: {
        values: entry.data.values.slice(-10) // Last 10 breadcrumbs
      }
    };
  }

  return {
    type: entry.type,
    _truncated: true
  };
};

// Helper to truncate large responses with pagination info
const truncateResponse = (data: any, maxTokens: number = 50000): { data: any; truncated: boolean; pagination_info?: string } => {
  const jsonString = JSON.stringify(data, null, 2);

  // Rough token estimation (1 token ≈ 4 characters for JSON)
  const estimatedTokens = Math.ceil(jsonString.length / 4);

  if (estimatedTokens <= maxTokens) {
    return { data, truncated: false };
  }

  // If it's an array, truncate by removing items
  if (Array.isArray(data)) {
    const itemsToKeep = Math.floor(data.length * (maxTokens / estimatedTokens));
    const truncatedData = data.slice(0, Math.max(1, itemsToKeep));
    return {
      data: truncatedData,
      truncated: true,
      pagination_info: `Response truncated. Showing ${truncatedData.length} of ${data.length} items. Use limit and cursor/offset parameters to paginate through all results.`
    };
  }

  // If it's an object with large nested structures, try to truncate specific fields
  if (typeof data === 'object' && data !== null) {
    const truncatedData = { ...data };

    // Common large fields in Sentry responses
    const largeFields = ['entries', 'stacktrace', 'frames', 'breadcrumbs', 'contexts', 'tags', 'extra'];

    for (const field of largeFields) {
      if (truncatedData[field] && Array.isArray(truncatedData[field])) {
        const originalLength = truncatedData[field].length;
        if (originalLength > 10) {
          truncatedData[field] = truncatedData[field].slice(0, 10);
          truncatedData[`${field}_truncated`] = `Showing 10 of ${originalLength} entries. Use pagination parameters to get more.`;
        }
      }
    }

    return {
      data: truncatedData,
      truncated: true,
      pagination_info: "Response truncated due to size. Use limit and offset parameters to paginate through large nested data."
    };
  }

  return { data, truncated: false };
};

// Filter object fields based on include/exclude lists
const filterObjectFields = (obj: any, includeFields?: string[], excludeFields?: string[]): any => {
  if (!obj || typeof obj !== 'object') return obj;

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map(item => filterObjectFields(item, includeFields, excludeFields));
  }

  let result: any = {};

  // If include fields specified, only include those
  if (includeFields && includeFields.length > 0) {
    for (const field of includeFields) {
      if (field.includes('.')) {
        // Handle nested field paths like "latest_event.entries"
        const [parent, ...rest] = field.split('.');
        if (obj[parent] !== undefined) {
          if (!result[parent]) result[parent] = {};
          const childField = rest.join('.');
          result[parent] = filterObjectFields(obj[parent], [childField], undefined);
        }
      } else if (obj[field] !== undefined) {
        result[field] = obj[field];
      }
    }
  } else {
    // Start with all fields
    result = { ...obj };

    // Remove excluded fields
    if (excludeFields && excludeFields.length > 0) {
      for (const field of excludeFields) {
        if (field.includes('.')) {
          // Handle nested field paths
          const [parent, ...rest] = field.split('.');
          if (result[parent]) {
            const childField = rest.join('.');
            result[parent] = filterObjectFields(result[parent], undefined, [childField]);
          }
        } else {
          delete result[field];
        }
      }
    }
  }

  return result;
};

// Apply grep pattern filtering to JSON content
const grepFilter = (data: any, pattern: string): any => {
  const regex = new RegExp(pattern, 'gi');
  const jsonStr = JSON.stringify(data, null, 2);
  const lines = jsonStr.split('\n');
  const matchingLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      // Include context (previous and next line)
      if (i > 0) matchingLines.push(lines[i - 1]);
      matchingLines.push(lines[i]);
      if (i < lines.length - 1) matchingLines.push(lines[i + 1]);
    }
  }

  // Try to parse the filtered content, fall back to text if invalid JSON
  const filtered = matchingLines.join('\n');
  try {
    return JSON.parse(filtered);
  } catch {
    return { grep_results: matchingLines, original_pattern: pattern };
  }
};

// Truncate stack traces to specified number of frames
const truncateStackTraces = (data: any, maxFrames: number): any => {
  if (!data || typeof data !== 'object') return data;

  // Handle arrays
  if (Array.isArray(data)) {
    return data.map(item => truncateStackTraces(item, maxFrames));
  }

  // Clone the object
  const result = { ...data };

  // Look for stack trace patterns
  if (result.entries && Array.isArray(result.entries)) {
    result.entries = result.entries.map((entry: any) => {
      if (entry.type === 'exception' && entry.data?.values) {
        entry.data.values = entry.data.values.map((value: any) => {
          if (value.stacktrace?.frames && Array.isArray(value.stacktrace.frames)) {
            // Keep only the most relevant frames (usually the last ones are most relevant)
            const frames = value.stacktrace.frames;
            if (frames.length > maxFrames) {
              value.stacktrace.frames = frames.slice(-maxFrames);
              value.stacktrace.frames_omitted = frames.length - maxFrames;
            }
          }
          return value;
        });
      }
      return entry;
    });
  }

  // Recursively process nested objects
  for (const key in result) {
    if (typeof result[key] === 'object') {
      result[key] = truncateStackTraces(result[key], maxFrames);
    }
  }

  return result;
};

// --- Main Server Class ---
class SelfHostedSentryServer {
  private server: Server;
  private axiosInstance;

  constructor() {
    this.server = new Server(
      {
        name: 'sentry-selfhosted-mcp',
        version: '1.0.0', // First stable release with 12 tools
        description: 'MCP server for self-hosted Sentry instances with extended tools, filtering, raw API access, and specialized debugging tools.',
      },
      { capabilities: { resources: { list: true }, tools: {} } }
    );

    this.axiosInstance = axios.create({
      baseURL: `${SENTRY_BASE_URL}/api/0/`,
      headers: { Authorization: `Bearer ${SENTRY_AUTH_TOKEN}`, 'Content-Type': 'application/json' },
      timeout: 20000, // Increased timeout slightly
    });

    this.setupToolHandlers();
    this.setupResourceHandlers();
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => { await this.server.close(); process.exit(0); });
  }

  private setupToolHandlers() {
    // --- List Tools ---
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "get_sentry_issue",
          description:
            "Retrieve details for a specific Sentry issue by ID or URL, including the stacktrace from the latest event. Supports filtering and automatic truncation to reduce response size.",
          inputSchema: {
            type: "object",
            properties: {
              issue_id_or_url: {
                type: "string",
                description:
                  "Sentry issue ID or full issue URL. Issue ID is a number e.g: 123456",
              },
              include_latest_event: {
                type: "boolean",
                description: "Include latest event details (default: false to reduce response size)",
                default: false,
              },
              include_fields: {
                type: "array",
                items: { type: "string" },
                description:
                  "Optional: List of fields to include (whitelist). Use dot notation for nested fields (e.g., 'latest_event.entries'). If specified, only these fields will be returned.",
              },
              exclude_fields: {
                type: "array",
                items: { type: "string" },
                description:
                  "Optional: List of fields to exclude (blacklist). Use dot notation for nested fields. Applied only if include_fields is not specified.",
              },
              grep_pattern: {
                type: "string",
                description:
                  "Optional: Regex pattern to filter response content. Returns only matching lines with context.",
              },
              max_stack_frames: {
                type: "number",
                description:
                  "Optional: Maximum number of stack trace frames to return (default: all). Keeps the most relevant (bottom) frames.",
              },
            },
            required: ["issue_id_or_url"],
          },
        },
        {
          name: "list_sentry_projects",
          description:
            "List all projects within the configured Sentry organization.",
          inputSchema: { type: "object", properties: {}, required: [] }, // No input args needed
        },
        {
          name: "list_sentry_issues",
          description:
            "List issues for a specific project, optionally filtering by query or status. Supports pagination for large result sets.",
          inputSchema: {
            type: "object",
            properties: {
              project_slug: {
                type: "string",
                description: 'The slug of the project (e.g., "my-web-app").',
              },
              query: {
                type: "string",
                description:
                  'Optional Sentry search query (e.g., "is:unresolved environment:production").',
              },
              status: {
                type: "string",
                enum: ["resolved", "unresolved", "ignored"],
                description: "Optional issue status filter.",
              },
              limit: {
                type: "number",
                description: "Maximum number of issues to return (1-100, default: 25).",
                minimum: 1,
                maximum: 100,
              },
              cursor: {
                type: "string",
                description: "Pagination cursor from previous response for getting next page.",
              },
            },
            required: ["project_slug"],
          },
        },
        {
          name: "get_sentry_event_details",
          description:
            "Retrieve details for a specific event ID within a project. IMPORTANT: For large events, always use limit parameter (e.g., limit: 10) to avoid token limits. Use offset for pagination.",
          inputSchema: {
            type: "object",
            properties: {
              project_slug: {
                type: "string",
                description: "The slug of the project.",
              },
              event_id: { type: "string", description: "The ID of the event." },
              limit: {
                type: "number",
                description: "RECOMMENDED: Limit the number of entries returned (e.g., 10 for large stack traces). Use this to avoid exceeding token limits.",
                minimum: 1,
                default: 10,
              },
              offset: {
                type: "number",
                description: "Offset for pagination through event entries. Start with 0, then use 10, 20, etc.",
                minimum: 0,
                default: 0,
              },
              entry_type: {
                type: "string",
                description: "Filter to only get specific entry type (e.g., 'exception', 'message', 'breadcrumbs'). By default returns most important entries.",
                enum: ["exception", "message", "breadcrumbs", "request", "threads", "debugmeta", "contexts"],
              },
            },
            required: ["project_slug", "event_id"],
          },
        },
        {
          name: "update_sentry_issue_status",
          description: "Update the status of a Sentry issue.",
          inputSchema: {
            type: "object",
            properties: {
              issue_id: {
                type: "string",
                description: "The ID of the issue to update.",
              },
              status: {
                type: "string",
                enum: ["resolved", "ignored", "unresolved"],
                description: "The new status for the issue.",
              },
            },
            required: ["issue_id", "status"],
          },
        },
        {
          name: "create_sentry_issue_comment",
          description: "Add a comment to a Sentry issue.",
          inputSchema: {
            type: "object",
            properties: {
              issue_id: {
                type: "string",
                description: "The ID of the issue to comment on.",
              },
              comment_text: {
                type: "string",
                description: "The text content of the comment.",
              },
            },
            required: ["issue_id", "comment_text"],
          },
        },
        {
          name: "raw_sentry_api",
          description: "Make a raw API call to any Sentry endpoint. Returns unfiltered JSON that agents can process with grep_pattern or other filters. Useful for debugging or accessing data not covered by other tools. WARNING: Event endpoints can return 100K+ tokens. ALWAYS use grep_pattern for events to avoid token limits. Common patterns: '\"function\":|\"in_app\":' for stack frames, '\"type\":' for breadcrumbs.",
          inputSchema: {
            type: "object",
            properties: {
              endpoint: {
                type: "string",
                description: "API endpoint path (e.g., 'projects/beoflow/apple-ios/events/abc123/'). Do NOT include /api/0/ prefix.",
              },
              method: {
                type: "string",
                enum: ["GET", "POST", "PUT", "DELETE"],
                description: "HTTP method (default: GET)",
                default: "GET",
              },
              params: {
                type: "object",
                description: "URL query parameters as key-value pairs",
              },
              body: {
                type: "object",
                description: "Request body for POST/PUT requests",
              },
              grep_pattern: {
                type: "string",
                description: "CRITICAL for event endpoints: Regex to filter response. Reduces 100K+ token responses to manageable size. Examples: '\"function\":|\"filename\":|\"in_app\":true' for stack traces, '\"breadcrumbs\"' for user actions, '\"tags\"' for metadata. Pattern matches return line + surrounding context.",
              },
            },
            required: ["endpoint"],
          },
        },
        {
          name: "get_stack_frames",
          description: "Extract structured stack trace frames from an event. Optimized for debugging - returns only relevant frame info (function, file, line, in_app status) without noise. Much more efficient than raw_sentry_api for stack trace analysis.",
          inputSchema: {
            type: "object",
            properties: {
              project_slug: {
                type: "string",
                description: "The slug of the project (e.g., 'apple-ios')",
              },
              event_id: {
                type: "string",
                description: "The event ID to extract stack frames from",
              },
              in_app_only: {
                type: "boolean",
                description: "Filter to only show frames from your application code (excludes system/library frames). Default: false",
                default: false,
              },
              max_frames: {
                type: "number",
                description: "Maximum number of frames to return. Default: 50. Start from most recent (bottom of stack).",
                default: 50,
              },
            },
            required: ["project_slug", "event_id"],
          },
        },
        {
          name: "check_dsym_status",
          description: "Check if debug symbols (dSYM files) are missing for iOS/macOS crashes. Missing dSYMs cause stack traces to show addresses instead of function names. Returns list of missing symbols with UUIDs for upload.",
          inputSchema: {
            type: "object",
            properties: {
              project_slug: {
                type: "string",
                description: "The slug of the project (e.g., 'apple-ios')",
              },
              event_id: {
                type: "string",
                description: "Optional: Specific event ID to check. If not provided, checks recent events in project.",
              },
            },
            required: ["project_slug"],
          },
        },
        // Phase 1: New tools
        {
          name: "list_issue_events",
          description: "List all events for a specific issue. Useful to see all occurrences of an error over time.",
          inputSchema: {
            type: "object",
            properties: {
              issue_id: {
                type: "string",
                description: "The ID of the issue to list events for.",
              },
              limit: {
                type: "number",
                description: "Maximum number of events to return (1-100, default: 25).",
                minimum: 1,
                maximum: 100,
              },
              cursor: {
                type: "string",
                description: "Pagination cursor from previous response.",
              },
              full: {
                type: "boolean",
                description: "Include full event details (default: false for compact view).",
                default: false,
              },
            },
            required: ["issue_id"],
          },
        },
        {
          name: "get_issue_hashes",
          description: "Get the fingerprint hashes for an issue. Useful for understanding why events are grouped together.",
          inputSchema: {
            type: "object",
            properties: {
              issue_id: {
                type: "string",
                description: "The ID of the issue to get hashes for.",
              },
              cursor: {
                type: "string",
                description: "Pagination cursor from previous response.",
              },
            },
            required: ["issue_id"],
          },
        },
        {
          name: "list_error_events",
          description: "List error events in a project. Search across all events without knowing the issue ID.",
          inputSchema: {
            type: "object",
            properties: {
              project_slug: {
                type: "string",
                description: "The slug of the project.",
              },
              limit: {
                type: "number",
                description: "Maximum number of events to return (1-100, default: 25).",
                minimum: 1,
                maximum: 100,
              },
              cursor: {
                type: "string",
                description: "Pagination cursor from previous response.",
              },
              query: {
                type: "string",
                description: "Sentry search query to filter events.",
              },
              full: {
                type: "boolean",
                description: "Include full event details (default: false for compact view).",
                default: false,
              },
            },
            required: ["project_slug"],
          },
        },
      ],
    }));

    // --- Call Tool ---
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const args = request.params.arguments;

      try {
        // --- get_sentry_issue ---
        if (toolName === "get_sentry_issue") {
          if (!isValidGetIssueArgs(args))
            throw new McpError(
              ErrorCode.InvalidParams,
              "Invalid args for get_sentry_issue."
            );
          const issueId = getIssueId(args.issue_id_or_url);
          if (!issueId)
            throw new McpError(
              ErrorCode.InvalidParams,
              `Could not extract issue ID from: ${args.issue_id_or_url}`
            );
          console.error(
            `Fetching Sentry issue ${issueId} from ${SENTRY_BASE_URL}`
          );
          const issueResponse = await this.axiosInstance.get(
            `issues/${issueId}/`
          );

          // Extract only essential fields to reduce response size
          let issueData = extractEssentialIssueFields(issueResponse.data);
          let combinedData: any = { ...issueData, latest_event: null };

          // Only include latest event if explicitly requested
          if (args.include_latest_event) {
            try {
              console.error(
                `Fetching latest event for issue ${issueId} in org ${ORG_SLUG}`
              );
              const eventResponse = await this.axiosInstance.get(
                `organizations/${ORG_SLUG}/issues/${issueId}/events/latest/`
              );

              // Extract only essential event data
              if (eventResponse.data.entries) {
                combinedData.latest_event = {
                  id: eventResponse.data.id,
                  eventID: eventResponse.data.eventID,
                  dateCreated: eventResponse.data.dateCreated,
                  entries: eventResponse.data.entries.slice(0, 3).map(extractEssentialEventEntry),
                  _note: "Event truncated. Use get_sentry_event_details for full event data."
                };
              } else {
                combinedData.latest_event = eventResponse.data;
              }
            } catch (eventError) {
              console.warn(
                `Could not fetch latest event for issue ${issueId}. It might not have any events or there was an API error.`,
                eventError
              );
            }
          }

          // Apply filtering if specified
          if (args.max_stack_frames) {
            console.error(`Truncating stack traces to ${args.max_stack_frames} frames`);
            combinedData = truncateStackTraces(combinedData, args.max_stack_frames);
          }

          if (args.include_fields || args.exclude_fields) {
            console.error(`Applying field filters - include: ${args.include_fields?.join(', ') || 'none'}, exclude: ${args.exclude_fields?.join(', ') || 'none'}`);
            combinedData = filterObjectFields(combinedData, args.include_fields, args.exclude_fields);
          }

          if (args.grep_pattern) {
            console.error(`Applying grep pattern filter: ${args.grep_pattern}`);
            combinedData = grepFilter(combinedData, args.grep_pattern);
          }

          return {
            content: [
              { type: "text", text: JSON.stringify(combinedData, null, 2) },
            ],
          };
        }
        // --- list_sentry_projects ---
        else if (toolName === "list_sentry_projects") {
          console.error(`Fetching projects for org ${ORG_SLUG}`);
          const response = await this.axiosInstance.get(
            `organizations/${ORG_SLUG}/projects/`
          );
          return {
            content: [
              { type: "text", text: JSON.stringify(response.data, null, 2) },
            ],
          };
        }
        // --- list_sentry_issues ---
        else if (toolName === "list_sentry_issues") {
          if (!isValidListIssuesArgs(args))
            throw new McpError(
              ErrorCode.InvalidParams,
              "Invalid args for list_sentry_issues."
            );
          const params: Record<string, string | number> = {};
          if (args.query) params.query = args.query;
          if (args.status)
            params.query =
              (params.query ? params.query + " " : "") + `is:${args.status}`; // Append status to query
          
          // Add pagination parameters - Sentry API uses 'limit' and 'cursor'
          if (args.limit) params.limit = args.limit;
          if (args.cursor) params.cursor = args.cursor;
          
          // Default to a reasonable limit if not specified
          if (!params.limit) params.limit = 25;

          console.error(
            `Fetching issues for project ${args.project_slug} in org ${ORG_SLUG} with params:`,
            params
          );
          const response = await this.axiosInstance.get(
            `projects/${ORG_SLUG}/${args.project_slug}/issues/`,
            { params }
          );
          
          // Apply truncation if response is still too large
          const { data: responseData, truncated, pagination_info } = truncateResponse(response.data);
          
          let resultText = JSON.stringify(responseData, null, 2);
          if (truncated && pagination_info) {
            resultText = `${pagination_info}\n\n${resultText}`;
          }
          
          return {
            content: [
              { type: "text", text: resultText },
            ],
          };
        }
        // --- get_sentry_event_details ---
        else if (toolName === "get_sentry_event_details") {
          if (!isValidGetEventArgs(args))
            throw new McpError(
              ErrorCode.InvalidParams,
              "Invalid args for get_sentry_event_details."
            );
          console.error(
            `Fetching event ${args.event_id} for project ${args.project_slug} in org ${ORG_SLUG}`
          );
          
          const response = await this.axiosInstance.get(
            `projects/${ORG_SLUG}/${args.project_slug}/events/${args.event_id}/`
          );
          
          let eventData = response.data;
          
          // Apply pagination to large nested arrays - default to safe limits
          const offset = args.offset || 0;
          const limit = args.limit || 5; // Default to 5 entries to avoid token limits
            
          // Apply smart filtering and extraction to entries
          if (eventData.entries && Array.isArray(eventData.entries)) {
            const totalEntries = eventData.entries.length;
            let selectedEntries = [];
            
            if (args.entry_type) {
              // Filter to specific entry type
              selectedEntries = eventData.entries
                .filter((e: any) => e.type === args.entry_type)
                .slice(offset, offset + limit);
                
              if (selectedEntries.length === 0) {
                eventData.entries = [];
                eventData.error = `No entries of type '${args.entry_type}' found. Available types: ${[...new Set(eventData.entries.map((e: any) => e.type))].join(', ')}`;
              }
            } else {
              // Smart selection: prioritize important entry types
              const priorityTypes = ['exception', 'message', 'breadcrumbs', 'request'];
              const importantEntries = [];
              
              // First, get the most important entry types
              for (const type of priorityTypes) {
                const entry = eventData.entries.find((e: any) => e.type === type);
                if (entry && importantEntries.length < limit) {
                  importantEntries.push(entry);
                }
              }
              
              // If we still have room, add other entries
              if (importantEntries.length < limit) {
                const otherEntries = eventData.entries
                  .filter((e: any) => !priorityTypes.includes(e.type))
                  .slice(0, limit - importantEntries.length);
                importantEntries.push(...otherEntries);
              }
              
              selectedEntries = importantEntries;
            }
            
            // Apply smart extraction to reduce size
            eventData.entries = selectedEntries.map(extractEssentialEventEntry);
            
            eventData.pagination_info = {
              total_entries: totalEntries,
              showing: eventData.entries.length,
              entry_types: eventData.entries.map((e: any) => e.type),
              available_types: [...new Set(eventData.entries.map((e: any) => e.type))],
              tip: args.entry_type ? 
                `Showing only '${args.entry_type}' entries. Remove entry_type parameter to see prioritized entries.` :
                "Showing prioritized entries. Use entry_type='exception' to see only stack traces."
            };
          }
          
          // Remove other large fields that might be present
          const fieldsToRemove = ['sdk', 'packages', 'contexts', 'user', 'request', 'environment'];
          for (const field of fieldsToRemove) {
            if (eventData[field]) {
              eventData[`_${field}_removed`] = true;
              delete eventData[field];
            }
          }
          
          // Apply additional truncation if response is still too large
          const { data: responseData, truncated, pagination_info } = truncateResponse(eventData);
          
          let resultText = JSON.stringify(responseData, null, 2);
          if (truncated && pagination_info) {
            resultText = `${pagination_info}\n\n${resultText}`;
          }
          
          return {
            content: [
              { type: "text", text: resultText },
            ],
          };
        }
        // --- update_sentry_issue_status ---
        else if (toolName === "update_sentry_issue_status") {
          if (!isValidUpdateIssueArgs(args))
            throw new McpError(
              ErrorCode.InvalidParams,
              "Invalid args for update_sentry_issue_status."
            );
          console.error(
            `Updating issue ${args.issue_id} status to ${args.status}`
          );
          const response = await this.axiosInstance.put(
            `issues/${args.issue_id}/`,
            { status: args.status }
          );
          return {
            content: [
              { type: "text", text: JSON.stringify(response.data, null, 2) },
            ],
          };
        }
        // --- create_sentry_issue_comment ---
        else if (toolName === "create_sentry_issue_comment") {
          if (!isValidCreateCommentArgs(args))
            throw new McpError(
              ErrorCode.InvalidParams,
              "Invalid args for create_sentry_issue_comment."
            );
          console.error(`Adding comment to issue ${args.issue_id}`);
          const response = await this.axiosInstance.post(
            `issues/${args.issue_id}/comments/`,
            { text: args.comment_text }
          );
          return {
            content: [
              { type: "text", text: JSON.stringify(response.data, null, 2) },
            ],
          };
        }
        // --- raw_sentry_api ---
        else if (toolName === "raw_sentry_api") {
          if (!isValidRawApiArgs(args))
            throw new McpError(
              ErrorCode.InvalidParams,
              "Invalid args for raw_sentry_api."
            );

          const method = (args.method || 'GET').toUpperCase();
          console.error(`Raw API ${method} request to ${args.endpoint}`);

          let response;
          const config: any = {};

          if (args.params) {
            config.params = args.params;
          }

          switch (method) {
            case 'GET':
              response = await this.axiosInstance.get(args.endpoint, config);
              break;
            case 'POST':
              response = await this.axiosInstance.post(args.endpoint, args.body || {}, config);
              break;
            case 'PUT':
              response = await this.axiosInstance.put(args.endpoint, args.body || {}, config);
              break;
            case 'DELETE':
              response = await this.axiosInstance.delete(args.endpoint, config);
              break;
            default:
              throw new McpError(
                ErrorCode.InvalidParams,
                `Unsupported HTTP method: ${method}`
              );
          }

          let responseData = response.data;

          // Check response size and warn if too large
          const jsonString = JSON.stringify(responseData, null, 2);
          const estimatedTokens = Math.ceil(jsonString.length / 4);

          // Warn if response is large and no grep pattern is provided
          if (estimatedTokens > 50000 && !args.grep_pattern) {
            console.error(`WARNING: Response is ~${estimatedTokens} tokens, which may exceed limits. Consider using grep_pattern to filter.`);
            return {
              content: [{
                type: "text",
                text: `⚠️  WARNING: Response is approximately ${estimatedTokens} tokens (limit: 50,000).\n\nThis endpoint returns a large amount of data. Please use grep_pattern to filter the response.\n\nSuggested patterns:\n- Stack traces: '"function":|"filename":|"in_app":true'\n- Breadcrumbs: '"breadcrumbs"'\n- Tags/metadata: '"tags"'\n- Error details: '"type":|"value":'\n\nExample: Add grep_pattern: '"function":|"in_app":' to your request.`
              }],
            };
          }

          // Apply grep filter if provided
          if (args.grep_pattern) {
            console.error(`Applying grep pattern filter: ${args.grep_pattern}`);
            responseData = grepFilter(responseData, args.grep_pattern);
          }

          return {
            content: [
              { type: "text", text: JSON.stringify(responseData, null, 2) },
            ],
          };
        }
        // --- get_stack_frames ---
        else if (toolName === "get_stack_frames") {
          if (!isValidGetStackFramesArgs(args))
            throw new McpError(
              ErrorCode.InvalidParams,
              "Invalid args for get_stack_frames."
            );

          console.error(`Extracting stack frames from event ${args.event_id} in project ${args.project_slug}`);

          const response = await this.axiosInstance.get(
            `projects/${ORG_SLUG}/${args.project_slug}/events/${args.event_id}/`
          );

          const eventData = response.data;
          const frames: any[] = [];

          // Extract frames from exception entries
          if (eventData.entries && Array.isArray(eventData.entries)) {
            for (const entry of eventData.entries) {
              if (entry.type === 'exception' && entry.data?.values) {
                for (const exc of entry.data.values) {
                  if (exc.stacktrace?.frames) {
                    for (const frame of exc.stacktrace.frames) {
                      // Skip system frames if in_app_only is true
                      if (args.in_app_only && !frame.in_app) {
                        continue;
                      }

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

          // Limit to max_frames, keeping the most recent (bottom of stack)
          const maxFrames = args.max_frames || 50;
          const limitedFrames = frames.slice(-maxFrames);

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                event_id: args.event_id,
                total_frames: frames.length,
                returned_frames: limitedFrames.length,
                in_app_only: args.in_app_only || false,
                frames: limitedFrames
              }, null, 2)
            }],
          };
        }
        // --- check_dsym_status ---
        else if (toolName === "check_dsym_status") {
          if (!isValidCheckDsymArgs(args))
            throw new McpError(
              ErrorCode.InvalidParams,
              "Invalid args for check_dsym_status."
            );

          console.error(`Checking dSYM status for project ${args.project_slug}`);

          let eventData;

          if (args.event_id) {
            // Check specific event
            const response = await this.axiosInstance.get(
              `projects/${ORG_SLUG}/${args.project_slug}/events/${args.event_id}/`
            );
            eventData = response.data;
          } else {
            // Get recent events and check the first one
            const issuesResponse = await this.axiosInstance.get(
              `projects/${ORG_SLUG}/${args.project_slug}/issues/`,
              { params: { limit: 1 } }
            );

            if (!issuesResponse.data || issuesResponse.data.length === 0) {
              return {
                content: [{
                  type: "text",
                  text: "No recent issues found in project. Cannot check dSYM status."
                }],
              };
            }

            const issueId = issuesResponse.data[0].id;
            const eventResponse = await this.axiosInstance.get(
              `organizations/${ORG_SLUG}/issues/${issueId}/events/latest/`
            );
            eventData = eventResponse.data;
          }

          // Check for dSYM errors
          const missingDsyms: any[] = [];
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
              type: "text",
              text: JSON.stringify({
                project: args.project_slug,
                event_id: eventData.eventID || args.event_id,
                has_missing_symbols: hasMissingSymbols,
                missing_count: missingDsyms.length,
                missing_symbols: missingDsyms,
                recommendation: hasMissingSymbols
                  ? "Upload missing dSYM files to Sentry to see full function names in stack traces. Use 'sentry-cli upload-dif' command."
                  : "All debug symbols are present for this event."
              }, null, 2)
            }],
          };
        }
        // --- Phase 1: list_issue_events ---
        else if (toolName === "list_issue_events") {
          if (!isValidListIssueEventsArgs(args))
            throw new McpError(
              ErrorCode.InvalidParams,
              "Invalid args for list_issue_events."
            );

          const params: Record<string, string | number | boolean> = {};
          if (args.limit) params.limit = args.limit;
          if (args.cursor) params.cursor = args.cursor;
          if (args.full) params.full = args.full;
          if (!params.limit) params.limit = 25;

          console.error(`Listing events for issue ${args.issue_id}`);
          const response = await this.axiosInstance.get(
            `issues/${args.issue_id}/events/`,
            { params }
          );

          // Extract essential fields from events for compact view
          let eventData = response.data;
          if (!args.full && Array.isArray(eventData)) {
            eventData = eventData.map((event: any) => ({
              id: event.id,
              eventID: event.eventID,
              dateCreated: event.dateCreated,
              message: event.message || event.title,
              platform: event.platform,
              tags: event.tags?.slice(0, 5), // Limit tags
              user: event.user ? { id: event.user.id, email: event.user.email } : null,
            }));
          }

          const { data: responseData, truncated, pagination_info } = truncateResponse(eventData);

          let resultText = JSON.stringify(responseData, null, 2);
          if (truncated && pagination_info) {
            resultText = `${pagination_info}\n\n${resultText}`;
          }

          return {
            content: [{ type: "text", text: resultText }],
          };
        }
        // --- Phase 1: get_issue_hashes ---
        else if (toolName === "get_issue_hashes") {
          if (!isValidGetIssueHashesArgs(args))
            throw new McpError(
              ErrorCode.InvalidParams,
              "Invalid args for get_issue_hashes."
            );

          const params: Record<string, string> = {};
          if (args.cursor) params.cursor = args.cursor;

          console.error(`Getting hashes for issue ${args.issue_id}`);
          const response = await this.axiosInstance.get(
            `issues/${args.issue_id}/hashes/`,
            { params }
          );

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                issue_id: args.issue_id,
                hashes: response.data,
                explanation: "Hashes represent fingerprints used to group events. Events with matching hashes are grouped into the same issue."
              }, null, 2)
            }],
          };
        }
        // --- Phase 1: list_error_events ---
        else if (toolName === "list_error_events") {
          if (!isValidListErrorEventsArgs(args))
            throw new McpError(
              ErrorCode.InvalidParams,
              "Invalid args for list_error_events."
            );

          const params: Record<string, string | number | boolean> = {};
          if (args.limit) params.limit = args.limit;
          if (args.cursor) params.cursor = args.cursor;
          if (args.query) params.query = args.query;
          if (args.full) params.full = args.full;
          if (!params.limit) params.limit = 25;

          console.error(`Listing error events for project ${args.project_slug}`);
          const response = await this.axiosInstance.get(
            `projects/${ORG_SLUG}/${args.project_slug}/events/`,
            { params }
          );

          // Extract essential fields from events for compact view
          let eventData = response.data;
          if (!args.full && Array.isArray(eventData)) {
            eventData = eventData.map((event: any) => ({
              id: event.id,
              eventID: event.eventID,
              groupID: event.groupID,
              dateCreated: event.dateCreated,
              message: event.message || event.title,
              platform: event.platform,
              type: event.type,
              tags: event.tags?.slice(0, 5),
              user: event.user ? { id: event.user.id, email: event.user.email } : null,
            }));
          }

          const { data: responseData, truncated, pagination_info } = truncateResponse(eventData);

          let resultText = JSON.stringify(responseData, null, 2);
          if (truncated && pagination_info) {
            resultText = `${pagination_info}\n\n${resultText}`;
          }

          return {
            content: [{ type: "text", text: resultText }],
          };
        }
        // --- Unknown Tool ---
        else {
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${toolName}`
          );
        }
      } catch (error) {
        console.error(`Error calling tool ${toolName}:`, error);
        let errorMessage = `Failed to execute tool ${toolName}.`;
        let isClientError = false; // Flag for 4xx errors

        if (axios.isAxiosError(error)) {
          errorMessage = `Sentry API error for ${toolName}: ${error.message}`;
          if (error.response) {
            errorMessage += ` Status: ${
              error.response.status
            }. Response: ${JSON.stringify(error.response.data)}`;
            if (error.response.status >= 400 && error.response.status < 500) {
              isClientError = true; // Indicate it's likely a bad request (permissions, not found, bad args)
              if (
                error.response.status === 401 ||
                error.response.status === 403
              ) {
                errorMessage = `Sentry API permission denied for ${toolName}. Check auth token validity and permissions.`;
              } else if (error.response.status === 404) {
                errorMessage = `Sentry resource not found for ${toolName}. Check IDs/slugs.`;
              }
            }
          }
        } else if (error instanceof McpError) {
          // If it's already an McpError (like InvalidParams), re-throw it directly
          throw error;
        } else if (error instanceof Error) {
          errorMessage = error.message;
        }

        // Return structured error for MCP
        return {
          content: [{ type: "text", text: errorMessage }],
          isError: true,
          // Optionally use InvalidRequest for client-side errors (4xx)
          // errorCode: isClientError ? ErrorCode.InvalidRequest : ErrorCode.InternalError
        };
      }
    });
  }

  private setupResourceHandlers() {
    // --- List Resources ---
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      // For now, we'll return an empty array since we don't have any resources
      // In the future, this could return things like:
      // - sentry:projects/<org>/projects - List of projects
      // - sentry:issues/<org>/<project> - Issues for a project
      // - sentry:events/<org>/<project> - Events for a project
      return {
        resources: []
      };
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(`Self-hosted Sentry MCP server v1.0.0 running for org "${ORG_SLUG}" at ${SENTRY_BASE_URL}`);
  }
}

const server = new SelfHostedSentryServer();
server.run().catch(error => {
    console.error("Failed to start server:", error);
    process.exit(1);
});
