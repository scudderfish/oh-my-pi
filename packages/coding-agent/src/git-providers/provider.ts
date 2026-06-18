/**
 * GitProvider abstraction for `issue://` and `pr://` URL resolution.
 *
 * Each implementation wraps a specific git forge (GitHub, GitLab, Forgejo)
 * behind a uniform interface so the protocol handlers in `internal-urls/` can
 * dispatch based on the configured `git.provider` setting without importing
 * provider-specific modules.
 */

import type { CacheStatus } from "./cache";

// ────────────────────────────────────────────────────────────────────────────
// Shared types
// ────────────────────────────────────────────────────────────────────────────

export type ProviderName = "github" | "gitlab" | "forgejo" | "bitbucket";

export interface FetchOptions {
	signal?: AbortSignal;
	includeComments?: boolean;
}

export interface ListOptions {
	state: "open" | "closed" | "merged" | "all";
	limit: number;
	author?: string;
	label?: string;
	signal?: AbortSignal;
}

// ────────────────────────────────────────────────────────────────────────────
// Issue types
// ────────────────────────────────────────────────────────────────────────────

export interface IssueData {
	number: number;
	title: string;
	state: string;
	stateReason?: string | null;
	author?: string;
	body?: string;
	labels?: string[];
	createdAt?: string;
	updatedAt?: string;
	url?: string;
	// Rendered markdown suitable for the protocol handler
	rendered: string;
	sourceUrl?: string;
}

export interface IssueListItem {
	number?: number;
	title?: string;
	state?: string;
	stateReason?: string | null;
	author?: string;
	labels?: string[];
	createdAt?: string;
	updatedAt?: string;
	url?: string;
}

export interface IssueFetchResult {
	rendered: string;
	sourceUrl: string | undefined;
	payload: IssueData;
	status: CacheStatus;
	fetchedAt: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Pull Request types
// ────────────────────────────────────────────────────────────────────────────

export interface PrData {
	number: number;
	title: string;
	state: string;
	author?: string;
	body?: string;
	labels?: string[];
	createdAt?: string;
	updatedAt?: string;
	url?: string;
	isDraft?: boolean;
	baseRefName?: string;
	headRefName?: string;
	// Rendered markdown suitable for the protocol handler
	rendered: string;
	sourceUrl?: string;
}

export interface PrListItem {
	number?: number;
	title?: string;
	state?: string;
	author?: string;
	labels?: string[];
	createdAt?: string;
	updatedAt?: string;
	url?: string;
	isDraft?: boolean;
	baseRefName?: string;
	headRefName?: string;
}

export interface PrFetchResult {
	rendered: string;
	sourceUrl: string | undefined;
	payload: PrData;
	status: CacheStatus;
	fetchedAt: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Diff types
// ────────────────────────────────────────────────────────────────────────────

export interface PrDiffFile {
	path: string;
	additions: number;
	deletions: number;
	changeType: "modified" | "added" | "deleted" | "renamed" | "binary";
	oldPath?: string;
	/** Byte offset of the section's `diff --git` line in the unified diff. */
	startOffset: number;
	/** Byte offset of the next section (or end-of-text). */
	endOffset: number;
}

export interface PrDiffPayload {
	/** Full unified diff text. */
	unified: string;
	files: PrDiffFile[];
}

export interface PrDiffFetchResult {
	rendered: string;
	sourceUrl: string | undefined;
	payload: PrDiffPayload;
	status: CacheStatus;
	fetchedAt: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Provider interface
// ────────────────────────────────────────────────────────────────────────────

export interface GitProvider {
	/** Stable identifier — matches the `git.provider` setting value. */
	readonly name: ProviderName;

	/** Default hostname for this provider (e.g. "github.com", "gitlab.com", "codeberg.org"). */
	readonly defaultHost: string;

	/**
	 * The label used in rendered output for pull-request-like entities.
	 * GitHub/Forgejo → "Pull Request", GitLab → "Merge Request".
	 */
	readonly prLabel: string;

	/**
	 * Resolve the default `owner/repo` from a working directory.
	 *
	 * Provider implementations parse `git remote get-url origin` and extract
	 * the owner/repo path. This avoids requiring any provider-specific CLI
	 * to be installed just to resolve the current repo.
	 */
	resolveDefaultRepo(cwd: string, signal?: AbortSignal): Promise<string>;

	/**
	 * Fetch and render a single issue.
	 * @param repo — `owner/repo` format
	 * @param number — issue number
	 * @param opts — fetch options
	 */
	fetchIssue(repo: string, number: number, opts: FetchOptions): Promise<IssueFetchResult>;

	/**
	 * List issues for a repo.
	 */
	listIssues(repo: string, opts: ListOptions): Promise<IssueListItem[]>;

	/**
	 * Fetch and render a single pull request / merge request.
	 */
	fetchPr(repo: string, number: number, opts: FetchOptions): Promise<PrFetchResult>;

	/**
	 * List pull requests / merge requests for a repo.
	 */
	listPrs(repo: string, opts: ListOptions): Promise<PrListItem[]>;

	/**
	 * Fetch and parse a pull request diff.
	 *
	 * Returns both the verbatim unified diff text and a parsed file index
	 * so callers can produce file listings, full-diff views, and per-file
	 * slices from a single fetch.
	 */
	fetchPrDiff(repo: string, number: number, signal?: AbortSignal): Promise<PrDiffFetchResult>;

	/**
	 * Best-effort credential fingerprint for cache keying.
	 *
	 * Returns a stable opaque string when credential material (tokens, config
	 * files) is visible, or `null` when no credentials are configured. When
	 * `null`, the cache layer uses the default key — meaning cached rows
	 * are not separated by credential identity.
	 */
	cacheAuthKey(): string | null;
}
