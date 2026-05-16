# selfhosted-sentry-mcp — Claude Code Overrides

Strictly follow the rules in `./AGENTS.md`.

## Claude-specific

- Prefer editing `src/**` only; never patch generated artifacts in `build/**`.
- If MCP tool contracts change, verify `src/server.ts` registry wiring and `test/tools.test.js` expectations together before finishing.

## Quick reminders

- Prefer concise diffs that preserve MCP tool backward compatibility.
- For tool-surface changes, run `node --test test/tools.test.js` before handoff.
