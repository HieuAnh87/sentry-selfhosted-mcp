// Field filtering utilities

// Segments that would let a caller-supplied field path reach Object.prototype
const UNSAFE_SEGMENTS = ['__proto__', 'constructor', 'prototype'];

const isSafeFieldPath = (field: string): boolean =>
  field.split('.').every(segment => !UNSAFE_SEGMENTS.includes(segment));

const hasOwn = (obj: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

// Always define instead of assign: never triggers an inherited setter
const setField = (target: Record<string, unknown>, key: string, value: unknown): void => {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
};

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

  const source = obj as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  // If include fields specified, only include those
  if (includeFields && includeFields.length > 0) {
    // Group nested paths by parent so siblings ("a.b", "a.c") survive a single recursion
    const nestedPaths = new Map<string, string[]>();
    for (const field of includeFields) {
      if (!isSafeFieldPath(field) || !field.includes('.')) continue;
      const [parent, ...rest] = field.split('.');
      if (!hasOwn(source, parent)) continue;
      const children = nestedPaths.get(parent);
      if (children) children.push(rest.join('.'));
      else nestedPaths.set(parent, [rest.join('.')]);
    }

    for (const field of includeFields) {
      if (!isSafeFieldPath(field)) continue;
      const key = field.split('.')[0];
      if (hasOwn(result, key)) continue;

      const children = nestedPaths.get(key);
      if (children) {
        // The recursive call already returns the child keyed under its own name
        setField(result, key, filterObjectFields(source[key], children, undefined));
      } else if (hasOwn(source, key)) {
        setField(result, key, source[key]);
      }
    }
  } else {
    // Start with all fields
    for (const [key, value] of Object.entries(source)) setField(result, key, value);

    // Remove excluded fields
    if (excludeFields && excludeFields.length > 0) {
      for (const field of excludeFields) {
        if (!isSafeFieldPath(field)) continue;

        if (field.includes('.')) {
          const [parent, ...rest] = field.split('.');
          const childField = rest.join('.');
          if (hasOwn(result, parent) && result[parent]) {
            setField(result, parent, filterObjectFields(result[parent], undefined, [childField]));
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
