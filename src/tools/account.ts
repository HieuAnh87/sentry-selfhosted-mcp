// Account Tools — token and connection check

import { sentryClient } from '../api/client.js';
import { ORG_SLUG, BASE_URL, READ_ONLY } from '../config.js';
import type { ToolDefinition, ToolResult } from '../api/types.js';
import { isValidWhoamiArgs } from '../helpers/index.js';
import { truncatedTextResult } from './issues.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// ============================================================
// Tool Definitions
// ============================================================

export const whoami_tool: ToolDefinition = {
  name: 'whoami',
  description: 'Check the Sentry connection: the user the token belongs to, the token\'s scopes, whether the configured organization is reachable, and which tools the scopes rule out. Call this first when other tools fail with 401/403.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

// ============================================================
// Scope Requirements
// ============================================================

// Scope each tool needs, per the README token-scope table. Tools needing only
// `event:read` are omitted from the write list; raw_sentry_api is bounded by the token.
const TOOL_SCOPES: Record<string, string> = {
  update_sentry_issue_status: 'event:write',
  create_sentry_issue_comment: 'event:write',
  bulk_update_issues: 'event:write',
  merge_issues: 'event:write',
  list_releases: 'project:releases',
  get_release_details: 'project:releases',
  list_sentry_projects: 'org:read',
  list_teams: 'org:read',
};
const EVENT_READ_TOOLS = [
  'get_sentry_issue', 'list_sentry_issues', 'list_issues', 'get_issue_hashes', 'get_sentry_event_details',
  'list_issue_events', 'list_error_events', 'get_stack_frames', 'check_dsym_status', 'list_breadcrumbs',
  'get_issue_tags', 'get_issue_tag_values', 'list_activity', 'get_grouping_config', 'get_trace_details',
  'list_event_attachments', 'get_event_attachment', 'list_user_feedback',
];
for (const tool of EVENT_READ_TOOLS) TOOL_SCOPES[tool] = 'event:read';

const READ_ONLY_HIDDEN = new Set(['update_sentry_issue_status', 'create_sentry_issue_comment', 'bulk_update_issues', 'merge_issues']);

/** `event:write` and `event:admin` also grant `event:read`. */
function hasScope(scopes: string[], required: string): boolean {
  if (scopes.includes(required)) return true;
  const [resource, level] = required.split(':');
  if (level === 'read') return scopes.includes(`${resource}:write`) || scopes.includes(`${resource}:admin`);
  if (level === 'write') return scopes.includes(`${resource}:admin`);
  return false;
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

// ============================================================
// Tool Handlers
// ============================================================

export async function handleWhoami(args?: unknown): Promise<ToolResult> {
  if (!isValidWhoamiArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for whoami.');
  }

  // The root endpoint answers for any valid token; the org lookup proves the slug is reachable
  const [root, org] = await Promise.allSettled([
    sentryClient.getApiRoot(),
    sentryClient.getOrganization(ORG_SLUG),
  ]);
  if (root.status === 'rejected') throw root.reason;

  const auth = (root.value.auth ?? null) as Record<string, unknown> | null;
  const user = (root.value.user ?? null) as Record<string, unknown> | null;
  const scopes = Array.isArray(auth?.scopes) ? (auth.scopes as unknown[]).filter((s): s is string => typeof s === 'string') : undefined;

  const unavailable = scopes
    ? Object.entries(TOOL_SCOPES)
      .filter(([tool]) => !(READ_ONLY && READ_ONLY_HIDDEN.has(tool)))
      .filter(([, scope]) => !hasScope(scopes, scope))
      .map(([tool, scope]) => ({ tool, missing_scope: scope }))
    : undefined;

  return truncatedTextResult({
    sentry_url: BASE_URL,
    api_version: root.value.version,
    authenticated: Boolean(auth),
    user: user ? { id: user.id, name: user.name, username: user.username } : null,
    token_scopes: scopes ?? null,
    organization: org.status === 'fulfilled'
      ? { slug: org.value.slug, name: org.value.name, reachable: true }
      : { slug: ORG_SLUG, reachable: false, error: errorText(org.reason) },
    read_only_mode: READ_ONLY,
    tools_unavailable_with_these_scopes: unavailable,
    _note: scopes
      ? 'Scope requirements follow the README token-scope table; raw_sentry_api is limited only by the token.'
      : 'Sentry did not report scopes for this token (anonymous or a token type without scope info).',
  });
}
