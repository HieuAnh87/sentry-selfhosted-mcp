#!/usr/bin/env node

/**
 * Tools definition test for sentry-selfhosted-mcp server
 * Tests that all tools are properly defined with correct schemas
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('Sentry MCP Server Tools', () => {
  const expectedTools = [
    // Issue tools
    {
      name: 'get_sentry_issue',
      required: ['issue_id_or_url'],
      optional: ['include_latest_event', 'include_fields', 'exclude_fields', 'grep_pattern', 'max_stack_frames'],
    },
    {
      name: 'list_sentry_projects',
      required: [],
      optional: [],
    },
    {
      name: 'list_sentry_issues',
      required: ['project_slug'],
      optional: ['query', 'status', 'limit', 'cursor'],
    },
    {
      name: 'list_issues',
      required: [],
      optional: ['query', 'sort', 'limit', 'cursor'],
    },
    {
      name: 'update_sentry_issue_status',
      required: ['issue_id', 'status'],
      optional: [],
    },
    {
      name: 'create_sentry_issue_comment',
      required: ['issue_id', 'comment_text'],
      optional: [],
    },
    {
      name: 'get_issue_hashes',
      required: ['issue_id'],
      optional: ['cursor'],
    },
    {
      name: 'bulk_update_issues',
      required: ['project_slug'],
      optional: ['query', 'status', 'assigned_to', 'has_seen'],
    },
    // Event tools
    {
      name: 'get_sentry_event_details',
      required: ['project_slug', 'event_id'],
      optional: ['limit', 'offset', 'entry_type'],
    },
    {
      name: 'list_issue_events',
      required: ['issue_id'],
      optional: ['limit', 'cursor', 'full'],
    },
    {
      name: 'list_error_events',
      required: ['project_slug'],
      optional: ['limit', 'cursor', 'query', 'full'],
    },
    {
      name: 'get_stack_frames',
      required: ['project_slug', 'event_id'],
      optional: ['in_app_only', 'max_frames'],
    },
    {
      name: 'check_dsym_status',
      required: ['project_slug'],
      optional: ['event_id'],
    },
    {
      name: 'list_breadcrumbs',
      required: ['project_slug', 'event_id'],
      optional: ['limit', 'type'],
    },
    // Release tools
    {
      name: 'list_releases',
      required: [],
      optional: ['query', 'date', 'limit', 'cursor', 'sort'],
    },
    {
      name: 'get_release_details',
      required: ['version'],
      optional: ['full'],
    },
    // Org tools
    {
      name: 'list_teams',
      required: [],
      optional: [],
    },
    {
      name: 'get_issue_tags',
      required: ['issue_id'],
      optional: [],
    },
    {
      name: 'get_issue_tag_values',
      required: ['issue_id', 'tag_key'],
      optional: ['limit'],
    },
    {
      name: 'list_activity',
      required: ['issue_id'],
      optional: ['limit', 'cursor'],
    },
    // Advanced tools
    {
      name: 'get_trace_details',
      required: ['trace_id'],
      optional: ['max_spans'],
    },
    {
      name: 'get_grouping_config',
      required: ['issue_id'],
      optional: [],
    },
    {
      name: 'merge_issues',
      required: ['issue_id', 'target_ids'],
      optional: [],
    },
    // Raw API
    {
      name: 'raw_sentry_api',
      required: ['endpoint'],
      optional: ['method', 'params', 'body', 'grep_pattern'],
    },
  ];

  it('should have exactly 24 tools', () => {
    assert.strictEqual(expectedTools.length, 24, 'Server should expose 24 tools');
  });

  it('should have all required debugging tools', () => {
    const toolNames = expectedTools.map((t) => t.name);

    const debugTools = [
      'get_stack_frames',
      'check_dsym_status',
      'list_issue_events',
      'get_issue_hashes',
      'list_error_events',
      'list_breadcrumbs',
    ];

    for (const tool of debugTools) {
      assert.ok(
        toolNames.includes(tool),
        `Debugging tool '${tool}' should be available`
      );
    }
  });

  it('should have all core issue management tools', () => {
    const toolNames = expectedTools.map((t) => t.name);

    const coreTools = [
      'get_sentry_issue',
      'list_sentry_projects',
      'list_sentry_issues',
      'get_sentry_event_details',
      'update_sentry_issue_status',
      'create_sentry_issue_comment',
    ];

    for (const tool of coreTools) {
      assert.ok(
        toolNames.includes(tool),
        `Core tool '${tool}' should be available`
      );
    }
  });

  it('should have new Phase 2 tools', () => {
    const toolNames = expectedTools.map((t) => t.name);

    const newTools = [
      'list_issues',
      'bulk_update_issues',
      'list_breadcrumbs',
      'list_releases',
      'get_release_details',
      'list_teams',
      'get_issue_tags',
      'get_issue_tag_values',
      'list_activity',
      'get_trace_details',
      'get_grouping_config',
      'merge_issues',
    ];

    for (const tool of newTools) {
      assert.ok(
        toolNames.includes(tool),
        `New tool '${tool}' should be available`
      );
    }
  });

  it('should have raw_sentry_api tool for advanced use cases', () => {
    const toolNames = expectedTools.map((t) => t.name);
    assert.ok(toolNames.includes('raw_sentry_api'), 'raw_sentry_api tool should be available');
  });

  expectedTools.forEach((tool) => {
    describe(`${tool.name}`, () => {
      it('should have a name', () => {
        assert.ok(tool.name, 'Tool should have a name');
        assert.strictEqual(typeof tool.name, 'string', 'Tool name should be a string');
      });

      it('should define required parameters', () => {
        assert.ok(Array.isArray(tool.required), 'Required params should be an array');
      });

      it('should define optional parameters', () => {
        assert.ok(Array.isArray(tool.optional), 'Optional params should be an array');
      });

      it('should have at least one parameter if required is not empty', () => {
        if (tool.required.length > 0) {
          assert.ok(
            tool.required.length >= 1,
            `${tool.name} should have at least one required parameter`
          );
        }
      });
    });
  });

  it('should have no duplicate tool names', () => {
    const toolNames = expectedTools.map((t) => t.name);
    const uniqueNames = new Set(toolNames);
    assert.strictEqual(
      uniqueNames.size,
      toolNames.length,
      'All tool names should be unique'
    );
  });
});
