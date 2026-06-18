/**
 * Bitbucket provider — REST API via Bitbucket Cloud API (api.bitbucket.org/2.0).
 *
 * Bitbucket Cloud API:
 *   GET /2.0/repositories/{owner}/{repo}
 *   GET /2.0/repositories/{owner}/{repo}/issues/{id}
 *   GET /2.0/repositories/{owner}/{repo}/issues?q=...
 *   GET /2.0/repositories/{owner}/{repo}/pullrequests/{id}
 *   GET /2.0/repositories/{owner}/{repo}/pullrequests?state=...
 *   GET /2.0/repositories/{owner}/{repo}/pullrequests/{id}/diff  (raw unified diff)
 *
 * Auth: Basic auth (username:app-password) via `git.token` as "username:token",
 * or as `BITBUCKET_USERNAME` / `BITBUCKET_APP_PASSWORD` env vars.
 *
 * Self-hosted Bitbucket Server uses a different API (rest/api/1.0/) — not
 * currently supported. Use `git.host` pointing at a Bitbucket Cloud instance,
 * or open an issue for Bitbucket Server support.
 */

import type { Settings } from "../config/settings";
import { parseGitRemoteUrl } from "../utils/parse-git-remote";
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

const API_BASE = "https://api.bitbucket.org/2.0";

function authCredentials(settings: Settings | undefined): { username: string; password: string } | undefined {
	const raw = settings?.get("git.token") ?? process.env.BITBUCKET_APP_PASSWORD;
	if (!raw) return undefined;

	// format: "username:token" or just the token (username from BITBUCKET_USERNAME)
	if (raw.includes(":")) {
		const [username, ...rest] = raw.split(":");
		return { username: username!, password: rest.join(":") };
	}
	const username = process.env.BITBUCKET_USERNAME;
	if (username) return { username, password: raw };
	return undefined;
}

function authHeader(creds: { username: string; password: string } | undefined): Record<string, string> {
	if (!creds) return {};
	const encoded = Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
	return { Authorization: `Basic ${encoded}` };
}

async function apiGet<T>(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<T> {
	const response = await fetch(url, { headers, signal });
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Bitbucket API error ${response.status}: ${body.slice(0, 200)}`);
	}
	return (await response.json()) as T;
}

async function apiGetText(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<string> {
	const response = await fetch(url, { headers, signal });
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Bitbucket API error ${response.status}: ${body.slice(0, 200)}`);
	}
	return response.text();
}

// ────────────────────────────────────────────────────────────────────────────
// Bitbucket API response types
// ────────────────────────────────────────────────────────────────────────────

interface BbUser {
	display_name?: string;
	nickname?: string;
	account_id?: string;
}

interface BbIssue {
	id: number;
	title: string;
	state: string;
	kind?: string;
	priority?: string;
	content?: { raw?: string; html?: string; markup?: string };
	reporter?: BbUser;
	assignee?: BbUser;
	created_on: string;
	updated_on: string;
	links?: { html?: { href?: string } };
}

interface BbPullRequest {
	id: number;
	title: string;
	state: string;
	description?: string;
	author?: BbUser;
	source?: { branch?: { name?: string }; repository?: { full_name?: string } };
	destination?: { branch?: { name?: string } };
	created_on: string;
	updated_on: string;
	links?: { html?: { href?: string } };
	close_source_branch?: boolean;
	merge_commit?: unknown | null;
	type?: string;
}

