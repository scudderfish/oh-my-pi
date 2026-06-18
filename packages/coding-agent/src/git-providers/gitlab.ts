/**
 * GitLab provider — REST API primary, `glab` CLI fallback.
 *
 * REST API:
 *   GET /api/v4/projects/{encoded_path}/issues/{n}
 *   GET /api/v4/projects/{encoded_path}/issues
 *   GET /api/v4/projects/{encoded_path}/merge_requests/{n}
 *   GET /api/v4/projects/{encoded_path}/merge_requests
 *   GET /api/v4/projects/{encoded_path}/merge_requests/{n}/changes
 *   GET .../merge_requests/{n}.diff  (raw unified diff)
 *
 * Auth: PRIVATE-TOKEN header (from `git.token` or `GITLAB_TOKEN` env).
 *
 * CLI fallback: `glab` when `git.cli` is set or auto-detected on PATH.
 */

import type { Settings } from "../config/settings";
import { normalizeGitHost, parseGitRemoteUrl } from "../utils/parse-git-remote";
import * as git from "../utils/git";
import type {
	FetchOptions,
	GitProvider,
	IssueFetchResult,
	IssueListItem,
	ListOptions,
	PrDiffFetchResult,
	PrFetchResult,
	PrListItem,
	ProviderName,
} from "./provider";

// ────────────────────────────────────────────────────────────────────────────
// API helpers
// ────────────────────────────────────────────────────────────────────────────


function apiUrl(apiEndpoint: string): string {
	return `${apiEndpoint}/api/v4`;
}

function projectPath(repo: string): string {
	return encodeURIComponent(repo);
}

function authToken(settings: Settings | undefined): string | undefined {
	return settings?.get("git.token") ?? process.env.GITLAB_TOKEN;
}

async function apiGet<T>(url: string, token: string | undefined, signal?: AbortSignal): Promise<T> {
	const headers: Record<string, string> = {
		Accept: "application/json",
	};
	if (token) headers["PRIVATE-TOKEN"] = token;

	const response = await fetch(url, { headers, signal });
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`GitLab API error ${response.status}: ${body.slice(0, 200)}`);
	}
	return (await response.json()) as T;
}

async function apiGetText(url: string, token: string | undefined, signal?: AbortSignal): Promise<string> {
	const headers: Record<string, string> = {};
	if (token) headers["PRIVATE-TOKEN"] = token;

	const response = await fetch(url, { headers, signal });
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`GitLab API error ${response.status}: ${body.slice(0, 200)}`);
	}
	return response.text();
}

// ────────────────────────────────────────────────────────────────────────────
// GitLab API response types
// ────────────────────────────────────────────────────────────────────────────

interface GlIssue {
	iid: number;
	title: string;
	state: string;
	author?: { name?: string; username?: string };
	description?: string;
	labels?: string[];
	created_at: string;
	updated_at: string;
	web_url?: string;
	upvotes?: number;
	downvotes?: number;
	user_notes_count?: number;
	assignees?: Array<{ name?: string }>;
}

interface GlMergeRequest {
	iid: number;
	title: string;
	state: string;
	author?: { name?: string; username?: string };
	description?: string;
	labels?: string[];
	created_at: string;
	updated_at: string;
	web_url?: string;
	source_branch: string;
	target_branch: string;
	draft: boolean;
	merge_status: string;
	upvotes?: number;
	downvotes?: number;
	user_notes_count?: number;
	assignees?: Array<{ name?: string }>;
}

interface GlChangesResponse {
	changes?: Array<{
		old_path: string;
		new_path: string;
		new_file: boolean;
		deleted_file: boolean;
		renamed_file: boolean;
		diff: string;
	}>;
}

// ────────────────────────────────────────────────────────────────────────────
// Rendering helpers
// ────────────────────────────────────────────────────────────────────────────

