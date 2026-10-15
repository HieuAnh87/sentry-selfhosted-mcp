// JSON grep pattern matching utilities

import { MAX_GREP_MATCHES } from '../config.js';

/** Longest grep_pattern accepted. */
const MAX_PATTERN_LENGTH = 500;

/** Characters of a single line handed to the caller-supplied regex. */
const MAX_LINE_SCAN_CHARS = 500;

/** Wall-clock budget for one whole scan, in milliseconds. */
const MAX_SCAN_MS = 1_000;

/**
 * Backtracking states an unbounded quantifier can produce. It cannot try more
 * positions than there are characters on the line it is matching against.
 */
const UNBOUNDED_FACTOR = MAX_LINE_SCAN_CHARS;

/** Estimated backtracking states above which a pattern is refused. */
const MAX_BACKTRACK_COST = 50_000;

/**
 * Filter JSON content by regex pattern.
 * Returns matching lines with context (previous and next line).
 *
 * The pattern comes from the caller, so the regex is the untrusted input here
 * and this runs on the server's only thread. ReDoS is contained by three
 * independent limits, none of which needs a different regex engine:
 *   1. patterns whose backtracking can blow up — exponentially (a quantifier
 *      inside a repeated group) or polynomially (quantifiers that multiply each
 *      other's search space) — are rejected before they ever run, see
 *      findUnsafeConstruct;
 *   2. each line is cut to MAX_LINE_SCAN_CHARS before it reaches the regex, so
 *      backtracking on any single line is bounded by a small input;
 *   3. the scan as a whole stops at MAX_SCAN_MS and at MAX_GREP_MATCHES.
 */
export function grepFilter(data: unknown, pattern: string): unknown {
  // Input validation
  if (!pattern || typeof pattern !== 'string') {
    return data;
  }

  if (pattern.length > MAX_PATTERN_LENGTH) {
    return {
      error: `grep_pattern too long (max ${MAX_PATTERN_LENGTH} characters)`,
      original_pattern: pattern,
    };
  }

  let regex: RegExp;
  try {
    // 'i' only. NOT 'g': with the global flag RegExp.prototype.test() advances
    // lastIndex between calls, so testing many lines with one regex silently
    // alternates between matching and skipping.
    regex = new RegExp(pattern, 'i');
  } catch {
    return {
      error: `Invalid regex pattern: ${pattern}`,
      original_pattern: pattern,
    };
  }

  const unsafe = findUnsafeConstruct(pattern);
  if (unsafe) {
    return {
      error: `grep_pattern rejected: ${unsafe}`,
      original_pattern: pattern,
    };
  }

  const jsonStr = JSON.stringify(data, null, 2);
  const lines = jsonStr.split('\n');

  const deadline = Date.now() + MAX_SCAN_MS;
  const contextIndexes = new Set<number>();
  let matchCount = 0;
  let matchesCapped = false;
  let scanIncomplete = false;
  let longLines = 0;

  for (let i = 0; i < lines.length; i++) {
    if (matchCount >= MAX_GREP_MATCHES) {
      matchesCapped = true;
      break;
    }
    if (Date.now() > deadline) {
      scanIncomplete = true;
      break;
    }

    const line = lines[i];
    let scannable = line;
    if (line.length > MAX_LINE_SCAN_CHARS) {
      scannable = line.slice(0, MAX_LINE_SCAN_CHARS);
      longLines++;
    }

    if (!regex.test(scannable)) continue;

    matchCount++;
    // Context (previous and next line). The Set de-duplicates the overlap
    // between neighbouring matches instead of emitting the same line twice.
    if (i > 0) contextIndexes.add(i - 1);
    contextIndexes.add(i);
    if (i < lines.length - 1) contextIndexes.add(i + 1);
  }

  const orderedIndexes = [...contextIndexes].sort((a, b) => a - b);
  const cappedIndexes = orderedIndexes.slice(0, MAX_GREP_MATCHES * 3);
  const cappedLines = cappedIndexes.map((index) => lines[index]);
  const filtered = cappedLines.join('\n');

  // Try to parse as JSON, fallback to raw text
  try {
    return JSON.parse(filtered);
  } catch {
    const result: Record<string, unknown> = {
      grep_results: cappedLines,
      original_pattern: pattern,
      total_matches: matchCount,
      matches_capped: matchesCapped || cappedIndexes.length < orderedIndexes.length,
    };
    if (scanIncomplete) {
      result.scan_incomplete = `Scan stopped after ${MAX_SCAN_MS}ms; results are partial. Use a simpler grep_pattern.`;
    }
    if (longLines > 0) {
      result.long_lines_note = `${longLines} line(s) longer than ${MAX_LINE_SCAN_CHARS} characters were matched against their first ${MAX_LINE_SCAN_CHARS} characters only.`;
    }
    return result;
  }
}

