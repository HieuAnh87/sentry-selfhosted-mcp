// JSON grep pattern matching utilities

import { MAX_GREP_MATCHES } from '../config.js';

/**
 * Filter JSON content by regex pattern.
 * Returns matching lines with context (previous and next line).
 * Includes ReDoS protection: max matches cap and early termination.
 */
export function grepFilter(data: unknown, pattern: string): unknown {
  // Input validation
  if (!pattern || typeof pattern !== 'string') {
    return data;
  }

  // Pattern length limit (prevent ReDoS from long patterns)
  if (pattern.length > 500) {
    return {
      error: 'grep_pattern too long (max 500 characters)',
      original_pattern: pattern,
    };
  }

  let regex: RegExp;
  try {
    // 'gi' = global, case-insensitive
    regex = new RegExp(pattern, 'gi');
  } catch {
    return {
      error: `Invalid regex pattern: ${pattern}`,
      original_pattern: pattern,
    };
  }

  const jsonStr = JSON.stringify(data, null, 2);
  const lines = jsonStr.split('\n');
  const matchingLines: string[] = [];

  // ReDoS protection: limit iteration + early termination
  const maxIterations = Math.min(lines.length * 3, MAX_GREP_MATCHES * 3 + 1000);
  let iterations = 0;

  for (let i = 0; i < lines.length && iterations < maxIterations; i++) {
    iterations++;
    if (regex.test(lines[i])) {
      // Add context (previous and next line)
      if (i > 0) matchingLines.push(lines[i - 1]);
      matchingLines.push(lines[i]);
      if (i < lines.length - 1) matchingLines.push(lines[i + 1]);
    }
  }

  // Cap at MAX_GREP_MATCHES lines
  const cappedLines = matchingLines.slice(0, MAX_GREP_MATCHES * 3);
  const filtered = cappedLines.join('\n');

  // Try to parse as JSON, fallback to raw text
  try {
    return JSON.parse(filtered);
  } catch {
    return {
      grep_results: cappedLines,
      original_pattern: pattern,
      total_matches: Math.floor(matchingLines.length / 3),
      matches_capped: matchingLines.length > MAX_GREP_MATCHES * 3,
    };
  }
}

/**
 * Check if response is large enough to warrant grep warning.
 */
export function estimateTokens(jsonString: string): number {
  return Math.ceil(jsonString.length / 4);
}

/**
 * Generate grep suggestion for large responses.
 */
export function generateGrepSuggestions(): string {
  return `Suggested grep_patterns:
- Stack traces: '"function":|"filename":|"in_app":'
- Breadcrumbs: '"breadcrumbs"'
- Tags/metadata: '"tags"'
- Error details: '"type":|"value":'
- User data: '"user":|"email":'`;
}