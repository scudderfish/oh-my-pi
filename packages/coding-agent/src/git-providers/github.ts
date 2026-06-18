/**
 * GitHub provider — wraps the existing `gh` CLI-based fetchers from `../tools/gh.ts`
 * behind the `GitProvider` interface.
 *
 * This is the backward-compatible default provider. All existing `gh`-CLI logic
 * (argument building, JSON field selection, `gh` binary dispatch, formatting,
 * review-comment fetching) is reused; this module just adapts the public API.
 */

import type { Settings } from "../config/settings";
import {
	getOrFetchIssue,
	getOrFetchPr,
	getOrFetchPrDiff,
	githubIssueJsonWithStateReasonFallback,
	resolveDefaultRepoMemoized,
} from "../tools/gh";
import { resolveGithubCacheAuthKey } from "../tools/github-cache";
import * as git from "../utils/git";
import type {
	FetchOptions,
	GitProvider,
	IssueFetchResult,
	IssueListItem,
	ListOptions,
	PrFetchResult,
	PrDiffFetchResult,
	PrListItem,
	ProviderName,
} from "./provider";

// ────────────────────────────────────────────────────────────────────────────
// Provider implementation
// ────────────────────────────────────────────────────────────────────────────

export function createGithubProvider(_settings: Settings | undefined): GitProvider {
	return {
		name: "github" as ProviderName,
		defaultHost: "github.com",
		prLabel: "Pull Request",

		async resolveDefaultRepo(cwd: string, signal?: AbortSignal): Promise<string> {
			return resolveDefaultRepoMemoized(cwd, signal);
		},

		async fetchIssue(repo: string, number: number, opts: FetchOptions): Promise<IssueFetchResult> {
			const result = await getOrFetchIssue({
				cwd: process.cwd(),
				repo,
				issue: String(number),
				includeComments: opts.includeComments,
				signal: opts.signal,
			});
			return {
				rendered: result.rendered,
				sourceUrl: result.sourceUrl,
				payload: {
					number: result.payload.number,
					title: result.payload.title,
					state: result.payload.state,
					stateReason: result.payload.stateReason,
					author: result.payload.author?.login,
					body: result.payload.body,
					labels: result.payload.labels?.map((l: { name?: string }) => l.name ?? ""),
					createdAt: result.payload.createdAt,
					updatedAt: result.payload.updatedAt,
					url: result.payload.url,
					rendered: result.rendered,
					sourceUrl: result.sourceUrl,
				},
				status: result.status,
				fetchedAt: result.fetchedAt,
			};
		},

		async listIssues(repo: string, opts: ListOptions): Promise<IssueListItem[]> {
			const fields = ["number", "title", "state", "author", "labels", "createdAt", "updatedAt", "url"];
			const args = buildListArgs("issue", repo, opts, fields);
			const cwd = process.cwd();
			const items = await githubIssueJsonWithStateReasonFallback<Array<Record<string, unknown>>>(cwd, args, opts.signal, {
				repoProvided: true,
			});
			return items.map(normalizeIssueListItem);
		},

		async fetchPr(repo: string, number: number, opts: FetchOptions): Promise<PrFetchResult> {
			const result = await getOrFetchPr({
				cwd: process.cwd(),
				repo,
				number,
				includeComments: opts.includeComments,
				signal: opts.signal,
			});
			return {
				rendered: result.rendered,
				sourceUrl: result.sourceUrl,
				payload: {
					number: result.payload.number,
					title: result.payload.title,
					state: result.payload.state,
					author: result.payload.author?.login,
					body: result.payload.body,
					labels: result.payload.labels?.map((l: { name?: string }) => l.name ?? ""),
					createdAt: result.payload.createdAt,
					updatedAt: result.payload.updatedAt,
					url: result.payload.url,
					isDraft: result.payload.isDraft,
					baseRefName: result.payload.baseRefName,
					headRefName: result.payload.headRefName,
					rendered: result.rendered,
					sourceUrl: result.sourceUrl,
				},
				status: result.status,
				fetchedAt: result.fetchedAt,
			};
		},

		async listPrs(repo: string, opts: ListOptions): Promise<PrListItem[]> {
			const fields = [
				"number",
				"title",
				"state",
				"isDraft",
				"author",
				"baseRefName",
				"headRefName",
				"labels",
				"createdAt",
				"updatedAt",
				"url",
			];
			const args = buildListArgs("pr", repo, opts, fields);
			const cwd = process.cwd();
			const items = await git.github.json<Array<Record<string, unknown>>>(cwd, args, opts.signal, {
				repoProvided: true,
			});
			return items.map(normalizePrListItem);
		},

		async fetchPrDiff(repo: string, number: number, signal?: AbortSignal): Promise<PrDiffFetchResult> {
			const result = await getOrFetchPrDiff({
				cwd: process.cwd(),
				repo,
				number,
				signal,
			});
			return {
				rendered: result.rendered,
				sourceUrl: result.sourceUrl,
				payload: {
					unified: result.payload.unified,
					files: result.payload.files,
				},
				status: result.status,
				fetchedAt: result.fetchedAt,
			};
		},

		cacheAuthKey(): string | null {
			return resolveGithubCacheAuthKey() ?? null;
		},
	};
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function buildListArgs(
	scheme: "issue" | "pr",
	repo: string,
	opts: ListOptions,
	fields: string[],
): string[] {
	const args = [scheme, "list", "--repo", repo, "--state", opts.state, "--limit", String(opts.limit), "--json", fields.join(",")];
	if (opts.author) args.push("--author", opts.author);
	if (opts.label) args.push("--label", opts.label);
	return args;
}

interface RawGhListItem {
	number?: number;
	title?: string;
	state?: string;
	stateReason?: string | null;
	author?: { login?: string } | null;
	labels?: Array<{ name?: string }>;
	createdAt?: string;
	updatedAt?: string;
	url?: string;
}

function normalizeIssueListItem(item: RawGhListItem): IssueListItem {
	return {
		number: item.number,
		title: item.title,
		state: item.state,
		stateReason: item.stateReason,
		author: item.author?.login,
		labels: item.labels?.map(l => l.name ?? ""),
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
		url: item.url,
	};
}

interface RawGhPrListItem extends RawGhListItem {
	isDraft?: boolean;
	baseRefName?: string;
	headRefName?: string;
}

function normalizePrListItem(item: RawGhPrListItem): PrListItem {
	return {
		number: item.number,
		title: item.title,
		state: item.state,
		author: item.author?.login,
		labels: item.labels?.map(l => l.name ?? ""),
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
		url: item.url,
		isDraft: item.isDraft,
		baseRefName: item.baseRefName,
		headRefName: item.headRefName,
	};
}
