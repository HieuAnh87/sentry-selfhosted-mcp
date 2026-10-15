# selfhosted-sentry-mcp

[![npm version](https://badge.fury.io/js/selfhosted-sentry-mcp.svg)](https://www.npmjs.com/package/selfhosted-sentry-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Model Context Protocol](https://img.shields.io/badge/MCP-2024--11--05-blue.svg)](https://modelcontextprotocol.io)

MCP server that gives AI coding agents **token-efficient** access to a self-hosted Sentry instance.

## Why this exists

A single Sentry event endpoint can return well over 100,000 tokens — more than most models can hold, let alone reason about. Pointing an agent at the raw Sentry API usually ends in a blown context window.

This server is built around that problem:

- **Compact by default.** `get_sentry_issue` returns essential fields only; `list_issue_events`, `list_error_events` and `get_release_details` return summaries unless you pass `full: true`. `get_sentry_event_details` returns 5 prioritized entries by default and strips heavy blocks (`sdk`, `packages`, `contexts`, `user`, `request`, `environment`), flagging each removal.
- **A hard ceiling.** Responses are measured against a 50,000-token budget (`MAX_TOKENS` in `src/config.ts`). Oversized responses are truncated with pagination hints instead of being dumped.
- **A refusal path.** If `raw_sentry_api` would return more than 50,000 tokens and you did not pass a `grep_pattern`, it refuses and returns grep suggestions rather than flooding the conversation.
- **Filters on the way out.** Whitelist/blacklist field selection, regex grep, and stack-frame truncation — see [FILTERING.md](FILTERING.md).
- **Purpose-built extractors.** `get_stack_frames`, `list_breadcrumbs` and `check_dsym_status` pull the debugging signal out of an event so the agent never sees the surrounding noise.

## Quickstart

Node.js 20+ and a self-hosted Sentry instance (Sentry SaaS also works if the token and org slug are valid).

### 1. Create a Sentry auth token

**Settings → Auth Tokens → Create New Token.**

For read-only use, select `event:read`, `org:read`, `project:read`, `team:read` and `project:releases`. Add `event:write` only if you want the four write tools.

Which scope each tool needs: [Token scopes](#token-scopes).

### 2. Find your org slug

**Settings → General** in your organization, or read it out of the URL: `https://your-sentry.com/organizations/[slug]/`.

### 3. Install

**Nothing to install.** The recommended setup runs the published package through `npx` straight from your MCP client config — skip to [Client configuration](#client-configuration).

To install it globally anyway:

```bash
npm install -g selfhosted-sentry-mcp
```

From source:

```bash
git clone https://github.com/HieuAnh87/sentry-selfhosted-mcp.git
cd sentry-selfhosted-mcp
npm install
npm run build
```

> The npm package is **`selfhosted-sentry-mcp`**. The GitHub repository is `HieuAnh87/sentry-selfhosted-mcp` — the two names are transposed. `sentry-selfhosted-mcp` on npm is an unrelated package by a different maintainer; do not install it and do not give it your token.

## Configuration

### Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `SENTRY_URL` | yes | — | Base URL of your Sentry instance, e.g. `https://sentry.example.com`. Must be a valid URL; a trailing slash is stripped. |
| `SENTRY_AUTH_TOKEN` | yes | — | Sentry API token. See the scope table above. |
| `SENTRY_ORG_SLUG` | yes | — | Organization slug, e.g. `my-org`. |
| `SENTRY_READ_ONLY` | no | `false` | Set to `true` (or `1`) to block writes. **Off by default** for backward compatibility, so write tools are exposed unless you opt in. See below for exactly what it blocks. |

The server validates the three required variables at startup and exits immediately if any is missing or if `SENTRY_URL` is not a valid URL.

#### What `SENTRY_READ_ONLY=true` blocks

| | Behaviour in read-only mode |
| --- | --- |
| `update_sentry_issue_status`, `create_sentry_issue_comment`, `bulk_update_issues`, `merge_issues` | Refused outright with an `InvalidRequest` error |
| `raw_sentry_api` | Still available, but **`POST`, `PUT` and `DELETE` are refused**. `GET` continues to work. |
| The other 19 tools | Unaffected |

Accepted truthy values are `true` and `1` (case-insensitive). Anything else, including unset, leaves the server writable. When enabled, the startup line on stderr ends with `(read-only)`.

### Token scopes

Sentry's scope namespaces are `org:*`, `project:*`, `team:*`, `member:*` and `event:*`. There is no `issue:*` or `comment:*` scope — issue and comment endpoints live under `event:*`.

**Read-only setup** — covers 20 of the 24 tools (everything except the four write tools):

| Scope | Needed by |
| --- | --- |
| `event:read` | Every issue and event tool: `get_sentry_issue`, `list_sentry_issues`, `list_issues`, `get_issue_hashes`, `get_sentry_event_details`, `list_issue_events`, `list_error_events`, `get_stack_frames`, `check_dsym_status`, `list_breadcrumbs`, `get_issue_tags`, `get_issue_tag_values`, `list_activity`, `get_grouping_config` |
| `org:read` | `list_sentry_projects`, `list_teams`, `list_releases`, `get_trace_details` (organization-level endpoints) |
| `project:read` | `list_sentry_projects` |
| `team:read` | `list_teams` |
| `project:releases` | `list_releases`, `get_release_details` (grants both project and organization release endpoints) |

**Add only if you want the write tools:**

| Scope | Needed by |
| --- | --- |
| `event:write` | `update_sentry_issue_status`, `create_sentry_issue_comment`, `bulk_update_issues`, `merge_issues` |

`raw_sentry_api` is bounded only by the token: it can call any endpoint your scopes permit, with `GET`, `POST`, `PUT` or `DELETE`. Scope the token to what you actually need — see [SECURITY.md](SECURITY.md).

### Client configuration

Where the config file goes:

| Client | Location |
| --- | --- |
| **Claude Code** (project) | `.mcp.json` at the repository root |
| **Claude Code** (user) | `claude mcp add --scope user` — do not hand-edit `settings.json`, it does not read `mcpServers` |
| **Cursor** | `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global) |

**Option 1: npx (simplest)**

```json
{
  "mcpServers": {
    "sentry": {
      "command": "npx",
      "args": ["-y", "selfhosted-sentry-mcp"],
      "env": {
        "SENTRY_URL": "https://your-sentry-instance.com",
        "SENTRY_AUTH_TOKEN": "your-auth-token",
        "SENTRY_ORG_SLUG": "your-org-slug",
        "SENTRY_READ_ONLY": "true"
      }
    }
  }
}
```

For Claude Code's `.mcp.json` you may also add `"type": "stdio"` alongside `command`.

To register it at user scope instead, without writing a config file by hand:

```bash
claude mcp add --env SENTRY_URL=https://your-sentry-instance.com \
  --env SENTRY_AUTH_TOKEN=your-auth-token \
  --env SENTRY_ORG_SLUG=your-org-slug \
  --env SENTRY_READ_ONLY=true \
  --transport stdio --scope user sentry \
  -- npx -y selfhosted-sentry-mcp
```

**Option 2: global npm install**

```json
{
  "mcpServers": {
    "sentry": {
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

**Option 3: local source build**

```json
{
  "mcpServers": {
    "sentry": {
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

> These files contain a live Sentry token in plaintext. Keep them out of version control — see [SECURITY.md](SECURITY.md).

### Verify it works

Confirm the server starts and lists its tools before wiring it into a client:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | \
  SENTRY_URL=https://your-sentry-instance.com \
  SENTRY_AUTH_TOKEN=your-auth-token \
  SENTRY_ORG_SLUG=your-org-slug \
  npx -y selfhosted-sentry-mcp
```

You should see a JSON response listing 24 tools, plus a startup line on stderr naming your org slug and Sentry URL:

```
Self-hosted Sentry MCP server v… running for org "your-org-slug" at https://your-sentry-instance.com
```

If the process exits instead, one of the three required environment variables is missing or `SENTRY_URL` is malformed.

Or drive it interactively with the MCP inspector:

```bash
npx @modelcontextprotocol/inspector npx -y selfhosted-sentry-mcp
```

## Usage

Once the server is registered, talk to your agent normally. Prompts that map cleanly onto these tools:

- *"List unresolved production issues in the `checkout` project, most frequent first."* → `list_issues` with `query: "is:unresolved environment:production"`, `sort: "freq"`
- *"Show me the in-app stack frames for event `abc123` in `apple-ios`."* → `get_stack_frames` with `in_app_only: true`
- *"What happened right before issue 5217 crashed?"* → `list_breadcrumbs`
- *"Are we missing dSYMs for the iOS project?"* → `check_dsym_status`
- *"Why are issues 4821 and 4822 grouped separately?"* → `get_issue_hashes` and `get_grouping_config`
- *"Which OS versions does issue 5217 affect?"* → `get_issue_tags`, then `get_issue_tag_values` with `tag_key: "os.name"`

If a response comes back truncated, narrow it rather than asking for more — pass `entry_type`, `limit`, `grep_pattern` or `max_stack_frames`. See [Reducing response size](#reducing-response-size).

## Tools

24 tools across 6 categories. Parameters are **required** unless marked *optional*.

**WRITE** marks the five tools that can modify Sentry. Under `SENTRY_READ_ONLY=true` the four dedicated write tools are refused outright, while `raw_sentry_api` stays available with `GET` only — see [Configuration](#what-sentry_read_onlytrue-blocks).

### Issue tools

| Tool | Purpose | Parameters |
| --- | --- | --- |
| `get_sentry_issue` | Issue details by ID or URL | `issue_id_or_url`; *optional* `include_latest_event` (default `false`), `include_fields[]`, `exclude_fields[]`, `grep_pattern`, `max_stack_frames` — see [FILTERING.md](FILTERING.md) |
| `list_sentry_projects` | All projects in the org | none |
| `list_sentry_issues` | Issues in one project | `project_slug`; *optional* `query`, `status` (`resolved`/`unresolved`/`ignored`), `limit` (1–100, default 25), `cursor` |
| `list_issues` | Org-wide issue search, Sentry query syntax | *optional* `query`, `sort` (`date`/`priority`/`freq`/`user`, default `date`), `limit` (1–100, default 25), `cursor` |
| `get_issue_hashes` | Fingerprint hashes for an issue | `issue_id`; *optional* `cursor` |
| `update_sentry_issue_status` **WRITE** | Set issue status | `issue_id`, `status` (`resolved`/`ignored`/`unresolved`) |
| `create_sentry_issue_comment` **WRITE** | Add a comment | `issue_id`, `comment_text` |
| `bulk_update_issues` **WRITE** | Mass resolve/ignore/assign by query | `project_slug`; *optional* `query`, `status`, `assigned_to`, `has_seen`. Omitting `query` targets every issue in the project. |

### Event tools

| Tool | Purpose | Parameters |
| --- | --- | --- |
| `get_sentry_event_details` | Event details, entry-filtered | `project_slug`, `event_id`; *optional* `limit` (default 5), `offset` (default 0), `entry_type` (`exception`/`message`/`breadcrumbs`/`request`/`threads`/`debugmeta`/`contexts`). **`limit` is the main defence against token blowups.** Without `entry_type`, entries are prioritized `exception` → `message` → `breadcrumbs` → `request`. |
| `list_issue_events` | Events for one issue over time | `issue_id`; *optional* `limit` (1–100, default 25), `cursor`, `full` (default `false`) |
| `list_error_events` | Search events in a project | `project_slug`; *optional* `limit` (1–100, default 25), `cursor`, `query`, `full` (default `false`) |
| `get_stack_frames` | Structured stack frames | `project_slug`, `event_id`; *optional* `in_app_only` (default `false`), `max_frames` (1–100, default 50; keeps the last N) |
| `check_dsym_status` | Missing iOS/macOS dSYMs and ProGuard mappings | `project_slug`; *optional* `event_id` (falls back to the latest event in the project) |
| `list_breadcrumbs` | Trail of events before the error | `project_slug`, `event_id`; *optional* `limit` (1–100, default 50), `type` (e.g. `default`, `http`, `navigation`, `error`) |

### Release tools

| Tool | Purpose | Parameters |
| --- | --- | --- |
| `list_releases` | Releases in the org | *optional* `query` (matches on version), `date` (**adoption status**, not a date: `adopted` or `unadopted`), `limit` (1–100, default 25), `cursor`, `sort` (`date`/`semver`, default `date`) |
| `get_release_details` | Release details and health stats | `version`; *optional* `full` (default `false`; compact view omits stats) |

### Organization tools

| Tool | Purpose | Parameters |
| --- | --- | --- |
| `list_teams` | All teams in the org | none |
| `get_issue_tags` | Tags captured for an issue | `issue_id` (returns the top 5 values per tag) |
| `get_issue_tag_values` | Value distribution for one tag | `issue_id`, `tag_key`; *optional* `limit` (1–100, default 10) |
| `list_activity` | Issue activity log | `issue_id`; *optional* `limit` (1–100, default 25), `cursor` |

### Advanced tools

| Tool | Purpose | Parameters |
| --- | --- | --- |
| `get_trace_details` | Distributed trace with spans | `trace_id`; *optional* `max_spans` (1–500, default 100). Requires Performance data. |
| `get_grouping_config` | Fingerprinting rules for an issue | `issue_id` |
| `merge_issues` **WRITE** | Merge issues into one | `issue_id` (primary), `target_ids[]` — **maximum 10**. More than 10 is rejected with an invalid-params error, not truncated. Merging is not reversible. |

### Raw API

| Tool | Purpose | Parameters |
| --- | --- | --- |
| `raw_sentry_api` **WRITE** | Any Sentry API endpoint | `endpoint` (path without the `/api/0/` prefix); *optional* `method` (`GET`/`POST`/`PUT`/`DELETE`, default `GET`), `params`, `body`, `grep_pattern`. Refuses responses over 50,000 tokens unless `grep_pattern` is set. Under `SENTRY_READ_ONLY=true` only `GET` is permitted. |

## Reducing response size

`get_sentry_issue` accepts five filter parameters — `include_fields`, `exclude_fields`, `max_stack_frames`, `grep_pattern`, and combinations of them — that exist specifically to keep large issues inside the token budget.

**[FILTERING.md](FILTERING.md) documents all of them with worked examples**, including the recommended escalation order when a response is still too big.

Quick reference for the other tools:

| Symptom | Fix |
| --- | --- |
| Event response truncated | `get_sentry_event_details` with `limit: 3` and `entry_type: "exception"` |
| Only need the stack trace | `get_stack_frames` with `in_app_only: true` instead of the full event |
| `raw_sentry_api` refuses to return | add a `grep_pattern` — it is required above 50k tokens |
| Issue payload still too large | `max_stack_frames: 5`, then `exclude_fields`, then `include_fields`, then `grep_pattern` |

## Docker

Build:

```bash
docker build -t sentry-selfhosted-mcp:latest .
```

Client config:

```json
{
  "mcpServers": {
    "sentry": {
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

Using an env file keeps the token out of the config file entirely:

```bash
# /path/to/.env
SENTRY_URL=https://your-sentry-instance.com
SENTRY_AUTH_TOKEN=your-auth-token
SENTRY_ORG_SLUG=your-org-slug
```

```json
{
  "mcpServers": {
    "sentry": {
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

Verify the image:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | docker run -i --rm \
  -e SENTRY_URL=https://example.com \
  -e SENTRY_AUTH_TOKEN=test \
  -e SENTRY_ORG_SLUG=test \
  sentry-selfhosted-mcp:latest
```

## Development

```bash
npm install     # runs the build via the prepare hook
npm run build
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow. In short: `src/**` is the source of truth, `build/**` is generated and must never be edited by hand, and tool names and input schemas are a public contract.

Run the MCP inspector against a local build:

```bash
npx @modelcontextprotocol/inspector build/index.js
```

## Security

The server holds a live Sentry API token supplied as a plaintext environment variable, usually inside a config file that is easy to commit by accident.

**Read [SECURITY.md](SECURITY.md) before deploying it.** It covers least-privilege token scoping, why `raw_sentry_api` bypasses least-privilege reasoning, the `SENTRY_READ_ONLY` switch, keeping tokens out of version control, and how to report a vulnerability.

## Troubleshooting

**Server not starting, or tools not showing**
- Verify `SENTRY_URL`, `SENTRY_AUTH_TOKEN` and `SENTRY_ORG_SLUG` are all set. The server exits at startup if any is missing.
- Confirm `SENTRY_URL` parses as a URL (include the scheme: `https://…`).
- Check Node.js 20+: `node --version`.
- On Claude Code, confirm the config is in `.mcp.json` or was added with `claude mcp add`. An `mcpServers` block in `settings.json` is ignored — the server will never load and there is no error.

**"Unauthorized" or "403"**
- The token is invalid, expired, or lacks the scope for that endpoint. Match the failing tool against the [scope table](#1-create-a-sentry-auth-token).
- Confirm the token belongs to the organization in `SENTRY_ORG_SLUG`.

**"Tool is disabled: server is running in read-only mode"**
- Expected if `SENTRY_READ_ONLY` is set to `true` or `1`. Unset it to restore write access. The startup line on stderr ends with `(read-only)` when the mode is active.

**"Project not found"**
- Confirm the slug exists; run `list_sentry_projects` to see the valid ones.

**Empty or truncated responses**
- Use `limit` and `entry_type` on `get_sentry_event_details`.
- Use `grep_pattern` on `raw_sentry_api` for large endpoints.
- See [Reducing response size](#reducing-response-size).

**Docker container exits immediately**
- All three required variables must reach the container. With `-e VAR` (no value) the variable must exist in your shell; otherwise use `--env-file`.
- Check `docker logs <container-id>`.

## FAQ

**Is this self-hosted only?**
It targets self-hosted Sentry, but works against Sentry SaaS when the token and org slug are valid.

**Why use `raw_sentry_api` when typed tools exist?**
For endpoints the typed tools do not cover. It returns unfiltered JSON, so pass `grep_pattern` on anything event-shaped — above 50,000 tokens it refuses outright without one.

**Can I stop the agent from modifying Sentry?**
Set `SENTRY_READ_ONLY=true`. That refuses the four mutating tools and restricts `raw_sentry_api` to `GET`. For a stronger guarantee, issue a token without `event:write` — the env var stops an agent from calling the tool, the scope stops the credential from being usable at all.

**Does it work with Sentry's newer API versions?**
Yes, for the versions in use today. Sentry has shipped only one public web API version — `/api/0/` — and every endpoint here is composed against it in `src/api/client.ts`. If Sentry ever publishes a `/api/1/`, this server would need updating.

## License

MIT — see [LICENSE](LICENSE).