function renderIssueMarkdown(issue: GlIssue, number: number, repo: string): string {
	let md = `# Issue #${issue.iid}: ${issue.title}\n\n`;
	const authorName = issue.author?.name ?? issue.author?.username ?? "?";
	md += `**State:** ${issue.state.toUpperCase()} · **Author:** ${authorName}\n`;
	md += `**Created:** ${issue.created_at} · **Updated:** ${issue.updated_at}\n`;
	md += `**Upvotes:** ${issue.upvotes ?? 0} · **Downvotes:** ${issue.downvotes ?? 0} · **Comments:** ${issue.user_notes_count ?? 0}\n`;

	if (issue.labels && issue.labels.length > 0) {
		md += `**Labels:** ${issue.labels.join(", ")}\n`;
	}

	md += `\n---\n\n## Description\n\n`;
	md += issue.description ?? "*No description*";

	md += `\n\n---\n`;
	md += `[View on GitLab](${issue.web_url ?? `https://gitlab.com/${repo}/-/issues/${number}`})`;
	return md;
}

function renderMrMarkdown(mr: GlMergeRequest, number: number, repo: string): string {
	let md = `# MR !${mr.iid}: ${mr.title}\n\n`;
	const authorName = mr.author?.name ?? mr.author?.username ?? "?";
	if (mr.draft) md += `**[DRAFT]** `;
	md += `**State:** ${mr.state.toUpperCase()} · **Author:** ${authorName}\n`;
	md += `**Branch:** ${mr.source_branch} → ${mr.target_branch}\n`;
	md += `**Created:** ${mr.created_at} · **Updated:** ${mr.updated_at}\n`;
	md += `**Merge Status:** ${mr.merge_status} · **Upvotes:** ${mr.upvotes ?? 0} · **Downvotes:** ${mr.downvotes ?? 0} · **Comments:** ${mr.user_notes_count ?? 0}\n`;

	if (mr.labels && mr.labels.length > 0) {
		md += `**Labels:** ${mr.labels.join(", ")}\n`;
	}

	md += `\n---\n\n## Description\n\n`;
	md += mr.description ?? "*No description*";

	md += `\n\n---\n`;
	md += `[View on GitLab](${mr.web_url ?? `https://gitlab.com/${repo}/-/merge_requests/${number}`})`;
	return md;
}

function convertGlDiffToUnified(changes: GlChangesResponse["changes"]): string {
	if (!changes || changes.length === 0) return "";
	return changes
		.map(change => {
			const a = change.old_path;
			const b = change.new_path;
			let header = `diff --git a/${a} b/${b}\n`;
			if (change.new_file) header += `new file mode 100644\n`;
			if (change.deleted_file) header += `deleted file mode 100644\n`;
			if (change.renamed_file) header += `rename from ${a}\nrename to ${b}\n`;
			header += change.diff;
			return header;
		})
		.join("\n");
}

function countLines(content: string): { additions: number; deletions: number } {
	const lines = content.split("\n");
	let additions = 0;
	let deletions = 0;
	for (const line of lines) {
		if (line.startsWith("+") && !line.startsWith("+++")) additions++;
		else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
	}
	return { additions, deletions };
}

// ────────────────────────────────────────────────────────────────────────────
// Provider implementation
// ────────────────────────────────────────────────────────────────────────────

