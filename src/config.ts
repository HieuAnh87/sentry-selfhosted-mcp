// Sentry Configuration — Environment validation + constants

export const CONFIG = {
  TIMEOUT_MS: 20_000,
  MAX_TOKENS: 50_000,
  DEFAULT_LIMIT: 25,
  DEFAULT_MAX_FRAMES: 50,
  DEFAULT_EVENT_ENTRIES: 5,
  MAX_GREP_MATCHES: 200,
  MAX_STACK_FRAMES_IN_EXTRACT: 5,
  BREADCRUMBS_LIMIT: 10,
} as const;

// Read from environment
const SENTRY_URL = process.env.SENTRY_URL;
const SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN;
const SENTRY_ORG_SLUG = process.env.SENTRY_ORG_SLUG;

// Validate required environment variables
export function validateConfig(): void {
  if (!SENTRY_URL) {
    throw new Error('SENTRY_URL environment variable is required');
  }
  if (!SENTRY_AUTH_TOKEN) {
    throw new Error('SENTRY_AUTH_TOKEN environment variable is required');
  }
  if (!SENTRY_ORG_SLUG) {
    throw new Error('SENTRY_ORG_SLUG environment variable is required');
  }

  // Validate URL format
  try {
    new URL(SENTRY_URL);
  } catch {
    throw new Error(`Invalid SENTRY_URL format: ${SENTRY_URL}`);
  }
}

// Initialize on module load
validateConfig();

// Export normalized values
export const SENTRY_BASE_URL = SENTRY_URL!.endsWith('/')
  ? SENTRY_URL!.slice(0, -1)
  : SENTRY_URL!;

export const AUTH_TOKEN = SENTRY_AUTH_TOKEN!;
export const ORG_SLUG = SENTRY_ORG_SLUG!;

export const BASE_URL = SENTRY_BASE_URL;
export const TIMEOUT_MS = CONFIG.TIMEOUT_MS;
export const MAX_TOKENS = CONFIG.MAX_TOKENS;
export const DEFAULT_LIMIT = CONFIG.DEFAULT_LIMIT;
export const DEFAULT_MAX_FRAMES = CONFIG.DEFAULT_MAX_FRAMES;
export const DEFAULT_EVENT_ENTRIES = CONFIG.DEFAULT_EVENT_ENTRIES;
export const MAX_GREP_MATCHES = CONFIG.MAX_GREP_MATCHES;
export const MAX_STACK_FRAMES_IN_EXTRACT = CONFIG.MAX_STACK_FRAMES_IN_EXTRACT;
export const BREADCRUMBS_LIMIT = CONFIG.BREADCRUMBS_LIMIT;
