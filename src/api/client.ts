// Sentry API Client — Axios wrapper

import axios, { AxiosError, AxiosResponse } from 'axios';
import { BASE_URL, AUTH_TOKEN, TIMEOUT_MS, ORG_SLUG } from '../config.js';
import { parseLinkHeader } from '../helpers/pagination.js';
import type { SentryIssue, SentryIssueHash, SentryEvent, SentryRelease, SentryTeam, SentryTag, SentryTagValue, SentryActivity, SentryProject, SentryAttachment, SentryUserReport, Paged } from './types.js';

// Re-export types for convenience
export type {
  SentryIssue,
  SentryIssueHash,
  SentryEvent,
  SentryRelease,
  SentryTeam,
  SentryTag,
  SentryTagValue,
  SentryActivity,
  SentryProject,
  SentryAttachment,
  SentryUserReport,
  Paged,
};

/** Percent-encode a value before interpolating it into an API path segment. */
function seg(value: string): string {
  return encodeURIComponent(value);
}

/** Parse a raw response body; an empty body (e.g. 204) is valid and yields ''. */
function parseJsonBody(data: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof data !== 'string') return { ok: true, value: data };
  if (data.trim() === '') return { ok: true, value: '' };
  try {
    return { ok: true, value: JSON.parse(data) };
  } catch {
    return { ok: false };
  }
}

/** Which issues a bulk mutation applies to. At least one of the two is required. */
export interface IssueSelector {
  ids?: string[];
  query?: string;
}

function selectorParams(selector: IssueSelector): URLSearchParams {
  const ids = (selector.ids ?? []).filter(id => id.trim() !== '');
  const query = selector.query?.trim();
  if (ids.length === 0 && !query) {
    throw new Error('Refusing bulk issue mutation without issue IDs or a query: Sentry would apply it to every unresolved issue.');
  }

  // URLSearchParams repeats `id=` per value; axios' default array encoding (`id[]=`) is not understood by Sentry.
  const params = new URLSearchParams();
  for (const id of ids) params.append('id', id);
  if (query) params.append('query', query);
  return params;
}

export class SentryApiClient {
  private client = axios.create({
    baseURL: `${BASE_URL}/api/0/`,
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    timeout: TIMEOUT_MS,
    // Never let a caller-supplied absolute URL override baseURL.
    allowAbsoluteUrls: false,
    // Do not follow redirects on a token-bearing client. A same-origin API
    // endpoint must not be usable as a redirect trampoline for SSRF, and some
    // redirect implementations retain credentials for related hosts.
    maxRedirects: 0,
    // Bodies are parsed in the interceptors below, not by axios: when axios' own
    // strict JSON parsing fails it drops the response, so a proxy's "504 upstream
    // request timeout" page surfaced as a bare "Unexpected token" with no status.
    responseType: 'text',
    transformResponse: [(data: unknown) => data],
  });

  constructor() {
    this.client.interceptors.response.use(
      (response: AxiosResponse) => {
        // Attachment downloads ask for raw bytes and are decoded by the caller
        if (response.config.responseType === 'arraybuffer') return response;
        const parsed = parseJsonBody(response.data);
        if (!parsed.ok) {
          // Proxy/SSO HTML pages and truncated bodies must not pass as Sentry data.
          throw new AxiosError(
            `Sentry returned a non-JSON response (HTTP ${response.status}, ${String(response.headers?.['content-type'] ?? 'no content type')})`,
            AxiosError.ERR_BAD_RESPONSE,
            response.config,
            response.request,
            response
          );
        }
        response.data = parsed.value;
        return response;
      },
      (error: AxiosError) => {
        // Keep the status and decode JSON error bodies; leave non-JSON ones as text.
        if (error.response) {
          const parsed = parseJsonBody(error.response.data);
          if (parsed.ok) error.response.data = parsed.value;
        }
        const url = error.config?.url || 'unknown';
        console.error(`[Sentry API Error] ${url}: ${error.message}`);
        return Promise.reject(error);
      }
    );
  }

  // Generic HTTP methods
  async get<T>(endpoint: string, params?: Record<string, unknown>): Promise<T> {
    const response = await this.client.get<T>(endpoint, { params });
    return response.data;
  }

  /** GET that also reports Sentry's `Link` pagination state. */
  async getPaged<T>(endpoint: string, params?: Record<string, unknown>): Promise<Paged<T>> {
    const response = await this.client.get<T>(endpoint, { params });
    const link = response.headers?.link;
    return { data: response.data, ...parseLinkHeader(typeof link === 'string' ? link : undefined) };
  }

  async post<T>(endpoint: string, data?: unknown, params?: Record<string, unknown>): Promise<T> {
    const response = await this.client.post<T>(endpoint, data ?? {}, { params });
    return response.data;
  }

