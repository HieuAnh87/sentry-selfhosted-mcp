// Release-related MCP tools

import { sentryClient } from '../api/client.js';
import { ORG_SLUG } from '../config.js';
import { truncateResponse } from '../helpers/truncate.js';
import type { ToolDefinition, ToolResult } from '../api/types.js';
import { isValidListReleasesArgs, isValidGetReleaseArgs } from '../helpers/index.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// ============================================================
// Tool Definitions
// ============================================================

export const list_releases_tool: ToolDefinition = {
  name: 'list_releases',
  description: 'List releases in the organization. Releases link code deployments to error data.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Optional search filter on release version.',
      },
      date: {
        type: 'string',
        enum: ['adopted', 'unadopted'],
        description: 'Filter by adoption status.',
      },
      limit: {
        type: 'number',
        description: 'Max releases (1-100, default: 25).',
        minimum: 1,
        maximum: 100,
        default: 25,
      },
      cursor: { type: 'string', description: 'Pagination cursor.' },
      sort: {
        type: 'string',
        enum: ['date', 'semver'],
        description: 'Sort order (default: date).',
        default: 'date',
      },
    },
    required: [],
  },
};

export const get_release_details_tool: ToolDefinition = {
  name: 'get_release_details',
  description: 'Get detailed information about a release including health stats, commits, and authors.',
  inputSchema: {
    type: 'object',
    properties: {
      version: {
        type: 'string',
        description: 'Release version (e.g., "1.2.3" or full commit SHA).',
      },
      full: {
        type: 'boolean',
        description: 'Include full commit and author data (default: false).',
        default: false,
      },
    },
    required: ['version'],
  },
};

// ============================================================
// Tool Handlers
// ============================================================

export async function handleListReleases(args: unknown): Promise<ToolResult> {
  if (!isValidListReleasesArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for list_releases.');
  }

  const params: Record<string, string | number> = {};
  if (args.query) params.query = args.query;
  if (args.date) params.date = args.date;
  if (args.limit) params.limit = args.limit;
  if (args.cursor) params.cursor = args.cursor;
  if (args.sort) params.sort = args.sort;

  console.error(`Listing releases in org ${ORG_SLUG}`);
  const response = await sentryClient.listReleases(ORG_SLUG, params);

  const { data, truncated, pagination_info } = truncateResponse(response);
  let resultText = JSON.stringify(data, null, 2);
  if (truncated && pagination_info) {
    resultText = `${pagination_info}\n\n${resultText}`;
  }

  return { content: [{ type: 'text', text: resultText }] };
}

export async function handleGetReleaseDetails(args: unknown): Promise<ToolResult> {
  if (!isValidGetReleaseArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for get_release_details.');
  }

  console.error(`Fetching release details for ${args.version}`);
  const release = await sentryClient.getRelease(ORG_SLUG, args.version);

  // Compact view by default, full view if requested
  const compactData = args.full
    ? release
    : {
        version: release.version,
        dateReleased: release.dateReleased,
        dateCreated: release.dateCreated,
        commitCount: release.commitCount,
        lastDeploy: release.lastDeploy,
        newGroups: release.newGroups,
        firstEvent: release.firstEvent,
        lastEvent: release.lastEvent,
        url: release.url,
        shortVersion: release.shortVersion,
        versionInfo: release.versionInfo,
        _note: 'Use full: true to include all fields including stats.',
      };

  return { content: [{ type: 'text', text: JSON.stringify(compactData, null, 2) }] };
}
