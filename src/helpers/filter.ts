// Field filtering utilities

/**
 * Filter object fields based on include/exclude lists.
 * Supports dot notation for nested field paths (e.g., 'latest_event.entries').
 */
export function filterObjectFields(
  obj: unknown,
  includeFields?: string[],
  excludeFields?: string[]
): unknown {
  if (!obj || typeof obj !== 'object') return obj;

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map(item => filterObjectFields(item, includeFields, excludeFields));
  }

  const result: Record<string, unknown> = {};

  // If include fields specified, only include those
  if (includeFields && includeFields.length > 0) {
    for (const field of includeFields) {
      if (field.includes('.')) {
        // Handle nested field paths like "latest_event.entries"
        const [parent, ...rest] = field.split('.');
        const childField = rest.join('.');
        if ((obj as Record<string, unknown>)[parent] !== undefined) {
          if (!result[parent]) result[parent] = {};
          (result[parent] as Record<string, unknown>)[childField] =
            filterObjectFields(
              (obj as Record<string, unknown>)[parent],
              [childField],
              undefined
            );
        }
      } else if ((obj as Record<string, unknown>)[field] !== undefined) {
        result[field] = (obj as Record<string, unknown>)[field];
      }
    }
  } else {
    // Start with all fields
    Object.assign(result, obj);

    // Remove excluded fields
    if (excludeFields && excludeFields.length > 0) {
      for (const field of excludeFields) {
        if (field.includes('.')) {
          const [parent, ...rest] = field.split('.');
          const childField = rest.join('.');
          if (result[parent]) {
            result[parent] = filterObjectFields(result[parent], undefined, [childField]);
          }
        } else {
          delete result[field];
        }
      }
    }
  }

  return result;
}

// Backward-compatible re-exports (moved to helpers/extract.ts)
export {
  extractEssentialIssueFields,
  extractEssentialEventEntry,
  extractBreadcrumbs,
} from './extract.js';
