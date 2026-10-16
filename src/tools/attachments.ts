// Attachment & User Feedback Tools

import { AxiosError } from 'axios';
import { sentryClient } from '../api/client.js';
import type { SentryAttachment, SentryUserReport, ToolDefinition, ToolResult } from '../api/types.js';
import { isValidListAttachmentsArgs, isValidGetAttachmentArgs, isValidListUserFeedbackArgs, MAX_ATTACHMENT_CHARS } from '../helpers/index.js';
import { grepFilter } from '../helpers/grep.js';
import { truncatedTextResult } from './issues.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

const DEFAULT_ATTACHMENT_CHARS = 20_000;
// Downloads above this are refused outright; text beyond max_chars is cut after decoding
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;
const MAX_COMMENT_CHARS = 1000;
// Share of NUL / undecodable characters above which content is treated as binary
const BINARY_CHAR_RATIO = 0.01;
// Attachment types Sentry stores as binary crash/debug data
const BINARY_ATTACHMENT_TYPES = new Set(['event.minidump', 'event.applecrashreport.binary', 'unreal.context', 'unreal.logs']);

// ============================================================
// Tool Definitions
// ============================================================

export const list_event_attachments_tool: ToolDefinition = {
  name: 'list_event_attachments',
  description: 'List files attached to events (log files, minidumps, screenshots, view hierarchies). Pass issue_id for every attachment on an issue, or project_slug + event_id for one event. Read text attachments with get_event_attachment.',
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'string', description: 'Numeric issue ID or short ID (e.g. PROJ-1A2). Use instead of project_slug + event_id.' },
      project_slug: { type: 'string', description: 'Project slug (with event_id).' },
      event_id: { type: 'string', description: 'Event ID (with project_slug).' },
      limit: { type: 'number', description: 'Max attachments (1-100, default: 25).', minimum: 1, maximum: 100 },
      cursor: { type: 'string', description: 'Pagination cursor (next_cursor from a previous call).' },
    },
    required: [],
  },
};

export const get_event_attachment_tool: ToolDefinition = {
  name: 'get_event_attachment',
  description: 'Read the contents of a text attachment (e.g. a log file) on an event. Binary attachments such as minidumps are not returned; their metadata is. Use grep_pattern to return only matching lines from large logs.',
  inputSchema: {
    type: 'object',
    properties: {
      project_slug: { type: 'string', description: 'Project slug.' },
      event_id: { type: 'string', description: 'Event ID the attachment belongs to (event_id from list_event_attachments).' },
      attachment_id: { type: 'string', description: 'Attachment ID (id from list_event_attachments).' },
      grep_pattern: { type: 'string', description: 'Regex (case-insensitive): return only matching lines with context.' },
      max_chars: { type: 'number', description: `Max characters of content returned (1-${MAX_ATTACHMENT_CHARS}, default: ${DEFAULT_ATTACHMENT_CHARS}).`, minimum: 1, maximum: MAX_ATTACHMENT_CHARS },
    },
    required: ['project_slug', 'event_id', 'attachment_id'],
  },
};

export const list_user_feedback_tool: ToolDefinition = {
  name: 'list_user_feedback',
  description: 'List user feedback (what end users wrote when reporting a crash) for an issue or a whole project. Pass exactly one of issue_id or project_slug. Reporter emails are omitted.',
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'string', description: 'Numeric issue ID or short ID (e.g. PROJ-1A2).' },
      project_slug: { type: 'string', description: 'Project slug, for all feedback in the project.' },
      limit: { type: 'number', description: 'Max feedback entries (1-100, default: 25).', minimum: 1, maximum: 100 },
      cursor: { type: 'string', description: 'Pagination cursor (next_cursor from a previous call).' },
    },
    required: [],
  },
};

// ============================================================
// Utility Functions
// ============================================================

const compactAttachment = (a: SentryAttachment): Record<string, unknown> => ({
  id: a.id,
  event_id: a.event_id,
  name: a.name,
  type: a.type,
  mimetype: a.mimetype,
  size: a.size,
  dateCreated: a.dateCreated,
});

const pageParams = (limit: number | undefined, cursor: string | undefined): Record<string, string | number> => {
  const size = limit ?? 25;
  const params: Record<string, string | number> = { per_page: size, limit: size };
  if (cursor) params.cursor = cursor;
  return params;
};

/** UTF-8 text, or undefined when the bytes look binary. */
function decodeText(bytes: Buffer): string | undefined {
  const text = bytes.toString('utf8');
  if (text.length === 0) return text;
  let suspicious = 0;
  for (const char of text) {
    if (char === '\u0000' || char === '�') suspicious++;
  }
  return suspicious / text.length > BINARY_CHAR_RATIO ? undefined : text;
}

const isBinaryType = (a: SentryAttachment): boolean => {
  if (BINARY_ATTACHMENT_TYPES.has(a.type)) return true;
  const mime = a.mimetype ?? '';
  return /^(image|video|audio)\//.test(mime) || mime === 'application/x-minidump' || mime === 'application/zip';
};

