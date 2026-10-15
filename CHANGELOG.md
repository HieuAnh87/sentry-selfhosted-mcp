# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Version note.** `v1.1.3` is tagged in git but was never published to npm, where the latest
> release is `1.1.2`. Everything below `[Unreleased]` therefore covers work that exists in the
> repository but has not shipped to npm users. The version in `package.json` may run ahead of both.

## [Unreleased]

### Added

- `SENTRY_READ_ONLY` environment variable. Set it to `true` or `1` to refuse the four mutating
  tools (`update_sentry_issue_status`, `create_sentry_issue_comment`, `bulk_update_issues`,
  `merge_issues`) and restrict `raw_sentry_api` to `GET`. Defaults to `false`, so existing installs
  are unaffected.
- `SECURITY.md`: token scoping guidance, an explanation of why `raw_sentry_api` bypasses
  least-privilege reasoning, how to keep tokens out of version control, and a private
  vulnerability disclosure process.
- `CONTRIBUTING.md`: setup, build and test commands, the rule that `src/**` is the source of truth
  and `build/**` must never be hand-edited, and the requirement to treat tool names and input
  schemas as a public contract.
- This changelog.
- README: a "Why this exists" section stating the project's design center — token-efficient Sentry
  access for LLM agents — a Usage section with worked example prompts, and a non-Docker
  "Verify it works" step.
- README: `SENTRY_READ_ONLY` documented alongside `SENTRY_URL`, `SENTRY_AUTH_TOKEN` and
  `SENTRY_ORG_SLUG`.
- Landing page: links to the npm package, which the page previously never referenced.
- Unit and end-to-end test suites (`test/unit/`, `test/e2e/`) driving the built server over stdio
  against a stand-in Sentry API, and a GitHub Actions workflow running build and tests on Node 20
  and 22.

### Changed

Tool names are unchanged and input schemas only gained optional properties, but many tools now
return smaller or differently shaped output. Clients that parse responses programmatically should
check the following.

- **Pagination.** List tools that accept `cursor` now return, when another page exists, a second
  text content block `{"next_cursor", "has_more", "hint"}`. The first block keeps its shape.
  `list_sentry_projects` gains an optional `cursor` input.
- **Issue IDs.** Every `issue_id` accepts a numeric ID or a short ID (e.g. `PROJ-1A2`), and
  `get_sentry_issue` also accepts issue URLs. Issue requests use organization-scoped paths, the
  only ones on which Sentry resolves short IDs.
- **`bulk_update_issues`** gains an optional `issue_ids` input (1–100 numeric IDs). It now
  requires either a non-empty `query` or `issue_ids` (not both) and at least one change, and
  returns `{ updated, selection, requested, applied }` instead of Sentry's raw response.
- **`merge_issues`** resolves short IDs, refuses issues from different projects, and reports
  Sentry's chosen `parent` and `children`. Sentry keeps the issue first seen earliest, which may
  not be `issue_id`.
- **`get_grouping_config`** now explains the grouping of the issue's latest event: the grouping
  config, and per variant its type, hash, whether it contributes, hint and contributing
  components.
- **`get_trace_details`** returns one flat, tree-ordered list of spans/transactions (capped by
  `max_spans`) with totals, projects, overall duration and linked errors, searching the last 90
  days.
- `list_sentry_projects` returns `{ returned_projects, has_more, projects }` with essential fields
  only (`id`, `slug`, `name`, `platform`, `dateCreated`, `firstEvent`, team slugs).
- `get_issue_hashes` returns up to 25 hashes per page, each reduced to its `id` and a summary of
  `latestEvent`.
- `list_releases` returns `{ returned_releases, releases, _note }` with compact releases, and
  defaults `limit` to 25. `list_teams` returns compact teams. `list_activity` returns compact
  entries with the user's name only (no emails or avatars).
- `get_issue_tag_values` defaults `limit` to 10, sorts by count, and computes percentages against
  the tag's total (`total_count_source` says which total was used). `get_issue_tags` top values
  are reduced to `{ value, count }`.
- `list_breadcrumbs` returns the most recent N breadcrumbs, and `total_breadcrumbs` counts all of
  them.
- `get_sentry_event_details`: `offset` works without `entry_type`; `entry_type: 'contexts'`
  returns the event's contexts; `request` (header allowlist, never cookies or authorization),
  `threads` and `debugmeta` entries are summarized instead of being returned as `_truncated`.
- `get_sentry_issue` fetches the issue and its latest event in parallel, always condenses the
  latest event (exception, message, request and breadcrumbs entries; others are listed in
  `omitted_entry_types`), and reports a failed latest-event fetch in `latest_event_error`.
- `update_sentry_issue_status` and `create_sentry_issue_comment` return compact results.
- `get_release_details` with `full: true` keeps only the most recent 24 buckets per stats series.
- Error messages keep Sentry's `detail` for 401/403/404, cap response bodies at about 500
  characters, suggest discovery tools on 404, and include `Retry-After` on 429.
