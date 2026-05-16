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
docker build -t sentry-selfhosted-mcp:latest .
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
| Sentry HTTP endpoints | `src/api/client.ts` | all endpoint path composition centralized here |
| Output filtering/truncation logic | `src/helpers/{filter,truncate,grep}.ts` | use helpers before returning large JSON |
| Tool contract expectations | `test/tools.test.js` | expected tool list currently fixed at 24 |

## Conventions (deviations only)

- ESM imports use explicit `.js` extension in TS source (Node16 module resolution).
- Entry point is intentionally thin: `src/index.ts` only imports `./server.js` for compatibility.
- Raw API tool warns on large event payloads and supports `grep_pattern`; preserve this behavior.

## Anti-patterns (project-specific)

- Don’t call Sentry event endpoints and return full payloads without filtering.
- Don’t add new tools without updating test expectations and registry wiring.

## Notes

- Required runtime env vars: `SENTRY_URL`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG_SLUG`.
- Node.js 20+ required (`package.json` engines).
- `npm install` triggers `prepare` which runs a build.
