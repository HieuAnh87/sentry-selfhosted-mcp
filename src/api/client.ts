// Sentry API Client — Axios wrapper

import axios, { AxiosError, AxiosResponse } from 'axios';
import { BASE_URL, AUTH_TOKEN, TIMEOUT_MS } from '../config.js';
import type { SentryIssue, SentryIssueHash, SentryEvent, SentryRelease, SentryTeam, SentryTag, SentryTagValue, SentryActivity, SentryTrace, SentryGroupingConfig, SentryProject } from './types.js';

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
  SentryTrace,
  SentryGroupingConfig,
  SentryProject,
};

/** Percent-encode a value before interpolating it into an API path segment. */
function seg(value: string): string {
  return encodeURIComponent(value);
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
    // Surface non-JSON bodies (proxy/SSO HTML pages, truncated responses) as errors
    // instead of silently handing the raw string back as if it were an issue.
    // Both settings are required: axios only parses strictly when responseType is 'json'.
    responseType: 'json',
    transitional: { silentJSONParsing: false },
  });

  constructor() {
    // Log all errors for debugging
    this.client.interceptors.response.use(
      (response: AxiosResponse) => response,
      (error: AxiosError) => {
        const url = error.config?.url || 'unknown';
        console.error(`[Sentry API Error] ${url}:`, error.message);
        return Promise.reject(error);
      }
    );
  }

  // Generic HTTP methods
  async get<T>(endpoint: string, params?: Record<string, unknown>): Promise<T> {
    const response = await this.client.get<T>(endpoint, { params });
    return response.data;
  }

  async post<T>(endpoint: string, data?: unknown, params?: Record<string, unknown>): Promise<T> {
    const response = await this.client.post<T>(endpoint, data ?? {}, { params });
    return response.data;
  }

  async put<T>(endpoint: string, data?: unknown): Promise<T> {
    const response = await this.client.put<T>(endpoint, data ?? {});
    return response.data;
  }

  async delete<T>(endpoint: string): Promise<T> {
    const response = await this.client.delete<T>(endpoint);
    return response.data;
  }

  // ============================================================
  // Issues
  // ============================================================

  async getIssue(issueId: string): Promise<SentryIssue> {
    return this.get<SentryIssue>(`issues/${seg(issueId)}/`);
  }

  async listProjectIssues(orgSlug: string, projectSlug: string, params?: Record<string, unknown>): Promise<SentryIssue[]> {
    return this.get<SentryIssue[]>(`projects/${seg(orgSlug)}/${seg(projectSlug)}/issues/`, params);
  }

  async searchIssues(orgSlug: string, params?: Record<string, unknown>): Promise<SentryIssue[]> {
    // Listing an organization's issues is a GET (PUT mutates, DELETE removes).
    return this.get<SentryIssue[]>(`organizations/${seg(orgSlug)}/issues/`, params);
  }

  async updateIssue(issueId: string, data: { status?: string }): Promise<SentryIssue> {
    return this.put<SentryIssue>(`issues/${seg(issueId)}/`, data);
  }

  async createIssueComment(issueId: string, text: string): Promise<unknown> {
    return this.post(`issues/${seg(issueId)}/comments/`, { text });
  }

  async getIssueHashes(issueId: string, params?: Record<string, unknown>): Promise<SentryIssueHash[]> {
    return this.get<SentryIssueHash[]>(`issues/${seg(issueId)}/hashes/`, params);
  }

  async bulkUpdateProjectIssues(orgSlug: string, projectSlug: string, data: Record<string, unknown>): Promise<unknown> {
    return this.put(`projects/${seg(orgSlug)}/${seg(projectSlug)}/issues/`, data);
  }

  // ============================================================
  // Events
  // ============================================================

  async getEvent(orgSlug: string, projectSlug: string, eventId: string): Promise<SentryEvent> {
    return this.get<SentryEvent>(`projects/${seg(orgSlug)}/${seg(projectSlug)}/events/${seg(eventId)}/`);
  }

  async listIssueEvents(issueId: string, params?: Record<string, unknown>): Promise<SentryEvent[]> {
    return this.get<SentryEvent[]>(`issues/${seg(issueId)}/events/`, params);
  }

  async listProjectEvents(orgSlug: string, projectSlug: string, params?: Record<string, unknown>): Promise<SentryEvent[]> {
    return this.get<SentryEvent[]>(`projects/${seg(orgSlug)}/${seg(projectSlug)}/events/`, params);
  }

  async getLatestEventForIssue(orgSlug: string, issueId: string): Promise<SentryEvent> {
    return this.get<SentryEvent>(`organizations/${seg(orgSlug)}/issues/${seg(issueId)}/events/latest/`);
  }

  // ============================================================
  // Releases
  // ============================================================

  async listReleases(orgSlug: string, params?: Record<string, unknown>): Promise<SentryRelease[]> {
    return this.get<SentryRelease[]>(`organizations/${seg(orgSlug)}/releases/`, params);
  }

  async getRelease(orgSlug: string, version: string): Promise<SentryRelease> {
    return this.get<SentryRelease>(`organizations/${seg(orgSlug)}/releases/${seg(version)}/`);
  }

  // ============================================================
  // Organization
  // ============================================================

  async listProjects(orgSlug: string): Promise<SentryProject[]> {
    return this.get<SentryProject[]>(`organizations/${seg(orgSlug)}/projects/`);
  }

  async listTeams(orgSlug: string): Promise<SentryTeam[]> {
    return this.get<SentryTeam[]>(`organizations/${seg(orgSlug)}/teams/`);
  }

  // ============================================================
  // Tags & Activity
  // ============================================================

  async getIssueTags(issueId: string): Promise<SentryTag[]> {
    return this.get<SentryTag[]>(`issues/${seg(issueId)}/tags/`);
  }

  async getIssueTagValues(issueId: string, tagKey: string, params?: Record<string, unknown>): Promise<SentryTagValue[]> {
    return this.get<SentryTagValue[]>(`issues/${seg(issueId)}/tags/${seg(tagKey)}/values/`, params);
  }

  async listIssueActivity(issueId: string, params?: Record<string, unknown>): Promise<SentryActivity[]> {
    return this.get<SentryActivity[]>(`issues/${seg(issueId)}/activity/`, params);
  }

  // ============================================================
  // Advanced
  // ============================================================

  async getTrace(traceId: string): Promise<SentryTrace> {
    return this.get<SentryTrace>(`traces/${seg(traceId)}/`);
  }

  async getGroupingConfig(issueId: string): Promise<SentryGroupingConfig[]> {
    return this.get<SentryGroupingConfig[]>(`issues/${seg(issueId)}/grouping-config/`);
  }

  async mergeIssues(issueId: string, targetIds: string[]): Promise<unknown> {
    return this.post(`issues/${seg(issueId)}/hashes/`, { targetIds });
  }
}

// Singleton instance
export const sentryClient = new SentryApiClient();