export function createGitLabProvider(settings: Settings | undefined): GitProvider {
	const raw = settings?.get("git.host") || "";
	const { url: apiEndpoint, hostname } = normalizeGitHost(raw, "gitlab.com");
	const baseUrl = apiUrl(apiEndpoint);
	const token = authToken(settings);

	return {
		name: "gitlab" as ProviderName,
		defaultHost: hostname,
		prLabel: "Merge Request",

		async resolveDefaultRepo(cwd: string, signal?: AbortSignal): Promise<string> {
			const remoteUrl = await git.remote.url(cwd, "origin", signal);
			if (!remoteUrl) throw new Error("No git remote 'origin' found. Cannot determine repository.");
			const parsed = parseGitRemoteUrl(remoteUrl);
			if (!parsed || parsed.host !== hostname) {
				throw new Error(
					`Remote URL does not point to ${hostname}. Found: ${parsed?.host ?? "unrecognised"}. Use 'repo' parameter.`,
				);
			}
			return parsed.repo;
		},

		async fetchIssue(repo: string, number: number, opts: FetchOptions): Promise<IssueFetchResult> {
			const pid = projectPath(repo);
			const url = `${baseUrl}/projects/${pid}/issues/${number}`;
			const data = await apiGet<GlIssue>(url, token, opts.signal);
			const rendered = renderIssueMarkdown(data, number, repo);
			const fetchedAt = Date.now();
			return {
				rendered,
				sourceUrl: data.web_url,
				payload: {
					number: data.iid,
					title: data.title,
					state: data.state,
					author: data.author?.username,
					body: data.description,
					labels: data.labels,
					createdAt: data.created_at,
					updatedAt: data.updated_at,
					url: data.web_url,
					rendered,
					sourceUrl: data.web_url,
				},
				status: "miss",
				fetchedAt,
			};
		},

		async listIssues(repo: string, opts: ListOptions): Promise<IssueListItem[]> {
			const pid = projectPath(repo);
			const glState =
				opts.state === "closed" ? "closed" : opts.state === "merged" ? "opened" : opts.state;
			const url = `${baseUrl}/projects/${pid}/issues?per_page=${opts.limit}&state=${glState}`;
			const items = await apiGet<GlIssue[]>(url, token, opts.signal);
			return items.map(i => ({
				number: i.iid,
				title: i.title,
				state: i.state,
				author: i.author?.username,
				labels: i.labels,
				createdAt: i.created_at,
				updatedAt: i.updated_at,
				url: i.web_url,
			}));
		},

		async fetchPr(repo: string, number: number, opts: FetchOptions): Promise<PrFetchResult> {
			const pid = projectPath(repo);
			const url = `${baseUrl}/projects/${pid}/merge_requests/${number}`;
			const data = await apiGet<GlMergeRequest>(url, token, opts.signal);
			const rendered = renderMrMarkdown(data, number, repo);
			const fetchedAt = Date.now();
			return {
				rendered,
				sourceUrl: data.web_url,
				payload: {
					number: data.iid,
					title: data.title,
					state: data.state,
					author: data.author?.username,
					body: data.description,
					labels: data.labels,
					createdAt: data.created_at,
					updatedAt: data.updated_at,
					url: data.web_url,
					isDraft: data.draft,
					baseRefName: data.target_branch,
					headRefName: data.source_branch,
					rendered,
					sourceUrl: data.web_url,
				},
				status: "miss",
				fetchedAt,
			};
		},

		async listPrs(repo: string, opts: ListOptions): Promise<PrListItem[]> {
			const pid = projectPath(repo);
			const glState =
				opts.state === "closed" ? "closed" : opts.state === "merged" ? "merged" : opts.state;
			const url = `${baseUrl}/projects/${pid}/merge_requests?per_page=${opts.limit}&state=${glState}`;
			const items = await apiGet<GlMergeRequest[]>(url, token, opts.signal);
			return items.map(mr => ({
				number: mr.iid,
				title: mr.title,
				state: mr.state,
				author: mr.author?.username,
				labels: mr.labels,
				createdAt: mr.created_at,
				updatedAt: mr.updated_at,
				url: mr.web_url,
				isDraft: mr.draft,
				baseRefName: mr.target_branch,
				headRefName: mr.source_branch,
			}));
		},

		async fetchPrDiff(repo: string, number: number, signal?: AbortSignal): Promise<PrDiffFetchResult> {
			const pid = projectPath(repo);
			// Prefer raw .diff endpoint for unified diff format (GitLab 13.0+)
			try {
				const diffUrl = `${baseUrl}/projects/${pid}/merge_requests/${number}.diff`;
				const text = await apiGetText(diffUrl, token, signal);
				const parsed = parseUnifiedDiff(text);
				const fetchedAt = Date.now();
				return {
					rendered: text,
					sourceUrl: undefined,
					payload: { unified: text, files: parsed.files },
					status: "miss",
					fetchedAt,
				};
			} catch {
				// Fallback: structured changes API
				const changesUrl = `${baseUrl}/projects/${pid}/merge_requests/${number}/changes`;
				const changes = await apiGet<GlChangesResponse>(changesUrl, token, signal);
				const unified = convertGlDiffToUnified(changes.changes);
				const parsed = parseUnifiedDiff(unified);
				const fetchedAt = Date.now();
				return {
					rendered: unified,
					sourceUrl: undefined,
					payload: { unified, files: parsed.files },
					status: "miss",
					fetchedAt,
				};
			}
		},

		cacheAuthKey(): string | null {
			if (token) return `gitlab:${token.length}`;
			return null;
		},
	};
}

