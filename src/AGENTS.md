# src

Server implementation and tool handlers for the MCP runtime.

## Boundaries

- Keep tool names stable; renames are breaking for clients.
- Keep `TOOLS` registration and `CallToolRequestSchema` switch aligned in `server.ts`.
- Do not bypass helper filters for large event-like payloads.

## Conventions

- TS source uses ESM imports with explicit `.js` suffixes.
- `index.ts` remains a thin compatibility entrypoint; server logic belongs in `server.ts` and `tools/*`.
- Shared HTTP path logic belongs in `api/client.ts`, not duplicated in tool modules.

## Notes

- `config.ts` validates env on module load; importing modules that depend on it will throw immediately if env is missing.
- `raw_sentry_api` must preserve grep guidance/warnings for high-token responses.