  async put<T>(endpoint: string, data?: unknown, params?: Record<string, unknown> | URLSearchParams): Promise<T> {
    const response = await this.client.put<T>(endpoint, data ?? {}, { params });
    return response.data;
  }

  async delete<T>(endpoint: string): Promise<T> {
    const response = await this.client.delete<T>(endpoint);
    return response.data;
  }

  /**
   * Issue-scoped path. The organization-scoped form is used because only it
   * resolves short IDs (e.g. `PROJ-1A2`); the legacy `issues/{id}/` path 404s on them.
   */
  private issuePath(issueId: string, suffix = ''): string {
    return `organizations/${seg(ORG_SLUG)}/issues/${seg(issueId)}/${suffix}`;
  }

  // ============================================================
  // Issues
  // ============================================================

  async getIssue(issueId: string): Promise<SentryIssue> {
    return this.get<SentryIssue>(this.issuePath(issueId));
  }

  async listProjectIssues(orgSlug: string, projectSlug: string, params?: Record<string, unknown>): Promise<Paged<SentryIssue[]>> {
    return this.getPaged<SentryIssue[]>(`projects/${seg(orgSlug)}/${seg(projectSlug)}/issues/`, params);
  }

  async searchIssues(orgSlug: string, params?: Record<string, unknown>): Promise<Paged<SentryIssue[]>> {
    // Listing an organization's issues is a GET (PUT mutates, DELETE removes).
    return this.getPaged<SentryIssue[]>(`organizations/${seg(orgSlug)}/issues/`, params);
  }

  async updateIssue(issueId: string, data: { status?: string }): Promise<SentryIssue> {
    return this.put<SentryIssue>(this.issuePath(issueId), data);
  }

  async createIssueComment(issueId: string, text: string): Promise<unknown> {
    return this.post(this.issuePath(issueId, 'comments/'), { text });
  }

  async getIssueHashes(issueId: string, params?: Record<string, unknown>): Promise<Paged<SentryIssueHash[]>> {
    return this.getPaged<SentryIssueHash[]>(this.issuePath(issueId, 'hashes/'), params);
  }

  /**
   * Bulk-mutate issues in a project. Sentry reads the selection (`id`, `query`)
   * from the URL only and ignores it in the body; with no selection it falls back
   * to every unresolved issue (up to 1000), so an empty selector is refused here.
   */
  async bulkUpdateProjectIssues(
    orgSlug: string,
    projectSlug: string,
    selector: IssueSelector,
    data: Record<string, unknown>
  ): Promise<unknown> {
    return this.put(
      `projects/${seg(orgSlug)}/${seg(projectSlug)}/issues/`,
      data,
      selectorParams(selector)
    );
  }

  // ============================================================
  // Events
  // ============================================================

  async getEvent(orgSlug: string, projectSlug: string, eventId: string): Promise<SentryEvent> {
    return this.get<SentryEvent>(`projects/${seg(orgSlug)}/${seg(projectSlug)}/events/${seg(eventId)}/`);
  }

  async listIssueEvents(issueId: string, params?: Record<string, unknown>): Promise<Paged<SentryEvent[]>> {
    return this.getPaged<SentryEvent[]>(this.issuePath(issueId, 'events/'), params);
  }

  async listProjectEvents(orgSlug: string, projectSlug: string, params?: Record<string, unknown>): Promise<Paged<SentryEvent[]>> {
    return this.getPaged<SentryEvent[]>(`projects/${seg(orgSlug)}/${seg(projectSlug)}/events/`, params);
  }

  async getLatestEventForIssue(orgSlug: string, issueId: string): Promise<SentryEvent> {
    return this.get<SentryEvent>(`organizations/${seg(orgSlug)}/issues/${seg(issueId)}/events/latest/`);
  }

  // ============================================================
  // Releases
  // ============================================================

  async listReleases(orgSlug: string, params?: Record<string, unknown>): Promise<Paged<SentryRelease[]>> {
    return this.getPaged<SentryRelease[]>(`organizations/${seg(orgSlug)}/releases/`, params);
  }

  async getRelease(orgSlug: string, version: string): Promise<SentryRelease> {
    return this.get<SentryRelease>(`organizations/${seg(orgSlug)}/releases/${seg(version)}/`);
  }

  // ============================================================
  // Projects & Teams
  // ============================================================

  async listProjects(orgSlug: string, params?: Record<string, unknown>): Promise<Paged<SentryProject[]>> {
    return this.getPaged<SentryProject[]>(`organizations/${seg(orgSlug)}/projects/`, params);
  }

  async listTeams(orgSlug: string, params?: Record<string, unknown>): Promise<Paged<SentryTeam[]>> {
    return this.getPaged<SentryTeam[]>(`organizations/${seg(orgSlug)}/teams/`, params);
  }

  // ============================================================
  // Tags & Activity
  // ============================================================

