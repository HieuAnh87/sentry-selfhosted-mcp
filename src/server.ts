// MCP Server — Tool registry and bootstrap

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, ListResourcesRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import axios, { AxiosError } from 'axios';

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
import { isValidRawApiArgs } from './helpers/index.js';
import { grepFilter } from './helpers/grep.js';
import { sentryClient } from './api/client.js';
import { ORG_SLUG, BASE_URL } from './config.js';
import type { ToolDefinition } from './api/types.js';

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
        description: "API endpoint path (e.g., 'projects/beoflow/apple-ios/events/abc123/'). Do NOT include /api/0/ prefix.",
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
  // Raw API
  raw_sentry_api_tool,
];

// ============================================================
// Server Class
// ============================================================

export class SelfHostedSentryServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: 'sentry-selfhosted-mcp',
        version: '1.2.0',
        description: 'MCP server for self-hosted Sentry instances with debugging-focused tools. 24 tools available.',
      },
      { capabilities: { resources: { list: true }, tools: {} } }
    );

    this.setupToolHandlers();
    this.setupResourceHandlers();
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => { await this.server.close(); process.exit(0); });
  }

  private setupToolHandlers() {
    // List tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS,
    }));

    // Call tool
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const args = request.params.arguments;

      try {
        switch (toolName) {
          // Issue tools
          case 'get_sentry_issue': return handleGetSentryIssue(args);
          case 'list_sentry_projects': return handleListSentryProjects();
          case 'list_sentry_issues': return handleListSentryIssues(args);
          case 'list_issues': return handleListIssues(args);
          case 'update_sentry_issue_status': return handleUpdateIssueStatus(args);
          case 'create_sentry_issue_comment': return handleCreateComment(args);
          case 'get_issue_hashes': return handleGetIssueHashes(args);
          case 'bulk_update_issues': return handleBulkUpdateIssues(args);

          // Event tools
          case 'get_sentry_event_details': return handleGetSentryEventDetails(args);
          case 'list_issue_events': return handleListIssueEvents(args);
          case 'list_error_events': return handleListErrorEvents(args);
          case 'get_stack_frames': return handleGetStackFrames(args);
          case 'check_dsym_status': return handleCheckDsymStatus(args);
          case 'list_breadcrumbs': return handleListBreadcrumbs(args);

          // Release tools
          case 'list_releases': return handleListReleases(args);
          case 'get_release_details': return handleGetReleaseDetails(args);

          // Org tools
          case 'list_teams': return handleListTeams();
          case 'get_issue_tags': return handleGetIssueTags(args);
          case 'get_issue_tag_values': return handleGetIssueTagValues(args);
          case 'list_activity': return handleListActivity(args);

          // Advanced tools
          case 'get_trace_details': return handleGetTraceDetails(args);
          case 'get_grouping_config': return handleGetGroupingConfig(args);
          case 'merge_issues': return handleMergeIssues(args);

          // Raw API
          case 'raw_sentry_api': return handleRawApi(args);

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
    console.error(`Self-hosted Sentry MCP server v1.2.0 running for org "${ORG_SLUG}" at ${BASE_URL}`);
  }
}

// ============================================================
// Raw API Handler
// ============================================================

async function handleRawApi(args: unknown) {
  if (!isValidRawApiArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for raw_sentry_api.');
  }

  const method = (args.method || 'GET').toUpperCase();
  console.error(`Raw API ${method} request to ${args.endpoint}`);

  let response;
  const config: Record<string, unknown> = {};
  if (args.params) config.params = args.params;

  switch (method) {
    case 'GET': response = await sentryClient.get(args.endpoint, args.params); break;
    case 'POST': response = await sentryClient.post(args.endpoint, args.body || {}, args.params); break;
    case 'PUT': response = await sentryClient.put(args.endpoint, args.body || {}); break;
    case 'DELETE': response = await sentryClient.delete(args.endpoint); break;
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

  return { content: [{ type: 'text', text: JSON.stringify(responseData, null, 2) }] };
}

// ============================================================
// Bootstrap
// ============================================================

const server = new SelfHostedSentryServer();
server.run().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