interface BbPaginated<T> {
	values: T[];
	size?: number;
	page?: number;
	pagelen?: number;
	next?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Rendering helpers
// ────────────────────────────────────────────────────────────────────────────

function renderIssueMarkdown(issue: BbIssue, number: number, repo: string): string {
	const reporter = issue.reporter?.display_name ?? issue.reporter?.nickname ?? "?";
	let md = `# Issue #${issue.id}: ${issue.title}\n\n`;
	md += `**State:** ${issue.state.toUpperCase()} · **Author:** ${reporter}\n`;
	md += `**Kind:** ${issue.kind ?? "?"} · **Priority:** ${issue.priority ?? "?"}\n`;
	md += `**Created:** ${issue.created_on} · **Updated:** ${issue.updated_on}\n`;

	if (issue.assignee) {
		md += `**Assignee:** ${issue.assignee.display_name ?? issue.assignee.nickname ?? "?"}\n`;
	}

	md += `\n---\n\n## Description\n\n`;
	md += issue.content?.raw ?? "*No description*";

	const issueUrl = issue.links?.html?.href ?? `https://bitbucket.org/${repo}/issues/${number}`;
	md += `\n\n---\n[View on Bitbucket](${issueUrl})`;
	return md;
}

function renderPrMarkdown(pr: BbPullRequest, number: number, repo: string): string {
	const author = pr.author?.display_name ?? pr.author?.nickname ?? "?";
	const state = pr.state.toUpperCase();
	let md = `# PR #${pr.id}: ${pr.title}\n\n`;
	md += `**State:** ${state} · **Author:** ${author}\n`;
	md += `**Branch:** ${pr.source?.branch?.name ?? "?"} → ${pr.destination?.branch?.name ?? "?"}\n`;
	md += `**Created:** ${pr.created_on} · **Updated:** ${pr.updated_on}\n`;

	md += `\n---\n\n## Description\n\n`;
	md += pr.description ?? "*No description*";

	const prUrl = pr.links?.html?.href ?? `https://bitbucket.org/${repo}/pullrequests/${number}`;
	md += `\n\n---\n[View on Bitbucket](${prUrl})`;
	return md;
}

// ────────────────────────────────────────────────────────────────────────────
// Diff parser (same unified diff parser used by gitlab/forgejo)
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

export function createBitbucketProvider(settings: Settings | undefined): GitProvider {
	const creds = authCredentials(settings);
	const headers = {
		Accept: "application/json",
		...authHeader(creds),
	};

	return {
		name: "bitbucket" as ProviderName,
		defaultHost: "bitbucket.org",
		prLabel: "Pull Request",

		async resolveDefaultRepo(cwd: string, signal?: AbortSignal): Promise<string> {
			const remoteUrl = await git.remote.url(cwd, "origin", signal);
			if (!remoteUrl) throw new Error("No git remote 'origin' found. Cannot determine repository.");
			const parsed = parseGitRemoteUrl(remoteUrl);
			if (!parsed || parsed.host !== "bitbucket.org") {
				throw new Error(
					`Remote URL does not point to bitbucket.org. Found: ${parsed?.host ?? "unrecognised"}. Use 'repo' parameter.`,
				);
			}
			return parsed.repo;
		},

		async fetchIssue(repo: string, number: number, opts: FetchOptions): Promise<IssueFetchResult> {
			const url = `${API_BASE}/repositories/${repo}/issues/${number}`;
			const data = await apiGet<BbIssue>(url, headers, opts.signal);
			const rendered = renderIssueMarkdown(data, number, repo);
			const fetchedAt = Date.now();
			return {
				rendered,
				sourceUrl: data.links?.html?.href,
				payload: {
					number: data.id,
					title: data.title,
					state: data.state,
					author: data.reporter?.nickname ?? data.reporter?.display_name,
					body: data.content?.raw,
					createdAt: data.created_on,
					updatedAt: data.updated_on,
					url: data.links?.html?.href,
					rendered,
					sourceUrl: data.links?.html?.href,
				},
				status: "miss",
				fetchedAt,
			};
		},

		async listIssues(repo: string, opts: ListOptions): Promise<IssueListItem[]> {
			const bbState = opts.state === "all" ? "" : opts.state;
			const q = bbState ? `state=${bbState}` : "";
			const url = `${API_BASE}/repositories/${repo}/issues?pagelen=${opts.limit}${q ? `&q=${q}` : ""}`;
			const page = await apiGet<BbPaginated<BbIssue>>(url, headers, opts.signal);
			return (page.values ?? []).map(i => ({
				number: i.id,
				title: i.title,
				state: i.state,
				author: i.reporter?.nickname ?? i.reporter?.display_name,
				createdAt: i.created_on,
				updatedAt: i.updated_on,
				url: i.links?.html?.href,
			}));
		},

		async fetchPr(repo: string, number: number, opts: FetchOptions): Promise<PrFetchResult> {
			const url = `${API_BASE}/repositories/${repo}/pullrequests/${number}`;
			const data = await apiGet<BbPullRequest>(url, headers, opts.signal);
			const rendered = renderPrMarkdown(data, number, repo);
			const fetchedAt = Date.now();
			return {
				rendered,
				sourceUrl: data.links?.html?.href,
				payload: {
					number: data.id,
					title: data.title,
					state: data.state,
					author: data.author?.nickname ?? data.author?.display_name,
					body: data.description,
					createdAt: data.created_on,
					updatedAt: data.updated_on,
					url: data.links?.html?.href,
					isDraft: false,
					baseRefName: data.destination?.branch?.name,
					headRefName: data.source?.branch?.name,
					rendered,
					sourceUrl: data.links?.html?.href,
				},
				status: "miss",
				fetchedAt,
			};
		},

		async listPrs(repo: string, opts: ListOptions): Promise<PrListItem[]> {
			const bbState = opts.state === "all" ? "" : opts.state;
			const q = bbState ? `state=${bbState}` : "";
			const url = `${API_BASE}/repositories/${repo}/pullrequests?pagelen=${opts.limit}${q ? `&q=${q}` : ""}`;
			const page = await apiGet<BbPaginated<BbPullRequest>>(url, headers, opts.signal);
			return (page.values ?? []).map(pr => ({
				number: pr.id,
				title: pr.title,
				state: pr.state,
				author: pr.author?.nickname ?? pr.author?.display_name,
				createdAt: pr.created_on,
				updatedAt: pr.updated_on,
				url: pr.links?.html?.href,
				isDraft: false,
				baseRefName: pr.destination?.branch?.name,
				headRefName: pr.source?.branch?.name,
			}));
		},

		async fetchPrDiff(repo: string, number: number, signal?: AbortSignal): Promise<PrDiffFetchResult> {
			const diffUrl = `${API_BASE}/repositories/${repo}/pullrequests/${number}/diff`;
			const text = await apiGetText(diffUrl, { ...headers, Accept: "text/plain" }, signal);
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
			if (creds) return `bitbucket:${creds.password.length}`;
			return null;
		},
	};
}
