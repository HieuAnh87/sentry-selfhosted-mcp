// MCP Server — Tool registry and bootstrap

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, ListResourcesRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';

// Tools
import {
  get_sentry_issue_tool,
  list_sentry_projects_tool,
  list_sentry_issues_tool,
  list_issues_tool,
  update_sentry_issue_status_tool,
  create_sentry_issue_comment_tool,
  get_issue_hashes_tool,
  bulk_update_issues_tool,
  handleGetSentryIssue,
  handleListSentryProjects,
  handleListSentryIssues,
  handleListIssues,
  handleUpdateIssueStatus,
  handleCreateComment,
  handleGetIssueHashes,
  handleBulkUpdateIssues,
  handleToolError,
  estimateTokens,
  generateGrepSuggestions,
} from './tools/issues.js';

import {
  get_sentry_event_details_tool,
  list_issue_events_tool,
  list_error_events_tool,
  get_stack_frames_tool,
  check_dsym_status_tool,
  list_breadcrumbs_tool,
  handleGetSentryEventDetails,
  handleListIssueEvents,
  handleListErrorEvents,
  handleGetStackFrames,
  handleCheckDsymStatus,
  handleListBreadcrumbs,
} from './tools/events.js';

import {
  list_releases_tool,
  get_release_details_tool,
  handleListReleases,
  handleGetReleaseDetails,
} from './tools/releases.js';

import {
  list_teams_tool,
  get_issue_tags_tool,
  get_issue_tag_values_tool,
  list_activity_tool,
  handleListTeams,
  handleGetIssueTags,
  handleGetIssueTagValues,
  handleListActivity,
} from './tools/org.js';

import {
  get_trace_details_tool,
  get_grouping_config_tool,
  merge_issues_tool,
  handleGetTraceDetails,
  handleGetGroupingConfig,
  handleMergeIssues,
} from './tools/advanced.js';

// Helpers
// Account & attachment tools
import { whoami_tool, handleWhoami } from './tools/account.js';
import {
  list_event_attachments_tool,
  get_event_attachment_tool,
  list_user_feedback_tool,
  handleListEventAttachments,
  handleGetEventAttachment,
  handleListUserFeedback,
} from './tools/attachments.js';

import { isValidRawApiArgs } from './helpers/index.js';
import { grepFilter } from './helpers/grep.js';
import { sentryClient } from './api/client.js';
import { ORG_SLUG, BASE_URL, READ_ONLY } from './config.js';
import type { ToolDefinition, ToolAnnotations } from './api/types.js';

// ============================================================
// Raw API Tool
// ============================================================

const raw_sentry_api_tool: ToolDefinition = {
  name: 'raw_sentry_api',
  description: 'Make a raw API call to any Sentry endpoint. Returns unfiltered JSON. WARNING: Event endpoints can return 100K+ tokens. Use grep_pattern for events.',
  inputSchema: {
    type: 'object',
    properties: {
      endpoint: {
        type: 'string',
        description: "API endpoint path (e.g., 'projects/your-org/your-project/events/abc123/'). Do NOT include /api/0/ prefix.",
      },
      method: {
        type: 'string',
        enum: ['GET', 'POST', 'PUT', 'DELETE'],
        description: 'HTTP method (default: GET)',
        default: 'GET',
      },
      params: { type: 'object', description: 'URL query parameters.' },
      body: { type: 'object', description: 'Request body for POST/PUT.' },
      grep_pattern: {
        type: 'string',
        description: 'CRITICAL for event endpoints: Regex to filter response.',
      },
    },
    required: ['endpoint'],
  },
};

// ============================================================
// Tool Registry
// ============================================================

const TOOLS: ToolDefinition[] = [
  // Issue tools
  get_sentry_issue_tool,
  list_sentry_projects_tool,
  list_sentry_issues_tool,
  list_issues_tool,
  update_sentry_issue_status_tool,
  create_sentry_issue_comment_tool,
  get_issue_hashes_tool,
  bulk_update_issues_tool,
  // Event tools
  get_sentry_event_details_tool,
  list_issue_events_tool,
  list_error_events_tool,
  get_stack_frames_tool,
  check_dsym_status_tool,
  list_breadcrumbs_tool,
  // Release tools
  list_releases_tool,
  get_release_details_tool,
  // Org tools
  list_teams_tool,
  get_issue_tags_tool,
  get_issue_tag_values_tool,
  list_activity_tool,
  // Advanced tools
  get_trace_details_tool,
  get_grouping_config_tool,
  merge_issues_tool,
  // Attachment & feedback tools
  list_event_attachments_tool,
  get_event_attachment_tool,
  list_user_feedback_tool,
  // Account
  whoami_tool,
  // Raw API
  raw_sentry_api_tool,
];

