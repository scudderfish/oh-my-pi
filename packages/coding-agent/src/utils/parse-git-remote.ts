/**
 * Parse `owner/repo` from a git remote URL, handling all common remote URL
 * formats (HTTPS, SSH/scp-style, git://) for any host.
 *
 * This is used for provider-agnostic default-repo resolution so `issue://N`
 * and `pr://N` work without a forge-specific CLI installed.
 */

/**
 * Result of parsing a git remote URL.
 */
export interface GitRemoteInfo {
	/** Remote hostname (lowercase), e.g. "github.com", "gitlab.example.com". */
	host: string;
	/** Repository path in "owner/repo" format (without `.git` suffix). */
	repo: string;
}

/**
 * Parse a git remote URL and extract host + owner/repo.
 *
 * Supports:
 *   https://host/owner/repo[.git]
 *   git@host:owner/repo[.git]          (scp-style SSH)
 *   ssh://git@host/owner/repo[.git]
 *   git://host/owner/repo[.git]
 *
 * Returns null for unrecognised formats.
 */
export function parseGitRemoteUrl(remoteUrl: string): GitRemoteInfo | null {
	const url = remoteUrl.trim();

	// HTTPS / git:// / ssh:// protocol URLs
	// e.g. https://github.com/owner/repo.git
	const protocolMatch = url.match(/^(?:https?|git|ssh):\/\/(?:[^@]+@)?([^/]+)\/(.+)$/);
	if (protocolMatch) {
		const host = protocolMatch[1]!.toLowerCase();
		const path = protocolMatch[2]!.replace(/\.git$/, "").replace(/\/$/, "");
		if (!path.includes("/")) return null;
		return { host, repo: path };
	}

	// scp-style SSH: git@host:owner/repo.git  (no slash before the colon)
	// e.g. git@github.com:owner/repo.git
	const scpMatch = url.match(/^[^@]+@([^:]+):(.+)$/);
	if (scpMatch) {
		const host = scpMatch[1]!.toLowerCase();
		const path = scpMatch[2]!.replace(/\.git$/, "").replace(/\/$/, "");
		if (!path.includes("/")) return null;
		return { host, repo: path };
	}

	return null;
}

/**
 * Default-authoritative hostname for a git provider name.
 * Used to validate that a resolved remote belongs to the expected provider.
 */
export function defaultHostForProvider(provider: string): string {
	switch (provider) {
		case "github":
			return "github.com";
		case "gitlab":
			return "gitlab.com";
		case "forgejo":
			return "codeberg.org";
		case "bitbucket":
			return "bitbucket.org";
		default:
			return "unknown";
	}
}

/**
 * Normalize a `git.host` config value into an API base URL and a bare hostname.
 *
 * Input can be:
 *   - Empty string → returns default host (e.g. "https://codeberg.org", "codeberg.org")
 *   - `"gitlab.com"`          → bare hostname (https:// prepended)
 *   - `"https://git.example.com"` → full URL (used as-is for API, hostname extracted)
 *   - `"http://git.local:3000"`   → with port
 *
 * @param host — the value of the `git.host` setting (or empty string)
 * @param defaultHost — the provider's default hostname (e.g. "codeberg.org")
 * @returns normalized `{ url: string, hostname: string }`
 */
export function normalizeGitHost(host: string, defaultHost: string): { url: string; hostname: string } {
	if (!host) {
		return { url: `https://${defaultHost}`, hostname: defaultHost };
	}

	// If it already has a protocol, extract hostname and use the URL as-is
	if (/^https?:\/\//.test(host)) {
		try {
			const parsed = new URL(host);
			return { url: host.replace(/\/$/, ""), hostname: parsed.hostname.toLowerCase() };
		} catch {
			// Fall through to treat as bare hostname
		}
	}

	// Bare hostname — prepend https://
	return { url: `https://${host}`, hostname: host.toLowerCase() };
}
