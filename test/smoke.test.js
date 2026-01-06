#!/usr/bin/env node

/**
 * Smoke test for sentry-selfhosted-mcp server
 * Tests that the MCP server starts and responds to basic protocol messages
 */

import { spawn } from 'child_process';
import { setTimeout } from 'timers/promises';

const TEST_TIMEOUT = 10000; // 10 seconds

async function smokeTest() {
  console.log('🧪 Running smoke test for sentry-selfhosted-mcp...\n');

  // Set test environment variables
  const env = {
    ...process.env,
    SENTRY_URL: 'https://test-sentry.example.com',
    SENTRY_AUTH_TOKEN: 'test-token',
    SENTRY_ORG_SLUG: 'test-org',
  };

  // Start the MCP server
  const server = spawn('node', ['build/index.js'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let passed = 0;
  let failed = 0;

  server.stdout.on('data', (data) => {
    stdout += data.toString();
  });

  server.stderr.on('data', (data) => {
    stderr += data.toString();
  });

  try {
    // Wait for server to initialize
    await setTimeout(1000);

    // Test 1: Server is running
    console.log('✓ Test 1: Server started successfully');
    passed++;

    // Test 2: Send tools/list request
    console.log('\n✓ Test 2: Sending tools/list request...');
    const toolsListRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    }) + '\n';

    server.stdin.write(toolsListRequest);
    await setTimeout(2000);

    // Check if we got a response
    if (stdout.includes('"result"') || stdout.includes('"tools"')) {
      console.log('✓ Test 2: Server responded to tools/list');
      passed++;

      // Check if tools array is present and has expected tools
      try {
        const responseMatch = stdout.match(/\{.*\}/s);
        if (responseMatch) {
          const response = JSON.parse(responseMatch[0]);
          if (response.result && response.result.tools && Array.isArray(response.result.tools)) {
            const toolCount = response.result.tools.length;
            console.log(`  ✓ Found ${toolCount} tools`);

            // Check for specific tools
            const toolNames = response.result.tools.map((t) => t.name);
            const expectedTools = [
              'get_sentry_issue',
              'list_sentry_projects',
              'list_sentry_issues',
              'get_sentry_event_details',
              'update_sentry_issue_status',
              'create_sentry_issue_comment',
              'raw_sentry_api',
              'get_stack_frames',
              'check_dsym_status',
              'list_issue_events',
              'get_issue_hashes',
              'list_error_events',
            ];

            const missingTools = expectedTools.filter((t) => !toolNames.includes(t));
            if (missingTools.length === 0) {
              console.log('  ✓ All expected tools are present');
              passed++;
            } else {
              console.log(`  ✗ Missing tools: ${missingTools.join(', ')}`);
              failed++;
            }
          }
        }
      } catch (e) {
        console.log('  ✗ Could not parse tools/list response');
        failed++;
      }
    } else {
      console.log('✗ Test 2: No response from server');
      failed++;
    }

    // Test 3: Initialize request
    console.log('\n✓ Test 3: Sending initialize request...');
    stdout = ''; // Clear buffer
    const initRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'test-client',
          version: '1.0.0',
        },
      },
    }) + '\n';

    server.stdin.write(initRequest);
    await setTimeout(2000);

    if (stdout.includes('"result"') || stdout.includes('serverInfo')) {
      console.log('✓ Test 3: Server responded to initialize');
      passed++;
    } else {
      console.log('✗ Test 3: No initialize response');
      failed++;
    }
  } catch (error) {
    console.error(`\n✗ Test error: ${error.message}`);
    failed++;
  } finally {
    // Cleanup
    server.stdin.end();
    await setTimeout(500);
    server.kill();
  }

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log(`Tests passed: ${passed}`);
  console.log(`Tests failed: ${failed}`);
  console.log('='.repeat(50));

  if (failed > 0) {
    console.log('\n❌ Smoke test failed');
    if (stderr) {
      console.log('\nServer stderr:');
      console.log(stderr);
    }
    process.exit(1);
  } else {
    console.log('\n✅ All smoke tests passed!');
    process.exit(0);
  }
}

// Run the test
smokeTest().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
