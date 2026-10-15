# test

Node test-runner coverage for MCP tool contracts, helper behaviour, and end-to-end server behaviour.

## Commands

```bash
# Full suite (pretest rebuilds ./build first)
npm test

# One file
node --test test/tools.test.js

# Smoke flow only
npm run test:smoke

# Run the suite against an installed tarball instead of ./build
SENTRY_MCP_TEST_ENTRY=/path/to/pkg/build/index.js node --test test/tools.test.js test/smoke.test.js
```

## Layout

| Path | Covers |
|------|--------|
| `test/tools.test.js` | Tool contract: spawns the built server and asserts `tools/list` against the expected table |
| `test/smoke.test.js` | The built artifact starts, speaks MCP, and validates its env at startup |
| `test/support/harness.js` | Shared helpers: MCP server subprocess over stdio, plus a stand-in Sentry HTTP server |
| `test/e2e/` | Behaviour that only exists once the dispatcher is in the loop (error mapping, SSRF, read-only) |
| `test/unit/` | Helpers and the API client, in-process, with `nock` for HTTP |

## Boundaries

- Treat the 24-tool list in `test/tools.test.js` as a compatibility gate. It is asserted against a
  running server, so adding, removing, or renaming a tool fails here until the table is updated too.
- Every test must fail against the behaviour it guards. A test that passes both before and after a
  fix is not a regression test — check it against the previous implementation before relying on it.
- Do not weaken an assertion to make it pass. If the source looks wrong, report it.

## Notes

- `node --test` with no arguments treats **every** `.js` file under `test/` as a test file, including
  helpers. `test/support/harness.js` is therefore side-effect free and declares no tests; the runner
  reports it as a file containing zero tests. Do not put top-level work in files under `test/support/`.
- Do not use a `test/**/*.test.js` glob in the npm script: `sh` has no `globstar`, so `**` collapses
  to `*` and the runner silently skips every nested file. Bare `node --test` discovers everything.
- Tests import from `build/`, not `src/`. `pretest` rebuilds, so `npm test` cannot pass against a
  stale build; invoking `node --test` directly can.
- Tool results can carry a second text content block with `{next_cursor, has_more, hint}` when Sentry's `Link`
  header reports another page. Assert on `content[0]` for the payload and on `content[1]` for pagination; to
  exercise it, have the stub reply with a `Link` header containing `rel="next"; results="true"; cursor="..."`.
- `nock.replyWithError` needs a real `Error` object. Given a plain object it does not fail the socket
  promptly, and the request instead hangs until axios' 20s timeout.
