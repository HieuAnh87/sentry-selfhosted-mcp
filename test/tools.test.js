#!/usr/bin/env node

/**
 * Tool contract test for sentry-selfhosted-mcp.
 *
 * The table below is the *expected* contract. It is asserted against what a real
 * MCP client sees: the server is spawned over stdio and asked for tools/list, so
 * a tool that is renamed, dropped, or has its schema changed fails here.
 *
 * src/server.ts self-bootstraps on import (it constructs the server and binds
 * stdio at module load), so the registry cannot simply be imported — driving the
 * built server as a subprocess is what makes this a genuine drift detector.
 *
 * One server is spawned for the whole file and reused across every assertion.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

import { McpServerProcess } from './support/harness.js';

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
    optional: ['cursor'],
  },
  {
    name: 'list_sentry_issues',
    required: ['project_slug'],
    optional: ['query', 'status', 'limit', 'cursor', 'full'],
  },
  {
    name: 'list_issues',
    required: [],
    optional: ['query', 'sort', 'limit', 'cursor', 'full'],
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
    optional: ['query', 'issue_ids', 'status', 'assigned_to', 'has_seen'],
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
  // Attachment & feedback tools
  {
    name: 'list_event_attachments',
    required: [],
    optional: ['issue_id', 'project_slug', 'event_id', 'limit', 'cursor'],
  },
  {
    name: 'get_event_attachment',
    required: ['project_slug', 'event_id', 'attachment_id'],
    optional: ['grep_pattern', 'max_chars'],
  },
  {
    name: 'list_user_feedback',
    required: [],
    optional: ['issue_id', 'project_slug', 'limit', 'cursor'],
  },
  // Account
  {
    name: 'whoami',
    required: [],
    optional: [],
  },
  // Raw API
  {
    name: 'raw_sentry_api',
    required: ['endpoint'],
    optional: ['method', 'params', 'body', 'grep_pattern'],
  },
];

const sorted = (values) => [...values].sort();

describe('Sentry MCP Server Tools (live tools/list contract)', () => {
  /** @type {McpServerProcess} */
  let server;
  /** @type {any[]} */
  let actualTools = [];
  /** @type {Map<string, any>} */
  let actualByName = new Map();

  before(async () => {
    // No Sentry traffic is involved in tools/list, so the URL never has to resolve.
    server = await McpServerProcess.start();
    actualTools = await server.listTools();
    actualByName = new Map(actualTools.map((tool) => [tool.name, tool]));
  });

  after(async () => {
    await server?.stop();
  });

  it('should serve exactly 28 tools', () => {
    assert.strictEqual(
      actualTools.length,
      28,
      `Server should expose 28 tools, got ${actualTools.length}: ${sorted(actualTools.map((t) => t.name)).join(', ')}`
    );
  });

  it('should expose exactly the expected tool names, with no additions or removals', () => {
    const actualNames = sorted(actualByName.keys());
    const expectedNames = sorted(expectedTools.map((t) => t.name));

    // deepStrictEqual reports both directions: a dropped tool and a new
    // undocumented one are equally a contract change.
    assert.deepStrictEqual(actualNames, expectedNames);
  });

  it('should have all required debugging tools', () => {
    const debugTools = [
      'get_stack_frames',
      'check_dsym_status',
      'list_issue_events',
      'get_issue_hashes',
      'list_error_events',
      'list_breadcrumbs',
    ];

    for (const tool of debugTools) {
      assert.ok(actualByName.has(tool), `Debugging tool '${tool}' should be served by the running server`);
    }
  });

  it('should have all core issue management tools', () => {
    const coreTools = [
      'get_sentry_issue',
      'list_sentry_projects',
      'list_sentry_issues',
      'get_sentry_event_details',
      'update_sentry_issue_status',
      'create_sentry_issue_comment',
    ];

    for (const tool of coreTools) {
      assert.ok(actualByName.has(tool), `Core tool '${tool}' should be served by the running server`);
    }
  });

  it('should have new Phase 2 tools', () => {
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
      assert.ok(actualByName.has(tool), `New tool '${tool}' should be served by the running server`);
    }
  });

  it('annotates every tool, stating destructiveHint explicitly', () => {
    // The MCP spec defaults destructiveHint to true, so an omitted hint marks a read tool as destructive.
    for (const tool of actualTools) {
      assert.strictEqual(typeof tool.annotations?.readOnlyHint, 'boolean', `${tool.name} readOnlyHint`);
      assert.strictEqual(typeof tool.annotations?.destructiveHint, 'boolean', `${tool.name} destructiveHint`);
      assert.ok(tool.annotations.title, `${tool.name} title`);
    }
  });

  it('marks exactly the tools that write to Sentry as not read-only', () => {
    const writers = actualTools.filter(tool => !tool.annotations.readOnlyHint).map(tool => tool.name).sort();

    assert.deepStrictEqual(writers, [
      'bulk_update_issues',
      'create_sentry_issue_comment',
      'merge_issues',
      'raw_sentry_api',
      'update_sentry_issue_status',
    ]);
    for (const name of ['bulk_update_issues', 'merge_issues', 'raw_sentry_api']) {
      assert.strictEqual(actualByName.get(name).annotations.destructiveHint, true, `${name} is destructive`);
    }
  });

  it('should have raw_sentry_api tool for advanced use cases', () => {
    assert.ok(actualByName.has('raw_sentry_api'), 'raw_sentry_api tool should be served by the running server');
  });

  expectedTools.forEach((expected) => {
    describe(`${expected.name}`, () => {
      it('should be served by the running server', () => {
        assert.ok(actualByName.has(expected.name), `Tool '${expected.name}' is missing from tools/list`);
      });

      it('should have a non-empty description', () => {
        const tool = actualByName.get(expected.name);
        assert.ok(tool, `Tool '${expected.name}' is missing from tools/list`);
        assert.strictEqual(typeof tool.description, 'string');
        assert.ok(tool.description.length > 0, 'Tool description should not be empty');
      });

      it('should declare an object inputSchema', () => {
        const tool = actualByName.get(expected.name);
        assert.ok(tool, `Tool '${expected.name}' is missing from tools/list`);
        assert.strictEqual(tool.inputSchema?.type, 'object');
        assert.strictEqual(typeof tool.inputSchema.properties, 'object');
      });

      it('should declare exactly the expected required parameters', () => {
        const tool = actualByName.get(expected.name);
        assert.ok(tool, `Tool '${expected.name}' is missing from tools/list`);
        assert.deepStrictEqual(sorted(tool.inputSchema.required ?? []), sorted(expected.required));
      });

      it('should declare exactly the expected schema properties', () => {
        const tool = actualByName.get(expected.name);
        assert.ok(tool, `Tool '${expected.name}' is missing from tools/list`);
        const actualProperties = sorted(Object.keys(tool.inputSchema.properties ?? {}));
        const expectedProperties = sorted([...expected.required, ...expected.optional]);
        assert.deepStrictEqual(actualProperties, expectedProperties);
      });

      it('should list every required parameter among its schema properties', () => {
        const tool = actualByName.get(expected.name);
        assert.ok(tool, `Tool '${expected.name}' is missing from tools/list`);
        const properties = Object.keys(tool.inputSchema.properties ?? {});
        for (const name of tool.inputSchema.required ?? []) {
          assert.ok(properties.includes(name), `'${name}' is required but not declared in properties`);
        }
      });
    });
  });

  it('should have no duplicate tool names', () => {
    const toolNames = actualTools.map((t) => t.name);
    const uniqueNames = new Set(toolNames);
    assert.strictEqual(uniqueNames.size, toolNames.length, 'All tool names should be unique');
  });
});
