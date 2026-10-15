# selfhosted-sentry-mcp

TypeScript MCP server for self-hosted Sentry triage/debug workflows.

## Commands

```bash
# Install deps
npm install

# Build TypeScript to ./build and set executable bit
npm run build

# Watch mode during source edits
npm run watch

# Run MCP inspector against built server
npm run inspector

# Test full suite (Node test runner)
npm test

# Test smoke flow only
npm run test:smoke

# Run one test file
node --test test/tools.test.js

# Docker image build
docker build -t selfhosted-sentry-mcp:latest .   # not sentry-selfhosted-mcp: that name is an unrelated npm package
```

## Boundaries

- Do not commit real `SENTRY_AUTH_TOKEN` or real Sentry URLs in docs/examples.
- Do not edit `build/**` directly; source of truth is `src/**`.
- Keep MCP tool names and input schemas backward compatible unless explicitly requested.
- Avoid widening output payloads without grep/filter controls (token bloat risk).

## Where to look

| Task | Location | Note |
|------|----------|------|
| Tool routing/registry | `src/server.ts` | `TOOLS` array + `CallToolRequestSchema` switch must stay in sync |
| Env validation/startup behavior | `src/config.ts` | validation runs on module load; missing env throws immediately |
| Sentry HTTP endpoints | `src/api/client.ts` | all endpoint path composition centralized here; list methods return `{data, nextCursor, hasMore}` (parsed from Sentry's `Link` header), not a bare array |
| Output filtering/truncation logic | `src/helpers/{filter,truncate,grep}.ts` | use helpers before returning large JSON |
| Tool contract expectations | `test/tools.test.js` | expected tool list currently fixed at 24 |
| Pagination | `src/helpers/pagination.ts`, `truncatedTextResult` in `src/tools/issues.ts` | when more results exist, a tool result carries a second text content block `{next_cursor, has_more, hint}`; `content[0]` keeps its shape |

## Conventions (deviations only)

- ESM imports use explicit `.js` extension in TS source (Node16 module resolution).
- Entry point is intentionally thin: `src/index.ts` only imports `./server.js` for compatibility.
- Raw API tool warns on large event payloads and supports `grep_pattern`; preserve this behavior.
- Tool results may have more than one content block: the main payload first, then an optional pagination block. Don't assume `content.length === 1`, and don't fold the cursor into `content[0]`.
- Bulk issue mutations must carry an `id` or `query` selection in the URL; `selectorParams` in `src/api/client.ts` refuses an empty one. Never bypass it — Sentry applies an unselected bulk update to every unresolved issue in the project.

## Anti-patterns (project-specific)

- Don’t call Sentry event endpoints and return full payloads without filtering.
- Don’t add new tools without updating test expectations and registry wiring.

## Notes

- Required runtime env vars: `SENTRY_URL`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG_SLUG`.
- Node.js 20+ required (`package.json` engines).
- `npm install` triggers `prepare` which runs a build.