  async getIssueTags(issueId: string): Promise<SentryTag[]> {
    return this.get<SentryTag[]>(this.issuePath(issueId, 'tags/'));
  }

  async getIssueTagValues(issueId: string, tagKey: string, params?: Record<string, unknown>): Promise<Paged<SentryTagValue[]>> {
    return this.getPaged<SentryTagValue[]>(this.issuePath(issueId, `tags/${seg(tagKey)}/values/`), params);
  }

  async listIssueActivity(issueId: string, params?: Record<string, unknown>): Promise<Paged<SentryActivity[]>> {
    // The route is `activities/`; `activity/` does not exist and 404s.
    return this.getPaged<SentryActivity[]>(this.issuePath(issueId, 'activities/'), params);
  }

  // ============================================================
  // Account
  // ============================================================

  /** `GET /api/0/`: API version, the token's scopes and the user it belongs to. */
  async getApiRoot(): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>('');
  }

  async getOrganization(orgSlug: string): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>(`organizations/${seg(orgSlug)}/`);
  }

  // ============================================================
  // Attachments & User Feedback
  // ============================================================

  async listIssueAttachments(issueId: string, params?: Record<string, unknown>): Promise<Paged<SentryAttachment[]>> {
    return this.getPaged<SentryAttachment[]>(this.issuePath(issueId, 'attachments/'), params);
  }

  async listEventAttachments(projectSlug: string, eventId: string, params?: Record<string, unknown>): Promise<Paged<SentryAttachment[]>> {
    return this.getPaged<SentryAttachment[]>(
      `projects/${seg(ORG_SLUG)}/${seg(projectSlug)}/events/${seg(eventId)}/attachments/`,
      params
    );
  }

  async getEventAttachment(projectSlug: string, eventId: string, attachmentId: string): Promise<SentryAttachment> {
    return this.get<SentryAttachment>(this.attachmentPath(projectSlug, eventId, attachmentId));
  }

  /**
   * Raw attachment bytes, refused above `maxBytes`. Sentry streams locally stored
   * files; one kept in external storage answers with a redirect, which this
   * token-bearing client deliberately does not follow.
   */
  async downloadEventAttachment(projectSlug: string, eventId: string, attachmentId: string, maxBytes: number): Promise<Buffer> {
    const response = await this.client.get<ArrayBuffer>(this.attachmentPath(projectSlug, eventId, attachmentId), {
      params: { download: '1' },
      responseType: 'arraybuffer',
      maxContentLength: maxBytes,
    });
    return Buffer.from(response.data);
  }

  private attachmentPath(projectSlug: string, eventId: string, attachmentId: string): string {
    return `projects/${seg(ORG_SLUG)}/${seg(projectSlug)}/events/${seg(eventId)}/attachments/${seg(attachmentId)}/`;
  }

  async listIssueUserReports(issueId: string, params?: Record<string, unknown>): Promise<Paged<SentryUserReport[]>> {
    return this.getPaged<SentryUserReport[]>(this.issuePath(issueId, 'user-reports/'), params);
  }

  async listProjectUserReports(projectSlug: string, params?: Record<string, unknown>): Promise<Paged<SentryUserReport[]>> {
    return this.getPaged<SentryUserReport[]>(`projects/${seg(ORG_SLUG)}/${seg(projectSlug)}/user-reports/`, params);
  }

  // ============================================================
  // Advanced
  // ============================================================

  /**
   * Trace tree. `trace/` is the current endpoint; older self-hosted versions
   * only have `events-trace/`, so a 404 falls back to it.
   */
  async getTrace(traceId: string, params?: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.get<unknown>(`organizations/${seg(ORG_SLUG)}/trace/${seg(traceId)}/`, params);
    } catch (error) {
      if (!(error instanceof AxiosError) || error.response?.status !== 404) throw error;
      return this.get<unknown>(`organizations/${seg(ORG_SLUG)}/events-trace/${seg(traceId)}/`, params);
    }
  }

  /** Grouping (fingerprint) breakdown for one event. There is no issue-level equivalent. */
  async getGroupingInfo(projectSlug: string, eventId: string): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>(
      `projects/${seg(ORG_SLUG)}/${seg(projectSlug)}/events/${seg(eventId)}/grouping-info/`
    );
  }

  /**
   * Merge issues. Sentry merges through the bulk-mutate endpoint with `{merge: true}`
   * and picks the surviving parent itself; all issues must belong to one project.
   * Responds with `{merge: {parent, children}}`.
   */
  async mergeIssues(projectSlug: string, issueIds: string[]): Promise<unknown> {
    return this.put(
      `projects/${seg(ORG_SLUG)}/${seg(projectSlug)}/issues/`,
      { merge: true },
      selectorParams({ ids: issueIds })
    );
  }
}

// Singleton instance
export const sentryClient = new SentryApiClient();