// MCP annotations. The spec defaults destructiveHint to true, so every tool states it.
// Tools without readOnlyHint are mutating: refused and hidden under SENTRY_READ_ONLY.
const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  get_sentry_issue: { title: 'Get issue', ...READ },
  list_sentry_projects: { title: 'List projects', ...READ },
  list_sentry_issues: { title: 'List project issues', ...READ },
  list_issues: { title: 'Search issues', ...READ },
  update_sentry_issue_status: { title: 'Set issue status', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  create_sentry_issue_comment: { title: 'Comment on issue', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  get_issue_hashes: { title: 'Get issue hashes', ...READ },
  bulk_update_issues: { title: 'Bulk update issues', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  get_sentry_event_details: { title: 'Get event', ...READ },
  list_issue_events: { title: 'List issue events', ...READ },
  list_error_events: { title: 'List project events', ...READ },
  get_stack_frames: { title: 'Get stack frames', ...READ },
  check_dsym_status: { title: 'Check debug symbols', ...READ },
  list_breadcrumbs: { title: 'List breadcrumbs', ...READ },
  list_releases: { title: 'List releases', ...READ },
  get_release_details: { title: 'Get release', ...READ },
  list_teams: { title: 'List teams', ...READ },
  get_issue_tags: { title: 'Get issue tags', ...READ },
  get_issue_tag_values: { title: 'Get tag values', ...READ },
  list_activity: { title: 'List issue activity', ...READ },
  get_trace_details: { title: 'Get trace', ...READ },
  get_grouping_config: { title: 'Explain grouping', ...READ },
  list_event_attachments: { title: 'List attachments', ...READ },
  get_event_attachment: { title: 'Read attachment', ...READ },
  list_user_feedback: { title: 'List user feedback', ...READ },
  whoami: { title: 'Check connection and token', ...READ },
  merge_issues: { title: 'Merge issues', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  // GET-only under SENTRY_READ_ONLY; otherwise it can PUT/POST/DELETE anything the token allows
  raw_sentry_api: READ_ONLY
    ? { title: 'Raw Sentry API (GET only)', ...READ }
    : { title: 'Raw Sentry API', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

// Tools refused when SENTRY_READ_ONLY is enabled (raw_sentry_api is restricted to GET instead)
const MUTATING_TOOLS = TOOLS
  .map(tool => tool.name)
  .filter(name => name !== 'raw_sentry_api' && !TOOL_ANNOTATIONS[name]?.readOnlyHint);

const LISTED_TOOLS: ToolDefinition[] = TOOLS
  .filter(tool => !(READ_ONLY && MUTATING_TOOLS.includes(tool.name)))
  .map(tool => ({ ...tool, annotations: TOOL_ANNOTATIONS[tool.name] }));

// ============================================================
// Server Class
// ============================================================

const SERVER_VERSION = '1.2.0';

export class SelfHostedSentryServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: 'sentry-selfhosted-mcp',
        version: SERVER_VERSION,
        description: `MCP server for self-hosted Sentry instances with debugging-focused tools. ${LISTED_TOOLS.length} tools available${READ_ONLY ? ' (read-only)' : ''}.`,
      },
      // `resources` takes only subscribe/listChanged flags; the empty object declares plain listing
      { capabilities: { resources: {}, tools: {} } }
    );

    this.setupToolHandlers();
    this.setupResourceHandlers();
    // Log the message only: inspecting the error object would print the Authorization header
    this.server.onerror = (error) => console.error('[MCP Error]', error instanceof Error ? error.message : String(error));
    process.on('SIGINT', async () => { await this.server.close(); process.exit(0); });
  }

  private setupToolHandlers() {
    // List tools
    // Mutating tools are hidden under SENTRY_READ_ONLY so agents don't plan around them
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: LISTED_TOOLS,
    }));

    // Call tool
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const args = request.params.arguments;

      if (READ_ONLY && MUTATING_TOOLS.includes(toolName)) {
        throw new McpError(ErrorCode.InvalidRequest, `Tool "${toolName}" is disabled: server is running in read-only mode (SENTRY_READ_ONLY).`);
      }

      try {
        // Every case must `await` so rejections reach the catch below
        switch (toolName) {
          // Issue tools
          case 'get_sentry_issue': return await handleGetSentryIssue(args);
          case 'list_sentry_projects': return await handleListSentryProjects(args);
          case 'list_sentry_issues': return await handleListSentryIssues(args);
          case 'list_issues': return await handleListIssues(args);
          case 'update_sentry_issue_status': return await handleUpdateIssueStatus(args);
          case 'create_sentry_issue_comment': return await handleCreateComment(args);
          case 'get_issue_hashes': return await handleGetIssueHashes(args);
          case 'bulk_update_issues': return await handleBulkUpdateIssues(args);

          // Event tools
          case 'get_sentry_event_details': return await handleGetSentryEventDetails(args);
          case 'list_issue_events': return await handleListIssueEvents(args);
          case 'list_error_events': return await handleListErrorEvents(args);
          case 'get_stack_frames': return await handleGetStackFrames(args);
          case 'check_dsym_status': return await handleCheckDsymStatus(args);
          case 'list_breadcrumbs': return await handleListBreadcrumbs(args);

          // Release tools
          case 'list_releases': return await handleListReleases(args);
          case 'get_release_details': return await handleGetReleaseDetails(args);

          // Org tools
          case 'list_teams': return await handleListTeams();
          case 'get_issue_tags': return await handleGetIssueTags(args);
          case 'get_issue_tag_values': return await handleGetIssueTagValues(args);
          case 'list_activity': return await handleListActivity(args);

          // Advanced tools
          case 'get_trace_details': return await handleGetTraceDetails(args);
          case 'get_grouping_config': return await handleGetGroupingConfig(args);
          case 'merge_issues': return await handleMergeIssues(args);

          // Attachment & feedback tools
          case 'list_event_attachments': return await handleListEventAttachments(args);
          case 'get_event_attachment': return await handleGetEventAttachment(args);
          case 'list_user_feedback': return await handleListUserFeedback(args);

          // Account
          case 'whoami': return await handleWhoami(args);

          // Raw API
          case 'raw_sentry_api': return await handleRawApi(args);

          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
        }
      } catch (error) {
        if (error instanceof McpError) throw error;
        return handleToolError(error, toolName);
      }
    });
  }

  private setupResourceHandlers() {
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [],
    }));
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(`Self-hosted Sentry MCP server v${SERVER_VERSION} running for org "${ORG_SLUG}" at ${BASE_URL}${READ_ONLY ? ' (read-only)' : ''}`);
  }
}

