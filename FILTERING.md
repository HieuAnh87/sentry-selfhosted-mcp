# Filtering large Sentry responses

The `get_sentry_issue` tool accepts five parameters that control response size — `include_latest_event`, `include_fields`, `exclude_fields`, `max_stack_frames` and `grep_pattern` — for keeping large Sentry responses inside an agent's token budget. This page documents all of them.

Related: [README → Reducing response size](README.md#reducing-response-size) covers the equivalent controls on the other tools (`limit` and `entry_type` on `get_sentry_event_details`, `grep_pattern` on `raw_sentry_api`, `in_app_only` on `get_stack_frames`, `cursor` on list tools).

## What the response contains

Filters can only select from fields that exist. By default `get_sentry_issue` returns a compact issue and `"latest_event": null`:

| Field | Notes |
| --- | --- |
| `id`, `shortId`, `title`, `culprit`, `permalink`, `logger`, `level`, `status`, `type`, `platform`, `count`, `userCount`, `firstSeen`, `lastSeen` | Scalar issue fields |
| `project` | Object (`id`, `slug`, `name`, …) |
| `metadata` | Object; for errors usually `type`, `value`, `filename`, `function` |
| `_note` | Present when Sentry's full issue had heavy fields that were dropped |
| `latest_event` | `null` unless `include_latest_event: true` |
| `latest_event_error` | Present only if the latest event could not be fetched |

With `include_latest_event: true`, `latest_event` holds a compact copy of the issue's latest event: `id`, `eventID`, `dateCreated`, `_note`, and `entries` — up to three event entries, each reduced to its debugging signal:

- `exception` entries keep `data.values[].type`, `value`, `mechanism` and `stacktrace.frames[]`. Each frame keeps `filename`, `function`, `lineNo`, `colNo`, `absPath`, `context` (±3 lines of source around the crash line) and `vars` (`"..."` when present). By default the 5 innermost frames per exception are kept; `max_stack_frames` changes that number.
- `message` entries are returned as-is.
- `breadcrumbs` entries keep the last 10 breadcrumbs.
- Any other entry type is reduced to `{ "type": ..., "_truncated": true }`.

Raw Sentry fields such as `stats`, `annotations`, `tags`, `contexts` or the event's `context` are **never** in this response, so excluding them does nothing. For those, use `get_sentry_event_details` or `raw_sentry_api` with a `grep_pattern`.

## Filtering Options

### 1. Latest event

Off by default. Turn it on to get the stack trace in the same call:
```javascript
{
  "issue_id_or_url": "5217",
  "include_latest_event": true
}
```

**`max_stack_frames` and every `latest_event.*` field path need this.** Without it there is no event in the response, so they silently match nothing.

### 2. Field Filtering

#### Include Fields (Whitelist)
Only return specified fields:
```javascript
{
  "issue_id_or_url": "5217",
  "include_latest_event": true,
  "include_fields": ["id", "title", "status", "latest_event.entries"]
}
```

#### Exclude Fields (Blacklist)
Remove specific fields from response:
```javascript
{
  "issue_id_or_url": "5217",
  "exclude_fields": ["metadata", "project", "permalink"]
}
```

**Note:** Use dot notation for nested fields (e.g., `latest_event.entries`). If `include_fields` is set, `exclude_fields` is ignored.

### 3. Stack Trace Truncation

Limit the number of stack frames returned:
```javascript
{
  "issue_id_or_url": "5217",
  "include_latest_event": true,
  "max_stack_frames": 10
}
```

This keeps the innermost frames — the bottom of the stack, where the error was raised — and sets `frames_omitted` on each trimmed stack trace. Values above the default of 5 return more frames.

### 4. Grep Pattern Filtering

Filter response using regex patterns:
```javascript
{
  "issue_id_or_url": "5217",
  "include_latest_event": true,
  "grep_pattern": "AttributeError|process_activity"
}
```

See [Grep limits](#grep-limits) for how patterns are matched and what is refused.

### 5. Combined Filtering

All filters can be combined for maximum reduction:
```javascript
{
  "issue_id_or_url": "5217",
  "include_latest_event": true,
  "include_fields": ["id", "title", "latest_event.entries"],
  "max_stack_frames": 3,
  "grep_pattern": "error"
}
```

## Usage Examples

### Minimal Error Information
Get just the error message and top stack frames:
```javascript
{
  "issue_id_or_url": "5217",
  "include_latest_event": true,
  "include_fields": ["title", "culprit", "latest_event.entries"],
  "max_stack_frames": 5
}
```

### Debug Specific Function
Search for specific function calls in the stack:
```javascript
{
  "issue_id_or_url": "5217",
  "include_latest_event": true,
  "grep_pattern": "process_activity|handle_.*_data",
  "max_stack_frames": 10
}
```

### Issue Summary Only
Drop the bulky objects and keep the issue overview (no event fetched):
```javascript
{
  "issue_id_or_url": "5217",
  "exclude_fields": ["metadata", "project", "permalink", "_note"]
}
```

### Stack Trace Without Source Context
Keep the latest event but drop the per-frame source context:
```javascript
{
  "issue_id_or_url": "5217",
  "include_latest_event": true,
  "exclude_fields": ["metadata", "project", "latest_event.entries.data.values.stacktrace.frames.context"]
}
```

## Implementation Details

- **Field filtering** is applied recursively through nested objects, and through arrays element by element
- **Stack truncation** preserves the most relevant frames (bottom of stack)
- **Grep filtering** includes context lines for better understanding
- All filters are applied in order: truncation → field filtering → grep

## Grep limits

`grep_pattern` is also accepted by `raw_sentry_api`; the same rules apply to both tools.

- **How it matches.** The response is serialized as indented JSON and the pattern is tested line by line. Each matching line is returned with one line of context before and after. The result is usually `{ "grep_results": [...lines], "original_pattern", "total_matches", "matches_capped" }`; if the selected lines happen to form valid JSON on their own, that JSON is returned instead.
- **Case-insensitive.** Patterns always run with the `i` flag. There is no way to force a case-sensitive match.
- **Pattern length.** At most 500 characters. Longer patterns return an `error` instead of results.
- **Match cap.** Scanning stops after 200 matching lines (`MAX_GREP_MATCHES` in `src/config.ts`), and at most 600 lines including context are returned. `matches_capped: true` tells you the cap was hit — tighten the pattern.
- **Long lines.** Only the first 500 characters of each line are tested. A match further along a long line (a minified stack, a big string value) is missed; `long_lines_note` says how many lines were cut.
- **Time budget.** The whole scan stops after 1 second, with `scan_incomplete` set and partial results.
- **Unsafe patterns are refused before they run.** Patterns that can backtrack catastrophically return an `error` explaining why, for example:
  - a quantifier inside a repeated group: `(a+)+`, `(\w*)*`
  - an alternation inside a repeated group: `(foo|bar)+`
  - several unbounded quantifiers not separated by literal text they cannot consume: `.*a.*a.*a$`

  Ordinary patterns such as `AttributeError|process_activity`, `handle_.*_data` and `.*timeout.*` are accepted. To match one of several words repeatedly, drop the outer repeat: `foo|bar`, not `(foo|bar)+`.
- **Invalid regex** returns an `error` naming the pattern rather than failing the tool call.

## Token Reduction Strategy

When `include_latest_event: true` makes an issue exceed the token budget, try this progression:
1. Start with `max_stack_frames: 5`
2. Add `exclude_fields` for metadata
3. Use `include_fields` for only essential data
4. Apply `grep_pattern` for specific error patterns

If the issue is still too large, the payload is probably in the event rather than the issue. Drop `include_latest_event` and fetch the event separately with `get_sentry_event_details` (`entry_type: "exception"`, `limit: 3`), or skip straight to `get_stack_frames` with `in_app_only: true`.