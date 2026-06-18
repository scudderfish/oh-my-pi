/**
 * Git provider registry — resolves a `GitProvider` from settings.
 *
 * Memoized by settings identity (the settings object's in-memory reference
 * is stable for a session, so we cache the provider instance on first access).
 *
 * Usage:
 *   const provider = providerFromSettings(settings);
 *   const repo = await provider.resolveDefaultRepo(cwd);
 *   const issue = await provider.fetchIssue(repo, 42, { signal });
 */

import type { Settings } from "../config/settings";
import { createGithubProvider } from "./github";
import { createGitLabProvider } from "./gitlab";
import { createForgejoProvider } from "./forgejo";
import { createBitbucketProvider } from "./bitbucket";
import type { GitProvider, ProviderName } from "./provider";

// ────────────────────────────────────────────────────────────────────────────
// Lazy provider registry
// ────────────────────────────────────────────────────────────────────────────

const providerCache = new WeakMap<Settings, GitProvider>();

/**
 * Resolve the active `GitProvider` from settings.
 *
 * Returns a memoized instance per `Settings` object. The provider is
 * determined by the `git.provider` setting (default: `"github"`).
 *
 * @throws If the provider name is unknown.
 */
export function providerFromSettings(settings: Settings | undefined): GitProvider {
	if (!settings) {
		return createProvider("github", undefined);
	}

	const cached = providerCache.get(settings);
	if (cached) return cached;

	const name: ProviderName = settings.get("git.provider") ?? "github";
	const provider = createProvider(name, settings);
	providerCache.set(settings, provider);
	return provider;
}

/** Reset the provider cache (test support). */
export function resetProviderCache(): void {
	// WeakMap is not iterable; individual tests should use Settings.isolated()
	// which creates a fresh object, naturally avoiding the memo.
}

// Provider construction — always creates fresh instances because each
// Settings object may carry different git.host / git.token values.
// Memoization is handled by the WeakMap<Settings, GitProvider> above.

function createProvider(name: ProviderName, settings: Settings | undefined): GitProvider {
	switch (name) {
		case "github":
			return createGithubProvider(settings);
		case "gitlab":
			return createGitLabProvider(settings);
		case "forgejo":
			return createForgejoProvider(settings);
		case "bitbucket":
			return createBitbucketProvider(settings);
		default: {
			const _exhaustive: never = name;
			throw new Error(`Unknown git provider: ${_exhaustive}`);
		}
	}
}
