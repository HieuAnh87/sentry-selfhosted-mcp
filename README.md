# selfhosted-sentry-mcp

[![npm version](https://badge.fury.io/js/selfhosted-sentry-mcp.svg)](https://www.npmjs.com/package/selfhosted-sentry-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Model Context Protocol](https://img.shields.io/badge/MCP-1.0-blue.svg)](https://modelcontextprotocol.io)

MCP server for self-hosted Sentry instances with debugging-focused tools.

## Overview

This server provides MCP tools for querying and triaging issues and events in self-hosted Sentry.

Key capabilities:

- Issue and project listing with pagination and search.
- Event inspection with stack frame extraction.
- Grouping analysis via issue hashes.
- Debug symbol (dSYM) checks for iOS/macOS crashes.
- Raw Sentry API access for edge cases.

## Quickstart

### Prerequisites

- Node.js 20+
- Sentry API token and org slug

### Install

**Option 1: Install from npm (recommended)**

```bash
npm install -g selfhosted-sentry-mcp
```

**Option 2: Install from source**

```bash
git clone https://github.com/HieuAnh87/sentry-selfhosted-mcp.git
cd sentry-selfhosted-mcp
npm install
npm run build
```

### Run

**From npm:**

```bash
selfhosted-sentry-mcp
```

**From source:**

```bash
node build/index.js
```

## Tools

| Tool | Purpose | Input (summary) |
| --- | --- | --- |
| `get_sentry_issue` | Issue details by ID or URL with optional latest event | `issue_id_or_url` + optional filters |
| `list_sentry_projects` | List all projects in org | `{}` |
| `list_sentry_issues` | List issues in a project with query/status | `project_slug` + optional `query`, `status`, `limit`, `cursor` |
| `get_sentry_event_details` | Event details with pagination and entry filtering | `project_slug`, `event_id`, optional `entry_type`, `limit`, `offset` |
| `update_sentry_issue_status` | Update issue status | `issue_id`, `status` |
| `create_sentry_issue_comment` | Add issue comment | `issue_id`, `comment_text` |
| `raw_sentry_api` | Raw Sentry API call with optional grep filter | `endpoint` + optional `method`, `params`, `body`, `grep_pattern` |
| `get_stack_frames` | Extract structured stack frames | `project_slug`, `event_id`, optional `in_app_only`, `max_frames` |
| `check_dsym_status` | Check missing dSYM symbols | `project_slug`, optional `event_id` |
| `list_issue_events` | List events for an issue | `issue_id`, optional `limit`, `cursor`, `full` |
| `get_issue_hashes` | Fetch fingerprint hashes for grouping | `issue_id`, optional `cursor` |
| `list_error_events` | Search error events in a project | `project_slug`, optional `limit`, `cursor`, `query`, `full` |

## Configuration

Set environment variables:

- `SENTRY_URL`: Base URL of your self-hosted Sentry instance.
- `SENTRY_AUTH_TOKEN`: Sentry API token (recommended scopes: `issue:read`, `project:read`, `event:read`, `issue:write`, `comment:write`).
- `SENTRY_ORG_SLUG`: Organization slug.

### Claude Code / Cursor Configuration

Add to your MCP client configuration file:

- **Claude Code**: `~/.claude/settings.json` or project-level `.claude/settings.json`
- **Cursor**: `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project-level)

**Option 1: Using npx (recommended - simplest)**

```json
{
  "mcpServers": {
    "sentry-selfhosted-mcp": {
      "command": "npx",
      "args": ["-y", "selfhosted-sentry-mcp"],
      "env": {
        "SENTRY_URL": "https://your-sentry-instance.com",
        "SENTRY_AUTH_TOKEN": "your-auth-token",
        "SENTRY_ORG_SLUG": "your-org-slug"
      }
    }
  }
}
```

**Option 2: Using global npm install**

```json
{
  "mcpServers": {
    "sentry-selfhosted-mcp": {
      "command": "selfhosted-sentry-mcp",
      "args": [],
      "env": {
        "SENTRY_URL": "https://your-sentry-instance.com",
        "SENTRY_AUTH_TOKEN": "your-auth-token",
        "SENTRY_ORG_SLUG": "your-org-slug"
      }
    }
  }
}
```

**Option 3: From local source**

```json
{
  "mcpServers": {
    "sentry-selfhosted-mcp": {
      "command": "node",
      "args": ["<full/path/to/sentry-selfhosted-mcp/build/index.js>"],
      "env": {
        "SENTRY_URL": "https://your-sentry-instance.com",
        "SENTRY_AUTH_TOKEN": "your-auth-token",
        "SENTRY_ORG_SLUG": "your-org-slug"
      }
    }
  }
}
```

## Docker

Build:

```bash
docker build -t sentry-selfhosted-mcp:latest .
```

Claude Code config:

```json
{
  "mcpServers": {
    "sentry-selfhosted-mcp": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "SENTRY_URL",
        "-e", "SENTRY_AUTH_TOKEN",
        "-e", "SENTRY_ORG_SLUG",
        "sentry-selfhosted-mcp:latest"
      ],
      "env": {
        "SENTRY_URL": "https://your-sentry-instance.com",
        "SENTRY_AUTH_TOKEN": "your-auth-token",
        "SENTRY_ORG_SLUG": "your-org-slug"
      }
    }
  }
}
```

Use env file:

```bash
SENTRY_URL=https://your-sentry-instance.com
SENTRY_AUTH_TOKEN=your-auth-token
SENTRY_ORG_SLUG=your-org-slug
```

```json
{
  "mcpServers": {
    "sentry-selfhosted-mcp": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "--env-file", "/path/to/.env",
        "sentry-selfhosted-mcp:latest"
      ]
    }
  }
}
```

Verify:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | docker run -i --rm \
  -e SENTRY_URL=https://example.com \
  -e SENTRY_AUTH_TOKEN=test \
  -e SENTRY_ORG_SLUG=test \
  sentry-selfhosted-mcp:latest
```

## Development

```bash
npm install
npm run build
```

Run MCP inspector:

```bash
npx @modelcontextprotocol/inspector build/index.js
```

## Security

- Use least-privilege Sentry API tokens.
- Avoid logging sensitive data in MCP client logs.

## Troubleshooting

**Server not starting or tools not showing:**
- Verify `SENTRY_URL`, `SENTRY_AUTH_TOKEN`, and `SENTRY_ORG_SLUG` are set correctly.
- Check the token has required scopes (`issue:read`, `project:read`, `event:read`, `issue:write`, `comment:write`).
- Ensure Node.js 20+ is installed: `node --version`.

**"Unauthorized" or "403" errors:**
- Verify your Sentry API token is valid and not expired.
- Check that the token has permissions for the organization specified in `SENTRY_ORG_SLUG`.

**"Project not found" errors:**
- Confirm the project slug exists in your Sentry organization.
- Use `list_sentry_projects` tool to see available projects.

**Empty or truncated responses:**
- For event details, use `limit` parameter to paginate through large events.
- For `raw_sentry_api`, use `grep_pattern` to filter responses from large endpoints.

**Docker container exits immediately:**
- Ensure all three environment variables are passed: `SENTRY_URL`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG_SLUG`.
- Check Docker logs: `docker logs <container-id>`.

## FAQ

**Q: Is this server self-hosted only?**
A: It is designed for self-hosted Sentry, but it should also work with Sentry SaaS if the API token and org slug are valid.

**Q: Why use `raw_sentry_api` if other tools exist?**
A: It exposes any API endpoint for edge cases not covered by typed tools. Use `grep_pattern` on event endpoints to keep responses small.

## License

MIT
