// Response truncation utilities

import { MAX_TOKENS } from '../config.js';

export interface TruncateResult<T> {
  data: T;
  truncated: boolean;
  pagination_info?: string;
}

/** Rough estimation: 1 token ≈ 4 characters of JSON. */
function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value, null, 2).length / 4);
}

/**
 * Last-resort truncation: serialize, cut, and hand back a marked-up envelope.
 * Shrinks until the *serialized envelope* fits the budget, because escaping the
 * preview back into JSON inflates it well past the raw slice length.
 */
function hardCut(value: unknown, maxTokens: number): Record<string, unknown> {
  const jsonString = JSON.stringify(value, null, 2);
  const build = (chars: number): Record<string, unknown> => ({
    _truncated: true,
    _truncation_note: `Response exceeded the ${maxTokens} token budget (~${Math.ceil(jsonString.length / 4)} tokens) and was hard-truncated. The preview below is a raw JSON prefix and is NOT parseable. Narrow the response with include_fields, grep_pattern, or pagination.`,
    _content_preview: `${jsonString.slice(0, chars)}\n...[truncated]`,
  });

  // Re-escaping the preview into JSON inflates it (every newline and quote
  // doubles), so shrink proportionally to the overshoot until it really fits.
  let chars = maxTokens * 4;
  let envelope = build(chars);
  for (let guard = 0; guard < 12 && chars > 64; guard++) {
    const overshoot = estimateTokens(envelope);
    if (overshoot <= maxTokens) break;
    const ratio = Math.min((maxTokens / overshoot) * 0.95, 0.9);
    chars = Math.max(64, Math.floor(chars * ratio));
    envelope = build(chars);
  }
  return envelope;
}

/**
 * Truncate response data if it exceeds max token limit.
 * Uses rough estimation: 1 token ≈ 4 characters in JSON.
 *
 * `truncated` reports whether content was actually removed, and anything still
 * over budget after structural trimming gets a hard cut — an over-budget
 * response is never returned intact.
 */
export function truncateResponse<T>(data: T, maxTokens: number = MAX_TOKENS): TruncateResult<T> {
  const jsonString = JSON.stringify(data, null, 2);
  const estimatedTokens = Math.ceil(jsonString.length / 4);

  if (estimatedTokens <= maxTokens) {
    return { data, truncated: false };
  }

  // Array truncation
  if (Array.isArray(data)) {
    const itemsToKeep = Math.floor(data.length * (maxTokens / estimatedTokens));
    const truncatedData = data.slice(0, Math.max(1, itemsToKeep));

    // A single oversized item survives the slice — cut it for real.
    if (estimateTokens(truncatedData) > maxTokens) {
      return {
        data: hardCut(truncatedData, maxTokens) as T,
        truncated: true,
        pagination_info: `Response truncated. Showing a hard-truncated preview of ${truncatedData.length} of ${data.length} items. Use limit and cursor parameters to paginate through all results.`,
      };
    }

    return {
      data: truncatedData as T,
      truncated: true,
      pagination_info: `Response truncated. Showing ${truncatedData.length} of ${data.length} items. Use limit and cursor parameters to paginate through all results.`,
    };
  }

  // Object truncation — reduce large nested arrays
  if (typeof data === 'object' && data !== null) {
    const truncatedData = { ...data as Record<string, unknown> };
    const largeFields = ['entries', 'stacktrace', 'frames', 'breadcrumbs', 'contexts', 'tags', 'extra'];
    let removedAnything = false;

    for (const field of largeFields) {
      if (truncatedData[field] && Array.isArray(truncatedData[field])) {
        const originalLength = (truncatedData[field] as unknown[]).length;
        if (originalLength > 10) {
          truncatedData[field] = (truncatedData[field] as unknown[]).slice(0, 10);
          truncatedData[`${field}_truncated`] = `Showing 10 of ${originalLength} entries. Use pagination parameters to get more.`;
          removedAnything = true;
        }
      }
    }

    // Slicing the known-large fields is not a budget: whatever is left may
    // still be arbitrarily big, so enforce the cap explicitly.
    if (estimateTokens(truncatedData) > maxTokens) {
      return {
        data: hardCut(truncatedData, maxTokens) as T,
        truncated: true,
        pagination_info: 'Response truncated due to size. Use limit and offset parameters to paginate through large nested data.',
      };
    }

    return {
      data: truncatedData as T,
      truncated: removedAnything,
      pagination_info: removedAnything
        ? 'Response truncated due to size. Use limit and offset parameters to paginate through large nested data.'
        : undefined,
    };
  }

  // Oversized primitive (usually a very long string).
  return {
    data: hardCut(data, maxTokens) as T,
    truncated: true,
    pagination_info: 'Response truncated due to size. Use limit and offset parameters to paginate through large nested data.',
  };
}

/**
 * Recursively truncate stack traces to specified number of frames.
 * Keeps the most recent (bottom) frames which are usually most relevant.
 */
export function truncateStackTraces(data: unknown, maxFrames: number): unknown {
  if (!data || typeof data !== 'object') return data;

  if (Array.isArray(data)) {
    return data.map(item => truncateStackTraces(item, maxFrames));
  }

  const result = { ...data as Record<string, unknown> };

  // Truncate exception stack traces
  if (result.entries && Array.isArray(result.entries)) {
    result.entries = (result.entries as Record<string, unknown>[]).map((entry) => {
      if (entry.type === 'exception') {
        const data = entry.data as Record<string, unknown> | undefined;
        if (data?.values) {
          const values = data.values as unknown[];
          data.values = values.map((v) => {
            const value = v as Record<string, unknown>;
            const stacktrace = value.stacktrace as Record<string, unknown> | undefined;
            if (stacktrace?.frames && Array.isArray(stacktrace.frames)) {
              const frames = stacktrace.frames as unknown[];
              if (frames.length > maxFrames) {
                stacktrace.frames = frames.slice(-maxFrames);
                stacktrace.frames_omitted = frames.length - maxFrames;
              }
            }
            return value;
          });
        }
      }
      return entry;
    });
  }

  // Recursively process nested objects
  for (const key in result) {
    if (typeof result[key] === 'object' && result[key] !== null) {
      result[key] = truncateStackTraces(result[key], maxFrames);
    }
  }

  return result;
}