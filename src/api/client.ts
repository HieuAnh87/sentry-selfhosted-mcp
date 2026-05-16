// Sentry API Client — Axios wrapper

import axios, { AxiosError, AxiosResponse } from 'axios';
import { BASE_URL, AUTH_TOKEN, TIMEOUT_MS } from '../config.js';
import type { SentryIssue, SentryEvent, SentryRelease, SentryTeam, SentryTag, SentryActivity, SentryTrace, SentryGroupingConfig, SentryProject } from './types.js';

// Re-export types for convenience
export type {
  SentryIssue,
  SentryEvent,
  SentryRelease,
  SentryTeam,
  SentryTag,
  SentryActivity,
  SentryTrace,
  SentryGroupingConfig,
  SentryProject,
};

export class SentryApiClient {
  private client = axios.create({
    baseURL: `${BASE_URL}/api/0/`,
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    timeout: TIMEOUT_MS,
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
    return this.get<SentryIssue>(`issues/${issueId}/`);
  }

  async listProjectIssues(orgSlug: string, projectSlug: string, params?: Record<string, unknown>): Promise<SentryIssue[]> {
    return this.get<SentryIssue[]>(`projects/${orgSlug}/${projectSlug}/issues/`, params);
  }

  async searchIssues(orgSlug: string, params?: Record<string, unknown>): Promise<SentryIssue[]> {
    return this.post<SentryIssue[]>(`organizations/${orgSlug}/issues/`, {}, params);
  }

  async updateIssue(issueId: string, data: { status?: string }): Promise<SentryIssue> {
    return this.put<SentryIssue>(`issues/${issueId}/`, data);
  }

  async createIssueComment(issueId: string, text: string): Promise<unknown> {
    return this.post(`issues/${issueId}/comments/`, { text });
  }

  async getIssueHashes(issueId: string, params?: Record<string, unknown>): Promise<string[]> {
    return this.get<string[]>(`issues/${issueId}/hashes/`, params);
  }

  async bulkUpdateProjectIssues(orgSlug: string, projectSlug: string, data: Record<string, unknown>): Promise<unknown> {
    return this.put(`projects/${orgSlug}/${projectSlug}/issues/`, data);
  }

  // ============================================================
  // Events
  // ============================================================

  async getEvent(orgSlug: string, projectSlug: string, eventId: string): Promise<SentryEvent> {
    return this.get<SentryEvent>(`projects/${orgSlug}/${projectSlug}/events/${eventId}/`);
  }

  async listIssueEvents(issueId: string, params?: Record<string, unknown>): Promise<SentryEvent[]> {
    return this.get<SentryEvent[]>(`issues/${issueId}/events/`, params);
  }

  async listProjectEvents(orgSlug: string, projectSlug: string, params?: Record<string, unknown>): Promise<SentryEvent[]> {
    return this.get<SentryEvent[]>(`projects/${orgSlug}/${projectSlug}/events/`, params);
  }

  async getLatestEventForIssue(orgSlug: string, issueId: string): Promise<SentryEvent> {
    return this.get<SentryEvent>(`organizations/${orgSlug}/issues/${issueId}/events/latest/`);
  }

  // ============================================================
  // Releases
  // ============================================================

  async listReleases(orgSlug: string, params?: Record<string, unknown>): Promise<SentryRelease[]> {
    return this.get<SentryRelease[]>(`organizations/${orgSlug}/releases/`, params);
  }

  async getRelease(orgSlug: string, version: string): Promise<SentryRelease> {
    // URL-encode the version (may contain special chars)
    const encodedVersion = encodeURIComponent(version);
    return this.get<SentryRelease>(`organizations/${orgSlug}/releases/${encodedVersion}/`);
  }

  // ============================================================
  // Organization
  // ============================================================

  async listProjects(orgSlug: string): Promise<SentryProject[]> {
    return this.get<SentryProject[]>(`organizations/${orgSlug}/projects/`);
  }

  async listTeams(orgSlug: string): Promise<SentryTeam[]> {
    return this.get<SentryTeam[]>(`organizations/${orgSlug}/teams/`);
  }

  // ============================================================
  // Tags & Activity
  // ============================================================

  async getIssueTags(issueId: string): Promise<SentryTag[]> {
    return this.get<SentryTag[]>(`issues/${issueId}/tags/`);
  }

  async getIssueTagValues(issueId: string, tagKey: string, params?: Record<string, unknown>): Promise<SentryTagValue[]> {
    const encodedKey = encodeURIComponent(tagKey);
    return this.get<SentryTagValue[]>(`issues/${issueId}/tags/${encodedKey}/values/`, params);
  }

  async listIssueActivity(issueId: string, params?: Record<string, unknown>): Promise<SentryActivity[]> {
    return this.get<SentryActivity[]>(`issues/${issueId}/activity/`, params);
  }

  // ============================================================
  // Advanced
  // ============================================================

  async getTrace(traceId: string): Promise<SentryTrace> {
    return this.get<SentryTrace>(`traces/${traceId}/`);
  }

  async getGroupingConfig(issueId: string): Promise<SentryGroupingConfig[]> {
    return this.get<SentryGroupingConfig[]>(`issues/${issueId}/grouping-config/`);
  }

  async mergeIssues(issueId: string, targetIds: string[]): Promise<unknown> {
    return this.post(`issues/${issueId}/hashes/`, { targetIds });
  }
}

// Singleton instance
export const sentryClient = new SentryApiClient();

// Re-export SentryTagValue for use in client
export interface SentryTagValue {
  value: string;
  count: number;
  name?: string;
  lastSeen?: string;
  firstSeen?: string;
}
