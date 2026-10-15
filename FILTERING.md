# Filtering large Sentry responses

The `get_sentry_issue` tool accepts five filter parameters for keeping large Sentry responses inside an agent's token budget. This page documents all of them.

Related: [README → Reducing response size](README.md#reducing-response-size) covers the equivalent controls on the other tools (`limit` and `entry_type` on `get_sentry_event_details`, `grep_pattern` on `raw_sentry_api`, `in_app_only` on `get_stack_frames`).

## Filtering Options

### 1. Field Filtering

#### Include Fields (Whitelist)
Only return specified fields:
```javascript
{
  "issue_id_or_url": "5217",
  "include_fields": ["id", "title", "status", "latest_event.entries"]
}
```

#### Exclude Fields (Blacklist)
Remove specific fields from response:
```javascript
{
  "issue_id_or_url": "5217",
  "exclude_fields": ["stats", "annotations", "latest_event.context"]
}
```

**Note:** Use dot notation for nested fields (e.g., `latest_event.entries`)

### 2. Stack Trace Truncation

Limit the number of stack frames returned:
```javascript
{
  "issue_id_or_url": "5217",
  "max_stack_frames": 5
}
```

This keeps only the most relevant (bottom) frames of the stack trace.

### 3. Grep Pattern Filtering

Filter response using regex patterns:
```javascript
{
  "issue_id_or_url": "5217",
  "grep_pattern": "AttributeError|process_activity"
}
```

### 4. Combined Filtering

All filters can be combined for maximum reduction:
```javascript
{
  "issue_id_or_url": "5217",
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
  "include_fields": ["title", "culprit", "latest_event.entries"],
  "max_stack_frames": 5
}
```

### Debug Specific Function
Search for specific function calls in the stack:
```javascript
{
  "issue_id_or_url": "5217",
  "grep_pattern": "process_activity|handle_.*_data",
  "max_stack_frames": 10
}
```

### Remove Heavy Metadata
Exclude stats and context to reduce size:
```javascript
{
  "issue_id_or_url": "5217",
  "exclude_fields": ["stats", "annotations", "latest_event.context", "latest_event.tags"]
}
```

## Implementation Details

- **Field filtering** is applied recursively through nested objects
- **Stack truncation** preserves the most relevant frames (bottom of stack)
- **Grep filtering** includes context lines for better understanding
- All filters are applied in order: truncation → field filtering → grep

## Token Reduction Strategy

For issues exceeding token limits, try this progression:
1. Start with `max_stack_frames: 5`
2. Add `exclude_fields` for metadata
3. Use `include_fields` for only essential data
4. Apply `grep_pattern` for specific error patterns

If the issue is still too large, the payload is probably in the event rather than the issue. Drop `include_latest_event` and fetch the event separately with `get_sentry_event_details` (`entry_type: "exception"`, `limit: 3`), or skip straight to `get_stack_frames` with `in_app_only: true`.