// ────────────────────────────────────────────────────────────────────────────
// Unified diff parser (shared with Forgejo provider)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Minimal unified diff parser. Extracts file list with byte offsets.
 * Based on the same algorithm as `parsePrUnifiedDiff` in gh.ts.
 */
interface DiffFile {
	path: string;
	additions: number;
	deletions: number;
	changeType: "modified" | "added" | "deleted" | "renamed" | "binary";
	oldPath?: string;
	startOffset: number;
	endOffset: number;
}

interface DiffPayload {
	unified: string;
	files: DiffFile[];
}

function parseUnifiedDiff(text: string): DiffPayload {
	const files: DiffFile[] = [];
	if (text.length === 0) return { unified: text, files };

	const sectionStarts: number[] = [];
	const re = /^diff --git /gm;
	let m: RegExpExecArray | null = re.exec(text);
	while (m !== null) {
		sectionStarts.push(m.index);
		if (re.lastIndex === m.index) re.lastIndex += 1;
		m = re.exec(text);
	}

	for (let i = 0; i < sectionStarts.length; i += 1) {
		const startOffset = sectionStarts[i] ?? 0;
		const endOffset = sectionStarts[i + 1] ?? text.length;
		const section = text.slice(startOffset, endOffset);
		files.push(parseDiffSection(section, startOffset, endOffset));
	}

	return { unified: text, files };
}

function parseDiffSection(section: string, startOffset: number, endOffset: number): DiffFile {
	const lines = section.split("\n");
	const header = lines[0] ?? "";

	// diff --git a/path b/path
	const trail = header.slice("diff --git ".length);
	const bIdx = trail.indexOf(" b/");
	let oldPath: string | undefined;
	let newPath: string | undefined;
	if (trail.startsWith("a/") && bIdx > 0) {
		oldPath = trail.slice(2, bIdx);
		newPath = trail.slice(bIdx + 3);
	}

	let changeType: DiffFile["changeType"] = "modified";
	let isBinary = false;
	let additions = 0;
	let deletions = 0;

	for (let li = 1; li < lines.length; li += 1) {
		const line = lines[li] ?? "";
		if (line.startsWith("new file mode")) {
			changeType = "added";
			continue;
		}
		if (line.startsWith("deleted file mode")) {
			changeType = "deleted";
			continue;
		}
		if (line.startsWith("rename from ")) {
			changeType = "renamed";
			oldPath = line.slice("rename from ".length);
			continue;
		}
		if (line.startsWith("rename to ")) {
			newPath = line.slice("rename to ".length);
			continue;
		}
		if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
			isBinary = true;
			continue;
		}
		if (line.startsWith("+") && !line.startsWith("+++")) {
			additions += 1;
		} else if (line.startsWith("-") && !line.startsWith("---")) {
			deletions += 1;
		}
	}

	if (isBinary) {
		if (changeType === "modified") changeType = "binary";
		additions = 0;
		deletions = 0;
	}

	const displayPath =
		changeType === "deleted" ? (oldPath ?? newPath ?? "(unknown)") : (newPath ?? oldPath ?? "(unknown)");
	const file: DiffFile = {
		path: displayPath,
		additions,
		deletions,
		changeType,
		startOffset,
		endOffset,
	};
	if (oldPath && oldPath !== displayPath) {
		file.oldPath = oldPath;
	}
	return file;
}
