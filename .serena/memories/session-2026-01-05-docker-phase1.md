# Session: Docker Support & Phase 1 Tools
**Date:** 2026-01-05
**Version:** 1.0.0

## Summary
Added Docker support and implemented Phase 1 debugging tools for sentry-selfhosted-mcp.

## Changes Made

### 1. Docker Support
- **Dockerfile**: Multi-stage build, Alpine-based, 140MB image
- **.dockerignore**: Optimized build context
- **README.md**: Docker usage instructions for Claude Code

### 2. New Tools (Phase 1)
| Tool | Purpose |
|------|---------|
| `list_issue_events` | List all events for a specific issue |
| `get_issue_hashes` | Get fingerprint hashes for issue grouping |
| `list_error_events` | Search events project-wide |

### 3. Total Tools: 12
1. get_sentry_issue
2. list_sentry_projects
3. list_sentry_issues
4. get_sentry_event_details
5. update_sentry_issue_status
6. create_sentry_issue_comment
7. raw_sentry_api
8. get_stack_frames
9. check_dsym_status
10. list_issue_events (NEW)
11. get_issue_hashes (NEW)
12. list_error_events (NEW)

## Technical Decisions

### Dockerfile Optimizations
- `--no-audit --no-fund`: Faster builds
- `rm -rf /tmp/* /root/.npm`: Smaller image
- LABEL metadata for container management
- `--chown` in COPY for proper ownership
- Non-root user (mcpuser) for security

### MCP Container Lifecycle
- STDIO transport: Container spawned per Claude Code session (not per tool call)
- `--rm` flag: Auto-cleanup on exit
- Single container handles multiple tool calls via stdin/stdout

## Claude Code Config
```json
{
  "mcpServers": {
    "sentry": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "SENTRY_URL", "-e", "SENTRY_AUTH_TOKEN", "-e", "SENTRY_ORG_SLUG", "sentry-selfhosted-mcp:1.0.0"],
      "env": {
        "SENTRY_URL": "https://your-sentry.com",
        "SENTRY_AUTH_TOKEN": "sntrys_xxx",
        "SENTRY_ORG_SLUG": "your-org"
      }
    }
  }
}
```

## Comparison with Official Sentry MCP
- Self-hosted: 12 tools (optimized for debugging, token efficiency)
- Official: 16+ tools (includes AI features, Seer integration)
- Unique to self-hosted: raw_sentry_api, get_stack_frames, check_dsym_status

## Next Steps (Phase 2 - Optional)
- list_organization_replays (if Session Replay enabled)
- create_project + get_dsn
- AI-powered search (requires OpenAI key)