// ============================================================
// Catastrophic-backtracking detection
// ============================================================

interface RegexAtom {
  /** Atom source text, excluding its quantifier. */
  text: string;
  /** Atom carries any quantifier, including `?`. */
  quantified: boolean;
  /** Atom can repeat more than once (`*`, `+`, `{n,m}` with m > 1). */
  repeated: boolean;
  /** Backtracking states the quantifier can produce (1 when unquantified). */
  factor: number;
  /** Atom is a group. */
  group: boolean;
  /** Atom is structural (`|`, `^`, `$`) and breaks a concatenation run. */
  boundary: boolean;
}

/**
 * Reject the pattern shapes that make backtracking blow up.
 * Returns a human-readable reason, or null when the pattern looks safe.
 *
 * Deliberately conservative — a rejected-but-harmless pattern costs the caller
 * one rewrite, an accepted-and-harmful one costs the whole server.
 */
function findUnsafeConstruct(pattern: string): string | null {
  // Exponential class: a quantifier or alternation inside a repeated group.
  const nested = findNestedQuantifier(pattern);
  if (nested) return nested;

  // Polynomial class: quantifiers that multiply each other's search space.
  const cost = estimateBacktrackCost(pattern);
  if (cost > MAX_BACKTRACK_COST) {
    return `pattern can backtrack over ~${cost.toExponential(1)} states per line (limit ${MAX_BACKTRACK_COST}). Separate the repeated parts with literal text, or replace them with a single repeat.`;
  }

  return null;
}

/** Exponential blowup: a quantifier or alternation inside a repeated group. */
function findNestedQuantifier(source: string): string | null {
  for (const atom of walkAtoms(source)) {
    if (!atom.group) continue;
    const body = groupBody(atom.text);

    if (atom.repeated) {
      if (hasQuantifier(body)) {
        return `repeated group "${atom.text}" contains a nested quantifier, which causes exponential backtracking. Drop either the inner or the outer quantifier (e.g. "a+" instead of "(a+)+").`;
      }
      if (hasAlternation(body)) {
        return `repeated group "${atom.text}" contains an alternation, which causes exponential backtracking when the branches overlap. Match the alternatives without repeating the group.`;
      }
    }

    const inner = findNestedQuantifier(body);
    if (inner) return inner;
  }

  return null;
}

/**
 * Estimate how many states the backtracker can explore for one line.
 *
 * Quantifiers in the same concatenation multiply, alternatives add, and a
 * required literal that the preceding quantifier *cannot* match pins the
 * position and starts a fresh segment. That last rule is what separates the
 * idiomatic patterns from the dangerous ones, and it is measured, not assumed:
 * `.*timeout.*` and `[a-z]+_[a-z]+` run in under a millisecond on a 500-char
 * line, while `.*a.*a.*a$` and `[a-z]+a[a-z]+a[a-z]+$` — same shape, but the
 * separator is a character the quantifier also matches — take seconds.
 */
function estimateBacktrackCost(source: string): number {
  let total = 0; // summed over alternatives
  let alternative = 0; // summed over the segments of the current alternative
  let segment = 1; // product of the factors in the current segment
  let literalRun = 0; // consecutive required literal characters
  let lastQuantified: string | null = null; // last quantified atom of this segment

  const closeSegment = (): void => {
    alternative += segment;
    segment = 1;
    lastQuantified = null;
  };

  for (const atom of walkAtoms(source)) {
    if (atom.boundary) {
      // `|` ends the alternative; `^` and `$` pin the position.
      closeSegment();
      if (atom.text === '|') {
        total += alternative;
        alternative = 0;
      }
      literalRun = 0;
      continue;
    }

    const groupCost = atom.group ? estimateBacktrackCost(groupBody(atom.text)) : 1;

    if (atom.factor > 1 || groupCost > 1) {
      segment *= atom.factor * groupCost;
      literalRun = 0;
      if (atom.factor > 1) lastQuantified = atom.text;
      // Saturate rather than overflow — it is already past the limit.
      if (segment > MAX_BACKTRACK_COST) break;
      continue;
    }

    const literal = literalChar(atom.text);
    if (literal === null) {
      literalRun = 0;
      continue;
    }

    literalRun++;
    // A multi-character literal pins the position on its own; a single one only
    // helps when the preceding quantifier cannot consume it too.
    if (literalRun >= 2 || lastQuantified === null || !canMatch(lastQuantified, literal)) {
      closeSegment();
    }
  }

  closeSegment();
  return total + alternative;
}

