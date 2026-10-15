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
// Helpers
// ============================================================

type Rec = Record<string, unknown>;

const isRecord = (value: unknown): value is Rec =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function shorten(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

const firstLine = (value: unknown, max: number): unknown =>
  typeof value === 'string' ? shorten(value.split('\n')[0], max) : value;

// Activity data keys that identify people rather than describe the change
const PERSONAL_DATA_KEY = /email|avatar|ip_?address/i;
const ACTIVITY_SUMMARY_MAX_KEYS = 8;

/**
 * Short, people-free description of an activity's `data`. Notes keep their
 * text, commits and pull requests a one-line identity; anything else keeps
 * scalar fields and a label for nested objects.
 */
function summarizeActivityData(data: unknown): Record<string, unknown> | undefined {
  if (!isRecord(data)) return undefined;

  if (isRecord(data.commit)) {
    const commit = data.commit;
    return {
      ...(typeof data.version === 'string' ? { version: data.version } : {}),
      commit: { id: typeof commit.id === 'string' ? commit.id.slice(0, 12) : commit.id, message: firstLine(commit.message, 100) },
    };
  }
  if (isRecord(data.pullRequest)) {
    return { pullRequest: { id: data.pullRequest.id, title: firstLine(data.pullRequest.title, 100) } };
  }

  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (Object.keys(summary).length >= ACTIVITY_SUMMARY_MAX_KEYS) break;
    if (PERSONAL_DATA_KEY.test(key) || value === null || value === undefined) continue;
    if (key === 'mentions') continue;
    if (typeof value === 'string') summary[key] = shorten(value, key === 'text' ? 300 : 120);
    else if (typeof value === 'number' || typeof value === 'boolean') summary[key] = value;
    else if (Array.isArray(value)) summary[key] = `[${value.length} items]`;
    else if (isRecord(value)) {
      const label = value.version ?? value.name ?? value.title ?? value.slug ?? value.id;
      if (label !== undefined) summary[key] = typeof label === 'string' ? shorten(label, 120) : label;
    }
  }
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function activityActor(activity: Rec): unknown {
  const user = isRecord(activity.user) ? activity.user : undefined;
  const app = isRecord(activity.sentry_app) ? activity.sentry_app : undefined;
  return user?.name || user?.username || app?.name || null;
}

// ============================================================
// Tool Handlers
// ============================================================

export async function handleListTeams(): Promise<ToolResult> {
  console.error(`Listing teams in org ${ORG_SLUG}`);
  const page = await sentryClient.listTeams(ORG_SLUG);
  const raw: unknown = page.data;
  const teams = (Array.isArray(raw) ? raw : []).filter(isRecord).map(team => {
    const projects = Array.isArray(team.projects)
      ? team.projects.filter(isRecord).map(project => project.slug)
      : undefined;
    return {
      id: team.id,
      slug: team.slug,
      name: team.name,
      memberCount: team.memberCount,
      projects,
    };
  });

  return truncatedTextResult({
    returned_teams: teams.length,
    teams,
    _note: page.hasMore && page.nextCursor
      ? `More teams exist. Fetch the next page with raw_sentry_api (endpoint 'organizations/${ORG_SLUG}/teams/', params {"cursor": "${page.nextCursor}", "detailed": "0"}).`
      : undefined,
  });
}

export async function handleGetIssueTags(args: unknown): Promise<ToolResult> {
  if (!isValidGetIssueTagsArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for get_issue_tags.');
  }

  console.error(`Fetching tags for issue ${args.issue_id}`);
  const raw: unknown = await sentryClient.getIssueTags(args.issue_id);
  const tags = (Array.isArray(raw) ? raw : []).filter(isRecord);

  return truncatedTextResult({
    issue_id: args.issue_id,
    tags: tags.map(tag => ({
      key: tag.key,
      name: tag.name,
      topValues: Array.isArray(tag.topValues)
        ? tag.topValues.slice(0, 5).filter(isRecord).map(v => ({ value: v.value, count: v.count }))
        : [],
      totalValues: tag.totalValues,
      uniqueValues: tag.uniqueValues,
    })),
    explanation: 'Tags are key/value pairs that help identify patterns. totalValues is the number of events carrying the tag; uniqueValues the number of distinct values. Use get_issue_tag_values to see full distribution for a specific tag.',
  });
}

/** Tag key details (`totalValues` = events carrying the tag, `uniqueValues` = distinct values). */
async function fetchTagKeyDetails(issueId: string, tagKey: string): Promise<Rec | undefined> {
  const path = `organizations/${encodeURIComponent(ORG_SLUG)}/issues/${encodeURIComponent(issueId)}/tags/${encodeURIComponent(tagKey)}/`;
  try {
    const details: unknown = await sentryClient.get<unknown>(path);
    return isRecord(details) ? details : undefined;
  } catch (error) {
    console.error(`Tag key details unavailable for "${tagKey}" on issue ${issueId}: ${error instanceof Error ? error.message : 'unknown error'}`);
    return undefined;
  }
}

export async function handleGetIssueTagValues(args: unknown): Promise<ToolResult> {
  if (!isValidGetIssueTagValuesArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for get_issue_tag_values.');
  }

  const limit = args.limit ?? 10;
  // Sentry pages with `per_page`, and orders by id unless asked to sort by count.
  const params: Record<string, string | number> = { limit, per_page: limit, sort: 'count' };

  console.error(`Fetching tag values for key "${args.tag_key}" on issue ${args.issue_id}`);
  const [page, details] = await Promise.all([
    sentryClient.getIssueTagValues(args.issue_id, args.tag_key, params),
    fetchTagKeyDetails(args.issue_id, args.tag_key),
  ]);

  const values = Array.isArray(page.data) ? page.data : [];
  const returned = values.slice(0, limit);
  const pageSum = values.reduce((sum, v) => sum + (typeof v.count === 'number' ? v.count : 0), 0);
  const totalValues = typeof details?.totalValues === 'number' ? details.totalValues : undefined;
  const uniqueValues = typeof details?.uniqueValues === 'number' ? details.uniqueValues : undefined;
  const total = totalValues ?? pageSum;

  const notes: string[] = [];
  if (totalValues === undefined) {
    notes.push('Tag totals were unavailable, so percentages are relative to the returned values only, not to all events.');
  }
  const distinct = uniqueValues ?? values.length;
  if (uniqueValues !== undefined && returned.length < uniqueValues) {
    notes.push(`Showing the ${returned.length} most frequent of ${uniqueValues} distinct values.`);
  } else if (uniqueValues === undefined && (page.hasMore || returned.length < values.length)) {
    notes.push(`Showing the ${returned.length} most frequent values; more exist.`);
  }

  return truncatedTextResult({
    issue_id: args.issue_id,
    tag_key: args.tag_key,
    total_count: total,
    total_count_source: totalValues !== undefined ? 'tag_key_details' : 'returned_values',
    total_values: distinct,
    returned_values: returned.length,
    values: returned.map(v => {
      const count = typeof v.count === 'number' ? v.count : 0;
      return {
        value: v.value,
        count,
        percentage: total > 0 ? ((count / total) * 100).toFixed(1) + '%' : '0%',
        lastSeen: v.lastSeen,
      };
    }),
    _note: notes.length > 0 ? notes.join(' ') : undefined,
  });
}

export async function handleListActivity(args: unknown): Promise<ToolResult> {
  if (!isValidListActivityArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for list_activity.');
  }

  const limit = args.limit ?? 25;
  const params: Record<string, string | number> = { limit, per_page: limit };
  if (args.cursor) params.cursor = args.cursor;

  console.error(`Fetching activity for issue ${args.issue_id}`);
  const page = await sentryClient.listIssueActivity(args.issue_id, params);

  // Sentry answers `{activity: [...]}` (newest first, at most 100); accept a bare list too.
  const raw: unknown = page.data;
  const all = (Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.activity) ? raw.activity : [])
    .filter(isRecord);
  const shown = all.slice(0, limit);

  return truncatedTextResult({
    issue_id: args.issue_id,
    total_activities: all.length,
    returned_activities: shown.length,
    activities: shown.map(activity => ({
      id: activity.id,
      type: activity.type,
      dateCreated: activity.dateCreated,
      user: activityActor(activity),
      data: summarizeActivityData(activity.data),
    })),
    _note: shown.length < all.length
      ? `Showing the ${shown.length} most recent of ${all.length} activities. Raise limit (max 100) to see more.`
      : undefined,
  }, page);
}