- List and detail tool responses go through the shared token-budget truncation. When a payload is
  too large to slice structurally, the response says so explicitly and returns a marked,
  non-parseable preview instead of an invalid object.
- Argument validation mirrors the declared schemas: enum fields are checked against their allowed
  values, `limit` must be within range, project slugs must be slug-shaped, and issue IDs must be
  numeric or short IDs. Invalid arguments are rejected with `InvalidParams` before any request is
  sent to Sentry.

### Fixed

- **`bulk_update_issues` could change far more issues than asked.** It sent `query` in the request
  body, where Sentry ignores it, so every call applied to every unresolved issue in the project (up
  to 1000) regardless of the query. The selection now goes in the URL, and a call with no
  selection is refused.
- **`merge_issues` never merged.** It sent `POST issues/{id}/hashes/`, which Sentry does not
  accept. It now uses `PUT projects/{org}/{project}/issues/?id=…` with `{"merge": true}`, and
  reports success only when Sentry confirms the merge.
- **`get_trace_details` always failed.** `traces/{id}/` does not exist; the tool now uses
  `organizations/{org}/trace/{id}/`, falling back to `events-trace/` on older versions.
- **`get_grouping_config` always failed.** `issues/{id}/grouping-config/` does not exist; the tool
  now uses the event `grouping-info/` endpoint.
- **`list_activity` always failed.** The route is `issues/{id}/activities/`, not `activity/`.
- **Pagination cursors were unreachable.** Tools accepted `cursor` but never returned one, because
  the client dropped Sentry's `Link` header.
- **`get_stack_frames` with `in_app_only: true` returned no frames.** It read `in_app`; Sentry's API
  returns `inApp`.
- Source context around each stack frame was always empty; it now keeps ±3 lines around the frame's
  line.
- `get_sentry_issue` ignored `max_stack_frames` values above 5.
- `get_issue_tag_values` showed 100% for the top value when `limit` was 1, because percentages
  were computed from the returned page only.
- List endpoints that page with `per_page` (events, releases, tag values) ignored `limit`; both
  are now sent.
- **`list_issues` sent `POST` to the organization issues endpoint.** Searching issues is a `GET`;
  the tool now uses it.
- **Tool handler errors could escape the server's error handling.** The dispatcher returned
  handler promises without awaiting them, so rejections bypassed the `catch` that maps Sentry
  errors to MCP errors.
- `limit: 0` and other falsy values were treated as "not provided". Values are now passed through
  and validated.
- `get_sentry_event_details` listed only the selected entry types in `available_types`; it now
  lists every type present on the event.
- `get_issue_hashes` was typed as returning strings; Sentry returns hash objects.
- The `bin` entry point lacked a shebang, so running the installed command directly could execute
  it with the shell instead of Node.
- `include_fields` with sibling nested paths (`latest_event.a`, `latest_event.b`) kept only the
  last one.

- **Landing page told users to install the wrong npm package.** All four quickstart configuration
  examples specified `sentry-selfhosted-mcp` — an unrelated package published by a different
  maintainer — in a JSON block that also passes `SENTRY_AUTH_TOKEN`. Anyone following the page
  would have handed a live Sentry token to third-party code. The package published by this
  repository is **`selfhosted-sentry-mcp`**; the GitHub repository is `HieuAnh87/sentry-selfhosted-mcp`.
  Corrected every npm identifier on the page while leaving repository URLs intact.