// ============================================================
// Raw API Handler
// ============================================================

// Same shape axios uses to decide a URL is absolute; such a URL bypasses baseURL
// while still carrying the Authorization header, so it must never reach the client.
const ABSOLUTE_URL_PATTERN = /^([a-z][a-z\d+\-.]*:)?\/\//i;
const RAW_API_BASE_URL = new URL(`${BASE_URL}/api/0/`);
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  const relative = trimmed.replace(/^\/(?!\/)/, '');

  let resolved: URL;
  try {
    resolved = new URL(relative, RAW_API_BASE_URL);
  } catch {
    throw new McpError(ErrorCode.InvalidParams, 'endpoint must be a valid relative Sentry API path.');
  }

  if (
    !relative ||
    CONTROL_CHARACTER_PATTERN.test(trimmed) ||
    trimmed.includes('\\') ||
    ABSOLUTE_URL_PATTERN.test(trimmed) ||
    resolved.origin !== RAW_API_BASE_URL.origin ||
    !resolved.pathname.startsWith(RAW_API_BASE_URL.pathname)
  ) {
    throw new McpError(ErrorCode.InvalidParams, 'endpoint must remain within the configured Sentry /api/0/ path.');
  }

  return relative;
}

async function handleRawApi(args: unknown) {
  if (!isValidRawApiArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for raw_sentry_api.');
  }

  const endpoint = normalizeEndpoint(args.endpoint);
  const method = (args.method || 'GET').toUpperCase();

  if (READ_ONLY && method !== 'GET') {
    throw new McpError(ErrorCode.InvalidRequest, `raw_sentry_api ${method} is disabled: server is running in read-only mode (SENTRY_READ_ONLY).`);
  }

  console.error(`Raw API ${method} request to ${endpoint}`);

  let response;

  switch (method) {
    case 'GET': response = await sentryClient.get(endpoint, args.params); break;
    case 'POST': response = await sentryClient.post(endpoint, args.body || {}, args.params); break;
    case 'PUT': response = await sentryClient.put(endpoint, args.body || {}); break;
    case 'DELETE': response = await sentryClient.delete(endpoint); break;
    default:
      throw new McpError(ErrorCode.InvalidParams, `Unsupported HTTP method: ${method}`);
  }

  let responseData = response;

  const jsonString = JSON.stringify(responseData, null, 2);
  const estimatedTokens = estimateTokens(jsonString);

  if (estimatedTokens > 50000 && !args.grep_pattern) {
    console.error(`WARNING: Response is ~${estimatedTokens} tokens.`);
    return {
      content: [{
        type: 'text',
        text: `⚠️ WARNING: Response is approximately ${estimatedTokens} tokens (limit: 50,000).\n\n${generateGrepSuggestions()}`,
      }],
    };
  }

  if (args.grep_pattern) {
    console.error(`Applying grep pattern filter: ${args.grep_pattern}`);
    responseData = grepFilter(responseData, args.grep_pattern);
  }

  return { content: [{ type: 'text', text: JSON.stringify(responseData) }] };
}

// ============================================================
// Bootstrap
// ============================================================

const server = new SelfHostedSentryServer();
server.run().catch((error) => {
  console.error('Failed to start server:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
