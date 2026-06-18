/**
 * Forgejo provider — REST API primary, no CLI fallback.
 *
 * Forgejo (and Gitea) use a clean REST API that closely mirrors GitHub's:
 *
 *   GET /api/v1/repos/{owner}/{repo}/issues/{id}
 *   GET /api/v1/repos/{owner}/{repo}/issues?state=...
 *   GET /api/v1/repos/{owner}/{repo}/pulls/{id}
 *   GET /api/v1/repos/{owner}/{repo}/pulls?state=...
 *   GET /api/v1/repos/{owner}/{repo}/pulls/{id}.diff  (raw unified diff)
 *
 * Unlike GitLab, the API path uses literal `owner/repo` — no project ID
 * encoding needed.
 *
 * Auth: `Authorization: token <value>` header (from `git.token` or `FORGEJO_TOKEN` env).
 *
 * CLI fallback (`forgejo-cli`) is not implemented — it's rarely installed.
 * If needed, add `forgejo-cli` support via the same pattern as the GitHub
 * provider.
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

function baseUrl(apiEndpoint: string): string {
	return `${apiEndpoint}/api/v1`;
}

function authToken(settings: Settings | undefined): string | undefined {
	return settings?.get("git.token") ?? process.env.FORGEJO_TOKEN ?? process.env.GITEA_TOKEN;
}

function authHeaders(token: string | undefined): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: "application/json",
	};
	if (token) headers.Authorization = `token ${token}`;
	return headers;
}

async function apiGet<T>(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<T> {
	const response = await fetch(url, { headers, signal });
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Forgejo API error ${response.status}: ${body.slice(0, 200)}`);
	}
	return (await response.json()) as T;
}

async function apiGetText(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<string> {
	const response = await fetch(url, { headers, signal });
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Forgejo API error ${response.status}: ${body.slice(0, 200)}`);
	}
	return response.text();
}

// ────────────────────────────────────────────────────────────────────────────
// Forgejo API response types
// ────────────────────────────────────────────────────────────────────────────

interface FgRepo {
	full_name: string;
}

interface FgUser {
	login: string;
	full_name?: string;
}

interface FgLabel {
	name: string;
}

interface FgMilestone {
	title: string;
}

interface FgIssue {
	id: number;
	number: number;
	title: string;
	state: string;
	body?: string;
	user?: FgUser;
	labels?: FgLabel[];
	milestone?: FgMilestone | null;
	assignees?: FgUser[];
	created_at: string;
	updated_at: string;
	html_url?: string;
	pull_request?: unknown | null;
}

interface FgPullRequest {
	id: number;
	number: number;
	title: string;
	state: string;
	body?: string;
	user?: FgUser;
	labels?: FgLabel[];
	milestone?: FgMilestone | null;
	assignees?: FgUser[];
	created_at: string;
	updated_at: string;
	html_url?: string;
	base?: { ref: string; repo?: FgRepo };
	head?: { ref: string; repo?: FgRepo };
	draft?: boolean;
	mergeable?: boolean;
	merged?: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// Rendering helpers
// ────────────────────────────────────────────────────────────────────────────

function renderIssueMarkdown(issue: FgIssue, number: number, repo: string): string {
	const author = issue.user?.login ?? "?";
	let md = `# Issue #${issue.number}: ${issue.title}\n\n`;
	md += `**State:** ${issue.state.toUpperCase()} · **Author:** @${author}\n`;
	md += `**Created:** ${issue.created_at} · **Updated:** ${issue.updated_at}\n`;

	if (issue.labels && issue.labels.length > 0) {
		md += `**Labels:** ${issue.labels.map(l => l.name).join(", ")}\n`;
	}

	if (issue.milestone) {
		md += `**Milestone:** ${issue.milestone.title}\n`;
	}

	md += `\n---\n\n## Description\n\n`;
	md += issue.body ?? "*No description*";

	if (issue.html_url) {
		md += `\n\n---\n[View on Forgejo](${issue.html_url})`;
	}
	return md;
}

function renderPrMarkdown(pr: FgPullRequest, number: number, repo: string): string {
	const author = pr.user?.login ?? "?";
	const state = pr.merged ? "MERGED" : pr.state.toUpperCase();
	let md = `# PR #${pr.number}: ${pr.title}\n\n`;
	if (pr.draft) md += `**[DRAFT]** `;
	md += `**State:** ${state} · **Author:** @${author}\n`;
	md += `**Branch:** ${pr.head?.ref ?? "?"} → ${pr.base?.ref ?? "?"}\n`;
	md += `**Created:** ${pr.created_at} · **Updated:** ${pr.updated_at}\n`;

	if (pr.labels && pr.labels.length > 0) {
		md += `**Labels:** ${pr.labels.map(l => l.name).join(", ")}\n`;
	}

	if (pr.milestone) {
		md += `**Milestone:** ${pr.milestone.title}\n`;
	}

	md += `\n---\n\n## Description\n\n`;
	md += pr.body ?? "*No description*";

	if (pr.html_url) {
		md += `\n\n---\n[View on Forgejo](${pr.html_url})`;
	}
	return md;
}

// ────────────────────────────────────────────────────────────────────────────
// Unified diff parser
//
// Forgejo's /pulls/{id}.diff endpoint returns a standard unified diff.
// We reuse the same parseUnifiedDiff helper from gitlab.ts.
// ────────────────────────────────────────────────────────────────────────────

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

// ────────────────────────────────────────────────────────────────────────────
// Provider implementation
// ────────────────────────────────────────────────────────────────────────────

export function createForgejoProvider(settings: Settings | undefined): GitProvider {
	const raw = settings?.get("git.host") || "";
	const { url: apiEndpoint, hostname } = normalizeGitHost(raw, "codeberg.org");
	const base = baseUrl(apiEndpoint);
	const headers = authHeaders(authToken(settings));

	return {
		name: "forgejo" as ProviderName,
		defaultHost: hostname,
		prLabel: "Pull Request",

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
			const url = `${base}/repos/${repo}/issues/${number}`;
			const data = await apiGet<FgIssue>(url, headers, opts.signal);
			const rendered = renderIssueMarkdown(data, number, repo);
			const fetchedAt = Date.now();
			return {
				rendered,
				sourceUrl: data.html_url,
				payload: {
					number: data.number,
					title: data.title,
					state: data.state,
					author: data.user?.login,
					body: data.body,
					labels: data.labels?.map(l => l.name),
					createdAt: data.created_at,
					updatedAt: data.updated_at,
					url: data.html_url,
					rendered,
					sourceUrl: data.html_url,
				},
				status: "miss",
				fetchedAt,
			};
		},

		async listIssues(repo: string, opts: ListOptions): Promise<IssueListItem[]> {
			const fgState = opts.state === "merged" ? "all" : opts.state;
			const url = `${base}/repos/${repo}/issues?state=${fgState}&limit=${opts.limit}&type=issues`;
			const items = await apiGet<FgIssue[]>(url, headers, opts.signal);
			return items.map(i => ({
				number: i.number,
				title: i.title,
				state: i.state,
				author: i.user?.login,
				labels: i.labels?.map(l => l.name),
				createdAt: i.created_at,
				updatedAt: i.updated_at,
				url: i.html_url,
			}));
		},

		async fetchPr(repo: string, number: number, opts: FetchOptions): Promise<PrFetchResult> {
			const url = `${base}/repos/${repo}/pulls/${number}`;
			const data = await apiGet<FgPullRequest>(url, headers, opts.signal);
			const rendered = renderPrMarkdown(data, number, repo);
			const fetchedAt = Date.now();
			return {
				rendered,
				sourceUrl: data.html_url,
				payload: {
					number: data.number,
					title: data.title,
					state: data.merged ? "merged" : data.state,
					author: data.user?.login,
					body: data.body,
					labels: data.labels?.map(l => l.name),
					createdAt: data.created_at,
					updatedAt: data.updated_at,
					url: data.html_url,
					isDraft: data.draft ?? false,
					baseRefName: data.base?.ref,
					headRefName: data.head?.ref,
					rendered,
					sourceUrl: data.html_url,
				},
				status: "miss",
				fetchedAt,
			};
		},

		async listPrs(repo: string, opts: ListOptions): Promise<PrListItem[]> {
			const fgState = opts.state === "merged" ? "all" : opts.state;
			const url = `${base}/repos/${repo}/pulls?state=${fgState}&limit=${opts.limit}`;
			const items = await apiGet<FgPullRequest[]>(url, headers, opts.signal);
			return items.map(pr => ({
				number: pr.number,
				title: pr.title,
				state: pr.merged ? "merged" : pr.state,
				author: pr.user?.login,
				labels: pr.labels?.map(l => l.name),
				createdAt: pr.created_at,
				updatedAt: pr.updated_at,
				url: pr.html_url,
				isDraft: pr.draft ?? false,
				baseRefName: pr.base?.ref,
				headRefName: pr.head?.ref,
			}));
		},

		async fetchPrDiff(repo: string, number: number, signal?: AbortSignal): Promise<PrDiffFetchResult> {
			const diffUrl = `${base}/repos/${repo}/pulls/${number}.diff`;
			const text = await apiGetText(diffUrl, { Accept: "text/plain", ...headers }, signal);
			const parsed = parseUnifiedDiff(text);
			const fetchedAt = Date.now();
			return {
				rendered: text,
				sourceUrl: undefined,
				payload: { unified: text, files: parsed.files },
				status: "miss",
				fetchedAt,
			};
		},

		cacheAuthKey(): string | null {
			const token = authToken(undefined);
			if (token) return `forgejo:${token.length}`;
			return null;
		},
	};
}