- **"Read-only by default" was false.** The page claimed it in the meta description, hero copy, a
  hero badge, the quickstart footer, and the Trust & Safety section ("All tools are read-only. Safe
  for production."). The server registers five tools that write to Sentry, including
  `bulk_update_issues` (mass resolve/ignore/assign), the non-reversible `merge_issues`, and
  `raw_sentry_api`, whose method enum accepts `POST`, `PUT` and `DELETE`. Claims now describe the
  opt-in `SENTRY_READ_ONLY` switch accurately, and write tools are marked as such in the tool list.
- **Landing page tool list was 22/24 fabricated.** It invented tool names (`search_issues`,
  `get_issue`, `get_top_issues`, `get_event`, `compare_releases`, `search_users`,
  `get_organization_stats`, `get_project_health`, `ping` and others) and two whole categories
  ("Users", "Diagnostics") that do not exist, while hiding every real differentiator. Replaced with
  the actual 24 tools from the `TOOLS` registry in `src/server.ts`. The capability tiles advertising
  the same non-existent features were rewritten around real ones: stack frames, breadcrumbs, dSYM
  checks, grouping and traces.
- **README listed Sentry scopes that do not exist.** `issue:read`, `issue:write` and
  `comment:write` are not Sentry scopes — the namespaces are `org:*`, `project:*`, `team:*`,
  `member:*` and `event:*`. The list also omitted `team:read`, `org:read` and `project:releases`,
  which the server genuinely requires. Replaced with a table mapping each scope to the tools that
  need it, split into read-only and write sets.
- **README gave a Claude Code configuration path that silently does nothing.** `settings.json` does
  not read an `mcpServers` key, so users following it got a server that never loaded and no error.
  Project scope is `.mcp.json` at the repository root; user scope is `claude mcp add --scope user`.
- README tool tables: `get_sentry_event_details` was missing `limit`, `offset` and `entry_type`
  (`limit` is the main defence against token blowups); `list_releases`'s `date` parameter reads
  like a date but is an adoption-status enum (`adopted` / `unadopted`); `merge_issues`'s 10-item
  cap on `target_ids` was undocumented; optional parameters are now marked consistently.
- `FILTERING.md` was unreferenced from anywhere despite being the only documentation for
  `get_sentry_issue`'s five filter parameters. Linked from the README and cross-linked back.
- README ordering put a 50-row tool reference table between Install and Configuration, so a new
  user had to scroll the entire reference to reach the config they needed. Configuration now
  follows Install.
- Landing page accessibility: implemented the WAI-ARIA tabs pattern on the quickstart tabs
  (`role="tablist"`, `role="tab"`, `role="tabpanel"`, `aria-selected`, `aria-controls`, roving
  `tabindex`, and arrow/Home/End key navigation) where previously there were no affordances and no focus
  ring; fixed a heading-level skip from `h2` to `h4`; darkened `--text-tertiary`, which was
  `#9ca3af` on `#fafafa` for 2.43:1 contrast against a 4.5:1 AA requirement, and darkened
  `--text-secondary` to preserve the hierarchy; added `aria-hidden="true"` to all decorative inline
  SVGs; gave the bare GitHub icon in the footer an accessible name.
- Landing page markup and behaviour: removed a stray `</div>` in the hero that left the document
  unbalanced; the navigation no longer disappears entirely below 600px; `scroll-behavior: smooth`
  is now guarded by `prefers-reduced-motion`; the clipboard copy handler has a rejection path
  instead of failing silently on insecure origins or denied permission.
- Landing page quickstart tabs were four byte-identical JSON blocks that never said where the
  config file goes. Each tab is now genuinely client-specific and states the file location.
- Landing page footer links for Security, Contributing and License pointed at `#`.
- Removed hard-coded version numbers from the landing page, which had drifted out of step with both
  the npm release and `package.json`. The page links to the releases and npm pages instead.
- `FILTERING.md` no longer opens with a stale "Version 0.2.1" line.

### Security

- Every value interpolated into a Sentry API path is now percent-encoded, so an argument such as
  `../other-org` can no longer rewrite the request path.
- `raw_sentry_api` rejects endpoints that are absolute URLs, contain backslashes or control
  characters, or resolve outside the configured `/api/0/` path. Each of these could previously send
  the `Authorization` header to an arbitrary host or path.
- The HTTP client refuses absolute URLs, does not follow redirects, and treats non-JSON responses
  (SSO or proxy HTML pages) as errors instead of returning them as data.
- Error logging prints messages only. Logging the full axios error object wrote the request
  headers, including the bearer token, to stderr.
- `include_fields` / `exclude_fields` ignore `__proto__`, `constructor` and `prototype` path
  segments and never assign through inherited setters.
- `grep_pattern` rejects patterns that could cause catastrophic backtracking, estimated from the
  pattern's structure before it runs. Alongside the existing 500-character pattern cap, it now also
  caps scanned line length and total scan time.

## [1.1.3] - 2026-05-16

Tagged in git; not published to npm.

### Added

- Modular MCP architecture: tools split into `src/tools/{issues,events,releases,org,advanced}.ts`,
  Sentry HTTP calls centralized in `src/api/client.ts`, and response shaping in `src/helpers/`.
  Expanded the tool surface to 24 tools, adding stack-frame extraction, breadcrumbs, dSYM status,
  issue hashes, grouping configuration, distributed traces, bulk updates and issue merging.
- Test suite covering the tool registry and a smoke flow.
- Landing page for GitHub Pages at `docs/index.html`.

### Changed

- README tool tables aligned with the current MCP schemas.

## [1.1.2] - 2026-01-06

### Fixed

- Removed a duplicate shebang that crashed the MCP server on startup.

## [1.1.1] - 2026-01-06

### Fixed

- Preserved the shebang in build output so the CLI binary is executable.

## [1.1.0] - 2026-01-06

First tagged release. Earlier commits (from 2026-01-05) were not tagged and are not itemized here.

### Added

- MCP server for self-hosted Sentry with issue, event and raw API tools.
- `engines` field requiring Node.js 20+.
- Test suite.

### Changed

- Renamed the npm package to `selfhosted-sentry-mcp`.

### Removed

- Organization slug inference, which was buggy. `SENTRY_ORG_SLUG` is now required.

[Unreleased]: https://github.com/HieuAnh87/sentry-selfhosted-mcp/compare/v1.1.3...HEAD
[1.1.3]: https://github.com/HieuAnh87/sentry-selfhosted-mcp/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/HieuAnh87/sentry-selfhosted-mcp/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/HieuAnh87/sentry-selfhosted-mcp/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/HieuAnh87/sentry-selfhosted-mcp/releases/tag/v1.1.0
