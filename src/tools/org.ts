// Organization-level MCP tools: teams, tags, activity

import { sentryClient } from '../api/client.js';
import { ORG_SLUG } from '../config.js';
import type { ToolDefinition, ToolResult } from '../api/types.js';
import { isValidGetIssueTagsArgs, isValidGetIssueTagValuesArgs, isValidListActivityArgs } from '../helpers/index.js';
import { truncatedTextResult } from './issues.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// ============================================================
// Tool Definitions
// ============================================================

export const list_teams_tool: ToolDefinition = {
  name: 'list_teams',
  description: 'List all teams in the organization.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const get_issue_tags_tool: ToolDefinition = {
  name: 'get_issue_tags',
  description: 'List all tags captured for an issue. Tags help identify patterns (e.g., environment, OS, user segment affected).',
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'string', description: 'Issue ID.' },
    },
    required: ['issue_id'],
  },
};

export const get_issue_tag_values_tool: ToolDefinition = {
  name: 'get_issue_tag_values',
  description: 'Get tag value distribution for a specific tag key. Shows which values occur most frequently for an issue.',
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'string', description: 'Issue ID.' },
      tag_key: {
        type: 'string',
        description: 'Tag key (e.g., "environment", "release", "user.email", "os.name").',
      },
      limit: {
        type: 'number',
        description: 'Max values to return (1-100, default: 10).',
        minimum: 1,
        maximum: 100,
        default: 10,
      },
    },
    required: ['issue_id', 'tag_key'],
  },
};

export const list_activity_tool: ToolDefinition = {
  name: 'list_activity',
  description: 'List activity log for an issue. Shows comments, assignments, status changes, and other events.',
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'string', description: 'Issue ID.' },
      limit: {
        type: 'number',
        description: 'Max activities (1-100, default: 25).',
        minimum: 1,
        maximum: 100,
        default: 25,
      },
      cursor: { type: 'string', description: 'Pagination cursor.' },
    },
    required: ['issue_id'],
  },
};

// ============================================================
// Tool Handlers
// ============================================================

export async function handleListTeams(): Promise<ToolResult> {
  console.error(`Listing teams in org ${ORG_SLUG}`);
  const teams = await sentryClient.listTeams(ORG_SLUG);
  return { content: [{ type: 'text', text: JSON.stringify(teams, null, 2) }] };
}

export async function handleGetIssueTags(args: unknown): Promise<ToolResult> {
  if (!isValidGetIssueTagsArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for get_issue_tags.');
  }

  console.error(`Fetching tags for issue ${args.issue_id}`);
  const tags = await sentryClient.getIssueTags(args.issue_id);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        issue_id: args.issue_id,
        tags: tags.map(tag => ({
          key: tag.key,
          name: tag.name,
          topValues: tag.topValues.slice(0, 5),
          totalValues: tag.totalValues,
        })),
        explanation: 'Tags are key/value pairs that help identify patterns. Use get_issue_tag_values to see full distribution for a specific tag.',
      }, null, 2),
    }],
  };
}

export async function handleGetIssueTagValues(args: unknown): Promise<ToolResult> {
  if (!isValidGetIssueTagValuesArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for get_issue_tag_values.');
  }

  const limit = args.limit !== undefined ? args.limit : 10;
  const params: Record<string, number> = { limit };

  console.error(`Fetching tag values for key "${args.tag_key}" on issue ${args.issue_id}`);
  const values = await sentryClient.getIssueTagValues(args.issue_id, args.tag_key, params);

  const total = values.reduce((sum, v) => sum + v.count, 0);
  const returned = values.slice(0, limit);

  return truncatedTextResult({
    issue_id: args.issue_id,
    tag_key: args.tag_key,
    total_count: total,
    total_values: values.length,
    returned_values: returned.length,
    values: returned.map(v => ({
      value: v.value,
      count: v.count,
      percentage: total > 0 ? ((v.count / total) * 100).toFixed(1) + '%' : '0%',
      lastSeen: v.lastSeen,
    })),
    _note: returned.length < values.length
      ? `Showing ${returned.length} of ${values.length} values; percentages are relative to total_count.`
      : undefined,
  });
}

export async function handleListActivity(args: unknown): Promise<ToolResult> {
  if (!isValidListActivityArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for list_activity.');
  }

  const params: Record<string, string | number> = {};
  if (args.limit !== undefined) params.limit = args.limit;
  if (args.cursor) params.cursor = args.cursor;
  if (params.limit === undefined) params.limit = 25;

  console.error(`Fetching activity for issue ${args.issue_id}`);
  const activities = await sentryClient.listIssueActivity(args.issue_id, params);

  return truncatedTextResult(activities);
}
