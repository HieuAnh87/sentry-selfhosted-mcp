// Response truncation utilities

import { MAX_TOKENS } from '../config.js';

export interface TruncateResult<T> {
  data: T;
  truncated: boolean;
  pagination_info?: string;
}

/**
 * Truncate response data if it exceeds max token limit.
 * Uses rough estimation: 1 token ≈ 4 characters in JSON.
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

    for (const field of largeFields) {
      if (truncatedData[field] && Array.isArray(truncatedData[field])) {
        const originalLength = (truncatedData[field] as unknown[]).length;
        if (originalLength > 10) {
          truncatedData[field] = (truncatedData[field] as unknown[]).slice(0, 10);
          truncatedData[`${field}_truncated`] = `Showing 10 of ${originalLength} entries. Use pagination parameters to get more.`;
        }
      }
    }

    return {
      data: truncatedData as T,
      truncated: true,
      pagination_info: 'Response truncated due to size. Use limit and offset parameters to paginate through large nested data.',
    };
  }

  return { data, truncated: false };
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