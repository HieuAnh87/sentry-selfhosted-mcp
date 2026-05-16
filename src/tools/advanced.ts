// Advanced MCP tools: trace, grouping, merge

import { sentryClient } from '../api/client.js';
import { ORG_SLUG } from '../config.js';
import { truncateResponse } from '../helpers/truncate.js';
import type { ToolDefinition, ToolResult } from '../api/types.js';
import { isValidGetTraceArgs, isValidMergeIssuesArgs, isValidGetGroupingConfigArgs } from '../helpers/index.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// ============================================================
// Tool Definitions
// ============================================================

export const get_trace_details_tool: ToolDefinition = {
  name: 'get_trace_details',
  description: 'Get distributed trace details with full span tree and timing information. Requires Performance data.',
  inputSchema: {
    type: 'object',
    properties: {
      trace_id: { type: 'string', description: 'Trace ID.' },
      max_spans: {
        type: 'number',
        description: 'Max spans to return (1-500, default: 100).',
        minimum: 1,
        maximum: 500,
        default: 100,
      },
    },
    required: ['trace_id'],
  },
};

export const get_grouping_config_tool: ToolDefinition = {
  name: 'get_grouping_config',
  description: 'Get the fingerprinting rules and grouping configuration for an issue. Shows why events are grouped together.',
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'string', description: 'Issue ID.' },
    },
    required: ['issue_id'],
  },
};

export const merge_issues_tool: ToolDefinition = {
  name: 'merge_issues',
  description: 'Merge multiple issues into one by fingerprint hash. Use after identifying that separate issues should be grouped together.',
  inputSchema: {
    type: 'object',
    properties: {
      issue_id: { type: 'string', description: 'Primary issue ID to merge into.' },
      target_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Issue IDs to merge from (max 10).',
        maxItems: 10,
      },
    },
    required: ['issue_id', 'target_ids'],
  },
};

// ============================================================
// Tool Handlers
// ============================================================

export async function handleGetTraceDetails(args: unknown): Promise<ToolResult> {
  if (!isValidGetTraceArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for get_trace_details.');
  }

  console.error(`Fetching trace ${args.trace_id}`);
  const trace = await sentryClient.getTrace(args.trace_id);

  const maxSpans = args.max_spans || 100;
  const spans = (trace.spans || []).slice(0, maxSpans);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        trace_id: trace.traceId,
        duration: trace.duration,
        startTimestamp: trace.startTimestamp,
        endTimestamp: trace.endTimestamp,
        total_spans: (trace.spans || []).length,
        returned_spans: spans.length,
        spans,
        _note: spans.length === 0 ? 'No spans found. This trace may not have performance data enabled.' : undefined,
      }, null, 2),
    }],
  };
}

export async function handleGetGroupingConfig(args: unknown): Promise<ToolResult> {
  if (!isValidGetGroupingConfigArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for get_grouping_config.');
  }

  console.error(`Fetching grouping config for issue ${args.issue_id}`);
  const configs = await sentryClient.getGroupingConfig(args.issue_id);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        issue_id: args.issue_id,
        configs: configs.map(cfg => ({
          id: cfg.id,
          name: cfg.name,
          enhancements: cfg.enhancements,
        })),
        explanation: 'These are the fingerprinting rules that determine how events are grouped into issues. The first matching rule wins.',
      }, null, 2),
    }],
  };
}

export async function handleMergeIssues(args: unknown): Promise<ToolResult> {
  if (!isValidMergeIssuesArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid args for merge_issues.');
  }

  console.error(`Merging issues: ${args.issue_id} <- ${args.target_ids.join(', ')}`);
  const response = await sentryClient.mergeIssues(args.issue_id, args.target_ids);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        merged: true,
        primary_issue_id: args.issue_id,
        merged_issue_ids: args.target_ids,
        response,
        explanation: 'Issues have been merged. All events from merged issues are now part of the primary issue.',
      }, null, 2),
    }],
  };
}
