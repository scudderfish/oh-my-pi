/**
 * Git-provider-aware cache layer.
 *
 * Currently re-exports from `../tools/github-cache` which uses a provider-
 * agnostic SQLite schema `(repo, kind, number, includeComments, authKey)`.
 *
 * When the `provider` column migration lands (schema v4), this module will
 * prepend the provider name to the cache key so different forges with
 * overlapping repo names do not collide. For now, the single-host assumption
 * (one provider per agent session) means the existing cache is sufficient.
 */

export type {
	CacheKind,
	CacheLookupOptions,
	CacheLookupResult,
	CacheStatus,
	CacheTtl,
	CachedView,
} from "../tools/github-cache";

export {
	clearAll,
	formatFreshnessNote,
	getCached,
	getOrFetchView,
	invalidate,
	invalidateAllForNumber,
	invalidateAllForRepo,
	openDb,
	putCached,
	resetForTests,
	resolveCacheTtl,
	resolveGithubCacheAuthKey,
} from "../tools/github-cache";