// ============================================================
// Tool Handlers
// ============================================================

export async function handleListEventAttachments(args: unknown): Promise<ToolResult> {
  if (!isValidListAttachmentsArgs(args)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Invalid args for list_event_attachments: pass either issue_id, or project_slug together with event_id.'
    );
  }

  const params = pageParams(args.limit, args.cursor);
  const page = args.issue_id
    ? await sentryClient.listIssueAttachments(args.issue_id, params)
    : await sentryClient.listEventAttachments(args.project_slug!, args.event_id!, params);

  return truncatedTextResult({
    scope: args.issue_id ? { issue_id: args.issue_id } : { project_slug: args.project_slug, event_id: args.event_id },
    returned_attachments: page.data.length,
    attachments: page.data.map(compactAttachment),
    _note: page.data.length === 0
      ? 'No attachments. Sentry only has files the SDK uploaded with the event; reading them can also require the organization\'s attachments access role.'
      : undefined,
  }, page);
}

export async function handleGetEventAttachment(args: unknown): Promise<ToolResult> {
  if (!isValidGetAttachmentArgs(args)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid args for get_event_attachment: project_slug, event_id and a numeric attachment_id are required; max_chars is 1-${MAX_ATTACHMENT_CHARS}.`
    );
  }

  const meta = await sentryClient.getEventAttachment(args.project_slug, args.event_id, args.attachment_id);
  const attachment = compactAttachment(meta);

  if (isBinaryType(meta)) {
    return truncatedTextResult({
      attachment,
      content: null,
      _note: `This is a binary attachment (${meta.type}${meta.mimetype ? `, ${meta.mimetype}` : ''}); its contents are not returned. Download it from the Sentry UI to inspect it.`,
    });
  }
  if (meta.size > MAX_DOWNLOAD_BYTES) {
    return truncatedTextResult({
      attachment,
      content: null,
      _note: `The attachment is ${meta.size} bytes, above the ${MAX_DOWNLOAD_BYTES}-byte download limit. Download it from the Sentry UI.`,
    });
  }

  let bytes: Buffer;
  try {
    bytes = await sentryClient.downloadEventAttachment(args.project_slug, args.event_id, args.attachment_id, MAX_DOWNLOAD_BYTES);
  } catch (error) {
    const status = error instanceof AxiosError ? error.response?.status : undefined;
    if (status !== undefined && status >= 300 && status < 400) {
      return truncatedTextResult({
        attachment,
        content: null,
        _note: 'Sentry serves this attachment from external storage via a redirect, which this server does not follow with your token. Download it from the Sentry UI.',
      });
    }
    throw error;
  }

  const text = decodeText(bytes);
  if (text === undefined) {
    return truncatedTextResult({
      attachment,
      content: null,
      _note: 'The attachment content is binary; it is not returned. Download it from the Sentry UI.',
    });
  }

  if (args.grep_pattern) {
    return truncatedTextResult({ attachment, total_chars: text.length, grep: grepFilter(text.split('\n'), args.grep_pattern) });
  }

  const maxChars = args.max_chars ?? DEFAULT_ATTACHMENT_CHARS;
  const truncated = text.length > maxChars;
  return truncatedTextResult({
    attachment,
    total_chars: text.length,
    returned_chars: Math.min(text.length, maxChars),
    truncated,
    // The end of a log is usually nearest the crash, so keep the tail
    content: truncated ? text.slice(-maxChars) : text,
    _note: truncated
      ? `Showing the last ${maxChars} of ${text.length} characters. Use grep_pattern to search the whole file, or raise max_chars.`
      : undefined,
  });
}

export async function handleListUserFeedback(args: unknown): Promise<ToolResult> {
  if (!isValidListUserFeedbackArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for list_user_feedback: pass exactly one of issue_id or project_slug.');
  }

  const params = pageParams(args.limit, args.cursor);
  const page = args.issue_id
    ? await sentryClient.listIssueUserReports(args.issue_id, params)
    : await sentryClient.listProjectUserReports(args.project_slug!, params);

  const feedback = page.data.map((r: SentryUserReport) => {
    const issue = r.issue && typeof r.issue === 'object' ? r.issue : undefined;
    const comments = typeof r.comments === 'string' && r.comments.length > MAX_COMMENT_CHARS
      ? `${r.comments.slice(0, MAX_COMMENT_CHARS)}…`
      : r.comments;
    return {
      id: r.id,
      event_id: r.eventID,
      name: r.name,
      comments,
      dateCreated: r.dateCreated,
      issue: issue ? { id: issue.id, shortId: issue.shortId, title: issue.title } : undefined,
    };
  });

  return truncatedTextResult({
    scope: args.issue_id ? { issue_id: args.issue_id } : { project_slug: args.project_slug },
    returned_feedback: feedback.length,
    feedback,
    _note: feedback.length === 0
      ? "No user reports. Feedback sent through Sentry's newer User Feedback widget is stored as issues instead: search with list_issues and query 'issue.category:feedback'."
      : undefined,
  }, page);
}
