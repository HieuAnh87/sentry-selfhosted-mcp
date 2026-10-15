# Security Policy

## The core risk

This server authenticates to Sentry with an API token supplied as a **plaintext environment variable**, normally written into an MCP client config file:

- `.mcp.json` at your repository root (Claude Code, project scope)
- `.cursor/mcp.json` (Cursor, project scope)
- `claude_desktop_config.json`, `~/.cursor/mcp.json` and equivalents (user scope)

Project-scoped files live inside your repository and are trivially committed by accident. A leaked Sentry token exposes error payloads, which routinely contain user emails, IP addresses, request bodies, session data, environment variables and stack traces with embedded secrets — and, if the token carries write scopes, lets an attacker resolve, ignore, comment on, merge or bulk-modify issues.

Everything below follows from that.

## 1. Scope the token to what you actually use

Sentry's scope namespaces are `org:*`, `project:*`, `team:*`, `member:*` and `event:*`. Grant the narrowest set that covers the tools you intend to use.

**Read-only token** — covers 20 of the 24 tools (everything except the four write tools; `raw_sentry_api` is among the 20, limited to what these scopes allow):

| Scope | Why |
| --- | --- |
| `event:read` | All issue and event reads, including traces (`get_trace_details`) |
| `org:read` | Organization-level listings |
| `project:read` | Project listing; event grouping info (`get_grouping_config`) |
| `team:read` | Team listing |
| `project:releases` | Release endpoints |

Add `event:write` **only** if you want the agent to change issue state. It enables `update_sentry_issue_status`, `create_sentry_issue_comment`, `bulk_update_issues` and `merge_issues`.

Do not grant `org:write`, `org:admin`, `project:admin`, `event:admin`, `member:*` or `org:ci`. No tool in this server needs them, and `event:admin` permits deletion.

Prefer one token per developer or per deployment over a shared organization-wide token, so you can revoke a single token without disrupting everyone.

## 2. `raw_sentry_api` bypasses least-privilege reasoning

`raw_sentry_api` takes an arbitrary endpoint path and an arbitrary HTTP method (`GET`, `POST`, `PUT`, `DELETE`). It is not restricted to the endpoints the other 23 tools use.

This means **the other tools' scope requirements are not a bound on what this server can do.** The real bound is the token. If you grant `org:admin` because some unrelated script needs it, an agent calling `raw_sentry_api` can reach every `org:admin` endpoint on your instance — the tool list gives no hint that this is possible.

Two consequences:

- Reason about risk from the **token's scopes**, never from the tool list.
- Treat this tool as the reason to keep the token narrow. It is the difference between "an agent can read issues" and "an agent can do whatever this token can do".

`SENTRY_READ_ONLY=true` restricts this tool to `GET`, which removes the write half of the problem but not the read half: a broadly scoped token still permits reading any endpoint on the instance. There is no setting that disables `raw_sentry_api` entirely while leaving the other tools enabled. If your threat model does not tolerate arbitrary reads, the token's scopes are the only real control.

## 3. Use `SENTRY_READ_ONLY` — and understand its limits

Setting `SENTRY_READ_ONLY` to `true` or `1` blocks writes:

| | Behaviour in read-only mode |
| --- | --- |
| `update_sentry_issue_status`, `create_sentry_issue_comment`, `bulk_update_issues`, `merge_issues` | Refused outright |
| `raw_sentry_api` | Restricted to `GET`; `POST`, `PUT` and `DELETE` are refused |
| The other 19 tools | Unaffected — all are reads |

**It is opt-in and defaults to `false`**, for backward compatibility with existing installs. If you do nothing, the write tools are exposed.

**It is not in npm release 1.1.2**, the current `latest`. That version ignores `SENTRY_READ_ONLY` without warning, so a config that sets it still runs with every write path open — including `raw_sentry_api` with `POST`, `PUT` and `DELETE`. Until 1.2.0 is published, build from source or use the Docker image (see the README), and rely on the token's scopes in any case.

```json
"env": {
  "SENTRY_URL": "https://sentry.example.com",
  "SENTRY_AUTH_TOKEN": "<your-token>",
  "SENTRY_ORG_SLUG": "your-org",
  "SENTRY_READ_ONLY": "true"
}
```

This is a **defence in depth measure, not a security boundary**. It is an application-level switch on a process whose configuration the user controls; anyone who can edit the config can turn it off. A token without `event:write` is enforced by Sentry itself and cannot be undone from the client side.

Use both: the env var stops an agent from calling a write tool by mistake, the scope stops the credential from being usable if it leaks.

## 4. Keep tokens out of version control

Add the config files to `.gitignore`:

```gitignore
.mcp.json
.cursor/mcp.json
.env
```

Better options, in rough order of preference:

1. **Reference the environment instead of inlining.** With Docker, pass `-e SENTRY_AUTH_TOKEN` with no value and let it inherit from your shell, or use `--env-file` with a gitignored `.env`.
2. **Use user scope, not project scope.** `claude mcp add --scope user` keeps the definition outside the repository entirely.
3. **Use a secret manager** and inject at process start.

If a token has already been committed: **rotate it first** (Sentry Settings → Auth Tokens → revoke, then create a new one). Rewriting git history does not help — assume anything pushed has been captured.

## 5. Operational notes

- **Sensitive data flows into the model's context.** Sentry events contain user data by nature. Every issue, breadcrumb and stack frame the agent reads goes to whatever model backs your MCP client. Confirm that is consistent with your data handling obligations. Sentry's own server-side data scrubbing applies before this server ever sees the payload — configure it there.
- **Use TLS.** `SENTRY_URL` should be `https://`. The token is sent as a bearer credential on every request.
- **MCP client logs.** The server writes diagnostics to stderr, including endpoint paths, issue IDs and project slugs. It does not log the token, but it does log what you queried. Treat client log files as sensitive.
- **Untrusted content.** Issue titles, comments, breadcrumb messages and stack frames are attacker-influenced in any application that accepts user input. An agent reading them is reading untrusted text. Do not let it act on instructions found in Sentry data.
- **`bulk_update_issues` is broad.** It refuses to run without a non-empty `query` or an `issue_ids` list, because Sentry applies an unselected bulk update to every unresolved issue in the project (up to 1000) — but a broad `query` can still match hundreds of issues. **`merge_issues` is not reversible**, and Sentry, not the caller, decides which issue survives. Both need `event:write`; withholding that scope is the reliable way to prevent them.

## Supported versions

Fixes are published against the latest released version on npm. Upgrade before reporting an issue you have not reproduced on the current release.

## Reporting a vulnerability

Report privately — **do not open a public issue** for an unfixed vulnerability.

Use [GitHub's private vulnerability reporting](https://github.com/HieuAnh87/sentry-selfhosted-mcp/security/advisories/new) on this repository. If that is unavailable to you, open a public issue containing **only** a request for a private contact channel, with no details of the vulnerability.

Please include:

- Affected version and how the server was installed
- Reproduction steps or a proof of concept
- What an attacker gains
- Any suggested fix

This is a volunteer-maintained project with no funded security team and no bug bounty. Expect an acknowledgement within about a week; complex fixes may take longer. You will be credited in the advisory and [CHANGELOG.md](CHANGELOG.md) unless you ask otherwise.

### Out of scope

- Vulnerabilities in Sentry itself — report those to [Sentry](https://sentry.io/security/).
- Anything requiring an already-compromised `SENTRY_AUTH_TOKEN`, which is game over by definition.
- The fact that a broadly scoped token permits broad access. That is the documented behaviour described in section 2; scope the token.