/** The literal character an atom matches, or null when it is not a plain literal. */
function literalChar(atomText: string): string | null {
  if (atomText.length === 1) {
    return '.^$*+?()[]{}|\\'.includes(atomText) ? null : atomText;
  }
  if (atomText.length === 2 && atomText[0] === '\\') {
    const escaped = atomText[1];
    if ('dDwWsSbBpPk'.includes(escaped)) return null; // class shorthand, not a literal
    const controls: Record<string, string> = { n: '\n', r: '\r', t: '\t', f: '\f', v: '\v', '0': '\0' };
    return controls[escaped] ?? escaped;
  }
  return null;
}

/** Can this single atom match this single character? */
function canMatch(atomText: string, char: string): boolean {
  try {
    // The atom carries no quantifier and the subject is one character, so this
    // test cannot itself backtrack.
    return new RegExp(`^(?:${atomText})$`).test(char);
  } catch {
    return true; // unparseable in isolation (e.g. a backreference) — assume overlap
  }
}

/** Yield the top-level atoms of a regex source, escape- and class-aware. */
function* walkAtoms(source: string): Generator<RegexAtom> {
  let i = 0;

  while (i < source.length) {
    const ch = source[i];

    if (ch === '|' || ch === '^' || ch === '$' || ch === ')') {
      yield { text: ch, quantified: false, repeated: false, factor: 1, group: false, boundary: true };
      i++;
      continue;
    }

    let end: number;
    let group = false;

    if (ch === '\\') {
      end = Math.min(i + 2, source.length);
    } else if (ch === '[') {
      end = skipCharClass(source, i);
    } else if (ch === '(') {
      end = findGroupEnd(source, i);
      group = true;
    } else {
      end = i + 1;
    }

    const quantifier = readQuantifier(source, end);
    yield {
      text: source.slice(i, end),
      quantified: quantifier.end > end,
      repeated: quantifier.repeating,
      factor: quantifier.factor,
      group,
      boundary: false,
    };
    i = quantifier.end;
  }
}

/** Index just past the character class starting at `start`. */
function skipCharClass(source: string, start: number): number {
  let i = start + 1;
  if (source[i] === '^') i++;
  if (source[i] === ']') i++; // a leading ']' is a literal
  while (i < source.length && source[i] !== ']') {
    if (source[i] === '\\') i++;
    i++;
  }
  return Math.min(i + 1, source.length);
}

/** Index just past the group starting at `start`. */
function findGroupEnd(source: string, start: number): number {
  let depth = 0;
  let i = start;

  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
    } else if (ch === '[') {
      i = skipCharClass(source, i);
    } else if (ch === '(') {
      depth++;
      i++;
    } else if (ch === ')') {
      depth--;
      i++;
      if (depth === 0) return i;
    } else {
      i++;
    }
  }

  return source.length;
}

/** Read the quantifier at `start`, if any. */
function readQuantifier(source: string, start: number): { end: number; repeating: boolean; factor: number } {
  const ch = source[start];

  if (ch === '*' || ch === '+') {
    return { end: skipLazy(source, start + 1), repeating: true, factor: UNBOUNDED_FACTOR };
  }
  if (ch === '?') {
    return { end: skipLazy(source, start + 1), repeating: false, factor: 2 };
  }
  if (ch === '{') {
    const close = source.indexOf('}', start);
    const bounds = close === -1 ? null : /^(\d+)(?:,(\d*))?$/.exec(source.slice(start + 1, close));
    if (bounds) {
      const min = Number(bounds[1]);
      const max = bounds[2] === undefined ? min : bounds[2] === '' ? Infinity : Number(bounds[2]);
      return {
        end: skipLazy(source, close + 1),
        repeating: max > 1,
        factor: max === Infinity ? UNBOUNDED_FACTOR : Math.min(max - min + 1, UNBOUNDED_FACTOR),
      };
    }
  }

  return { end: start, repeating: false, factor: 1 };
}

/** Lazy quantifiers backtrack too, so they count as quantifiers. */
function skipLazy(source: string, index: number): number {
  return source[index] === '?' ? index + 1 : index;
}

/** Strip the parentheses and any `(?:`, `(?=`, `(?<name>` prefix from a group. */
function groupBody(groupText: string): string {
  let body = groupText.startsWith('(') ? groupText.slice(1) : groupText;
  if (body.endsWith(')')) body = body.slice(0, -1);
  const prefix = /^\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/.exec(body);
  return prefix ? body.slice(prefix[0].length) : body;
}

/** True when the source carries a quantifier at any nesting depth. */
function hasQuantifier(source: string): boolean {
  for (const atom of walkAtoms(source)) {
    if (atom.quantified) return true;
    if (atom.group && hasQuantifier(groupBody(atom.text))) return true;
  }
  return false;
}

/** True when the source carries an alternation at any nesting depth. */
function hasAlternation(source: string): boolean {
  for (const atom of walkAtoms(source)) {
    if (atom.boundary && atom.text === '|') return true;
    if (atom.group && hasAlternation(groupBody(atom.text))) return true;
  }
  return false;
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
