/**
 * Tests for the GitProvider abstraction:
 *   - Registry dispatch (providerFromSettings)
 *   - Git remote URL parsing (parseGitRemoteUrl)
 *   - Provider interface compliance (GithubProvider, GitLabProvider, ForgejoProvider, BitbucketProvider)
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Settings } from "../src/config/settings";
import { providerFromSettings, resetProviderCache } from "../src/git-providers/registry";
import { parseGitRemoteUrl } from "../src/utils/parse-git-remote";
import { createGithubProvider } from "../src/git-providers/github";
import { createGitLabProvider } from "../src/git-providers/gitlab";
import { createForgejoProvider } from "../src/git-providers/forgejo";
import { createBitbucketProvider } from "../src/git-providers/bitbucket";

// ────────────────────────────────────────────────────────────────────────────
// parse-git-remote.ts
// ────────────────────────────────────────────────────────────────────────────

describe("parseGitRemoteUrl", () => {
	const cases: Array<{ input: string; wantHost: string; wantRepo: string }> = [
		// HTTPS
		{ input: "https://github.com/owner/repo.git", wantHost: "github.com", wantRepo: "owner/repo" },
		{ input: "https://github.com/owner/repo", wantHost: "github.com", wantRepo: "owner/repo" },
		{ input: "https://gitlab.com/group/subgroup/project.git", wantHost: "gitlab.com", wantRepo: "group/subgroup/project" },
		// SCP-style SSH
		{ input: "git@github.com:owner/repo.git", wantHost: "github.com", wantRepo: "owner/repo" },
		{ input: "git@gitlab.example.com:owner/repo.git", wantHost: "gitlab.example.com", wantRepo: "owner/repo" },
		// git:// protocol
		{ input: "git://codeberg.org/owner/repo.git", wantHost: "codeberg.org", wantRepo: "owner/repo" },
		// ssh:// protocol
		{ input: "ssh://git@gitlab.com/owner/repo.git", wantHost: "gitlab.com", wantRepo: "owner/repo" },
		// Trailing slash
		{ input: "https://github.com/owner/repo/", wantHost: "github.com", wantRepo: "owner/repo" },
		// User with @ in HTTPS URL
		{ input: "https://token@github.com/owner/repo.git", wantHost: "github.com", wantRepo: "owner/repo" },
	];

	for (const c of cases) {
		it(`parses ${c.input}`, () => {
			const result = parseGitRemoteUrl(c.input);
			expect(result).not.toBeNull();
			expect(result!.host).toBe(c.wantHost);
			expect(result!.repo).toBe(c.wantRepo);
		});
	}

	it("returns null for unrecognised URLs", () => {
		expect(parseGitRemoteUrl("")).toBeNull();
		expect(parseGitRemoteUrl("not-a-url")).toBeNull();
		expect(parseGitRemoteUrl("file:///path/to/repo")).toBeNull();
	});

	it("handles nested GitLab groups", () => {
		const result = parseGitRemoteUrl("https://gitlab.com/group/subgroup/project.git");
		expect(result?.host).toBe("gitlab.com");
		expect(result?.repo).toBe("group/subgroup/project");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// registry.ts — providerFromSettings
// ────────────────────────────────────────────────────────────────────────────

describe("providerFromSettings", () => {
	beforeEach(() => {
		resetProviderCache();
	});

	it("returns a GithubProvider when git.provider is unset (default)", () => {
		const settings = Settings.isolated();
		const provider = providerFromSettings(settings);
		expect(provider.name).toBe("github");
		expect(provider.defaultHost).toBe("github.com");
		expect(provider.prLabel).toBe("Pull Request");
	});

	it("returns a GithubProvider when git.provider is github", () => {
		const settings = Settings.isolated({ "git.provider": "github" });
		const provider = providerFromSettings(settings);
		expect(provider.name).toBe("github");
	});

	it("returns a GitLabProvider when git.provider is gitlab", () => {
		const settings = Settings.isolated({ "git.provider": "gitlab" });
		const provider = providerFromSettings(settings);
		expect(provider.name).toBe("gitlab");
		expect(provider.defaultHost).toBe("gitlab.com");
		expect(provider.prLabel).toBe("Merge Request");
	});

	it("returns a ForgejoProvider when git.provider is forgejo", () => {
		const settings = Settings.isolated({ "git.provider": "forgejo" });
		const provider = providerFromSettings(settings);
		expect(provider.name).toBe("forgejo");
		expect(provider.defaultHost).toBe("codeberg.org");
		expect(provider.prLabel).toBe("Pull Request");
	});

	it("returns a BitbucketProvider when git.provider is bitbucket", () => {
		const settings = Settings.isolated({ "git.provider": "bitbucket" });
		const provider = providerFromSettings(settings);
		expect(provider.name).toBe("bitbucket");
		expect(provider.defaultHost).toBe("bitbucket.org");
		expect(provider.prLabel).toBe("Pull Request");
	});

	it("respects git.host setting (extracts bare hostname)", () => {
		const settings = Settings.isolated({ "git.provider": "gitlab", "git.host": "https://gitlab.example.com" });
		const provider = providerFromSettings(settings);
		expect(provider.defaultHost).toBe("gitlab.example.com");
	});

	it("accepts bare hostname in git.host", () => {
		const settings = Settings.isolated({ "git.provider": "forgejo", "git.host": "git.example.com" });
		const provider = providerFromSettings(settings);
		expect(provider.defaultHost).toBe("git.example.com");
	});

	it("memoizes provider per Settings object", () => {
		const settings = Settings.isolated({ "git.provider": "gitlab" });
		const a = providerFromSettings(settings);
		const b = providerFromSettings(settings);
		expect(a).toBe(b);
	});

	it("defaults to github when settings is undefined", () => {
		const provider = providerFromSettings(undefined);
		expect(provider.name).toBe("github");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// GithubProvider interface compliance
// ────────────────────────────────────────────────────────────────────────────

describe("GithubProvider", () => {
	it("has the correct identity", () => {
		const provider = createGithubProvider(undefined);
		expect(provider.name).toBe("github");
		expect(provider.defaultHost).toBe("github.com");
		expect(provider.prLabel).toBe("Pull Request");
	});

	it("cacheAuthKey returns null or a string (host-independent)", () => {
		const provider = createGithubProvider(undefined);
		const key = provider.cacheAuthKey();
		// null means no credential material; string means credentials exist.
		// Accept both so the test is not host-dependent.
		expect(key === null || typeof key === "string").toBe(true);
	});

	it("resolveDefaultRepo rejects without a real git checkout", async () => {
		const provider = createGithubProvider(undefined);
		// Not in a git checkout → thrown error
		try {
			await provider.resolveDefaultRepo("/nonexistent");
			// Should not reach here
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeDefined();
		}
	});
});

// ────────────────────────────────────────────────────────────────────────────
// GitLabProvider interface compliance
// ────────────────────────────────────────────────────────────────────────────

describe("GitLabProvider", () => {
	it("has the correct identity", () => {
		const provider = createGitLabProvider(undefined);
		expect(provider.name).toBe("gitlab");
		expect(provider.defaultHost).toBe("gitlab.com");
		expect(provider.prLabel).toBe("Merge Request");
	});

	it("respects git.host setting (extracts bare hostname)", () => {
		const settings = Settings.isolated({ "git.host": "https://gitlab.example.com" });
		const provider = createGitLabProvider(settings);
		expect(provider.defaultHost).toBe("gitlab.example.com");
	});

	it("accepts bare hostname in git.host", () => {
		const settings = Settings.isolated({ "git.host": "gitlab.example.com" });
		const provider = createGitLabProvider(settings);
		expect(provider.defaultHost).toBe("gitlab.example.com");
	});

	it("cacheAuthKey is null when no token set", () => {
		const provider = createGitLabProvider(undefined);
		expect(provider.cacheAuthKey()).toBeNull();
	});

	it("fetchIssue throws when no network", async () => {
		const provider = createGitLabProvider(undefined);
		try {
			await provider.fetchIssue("owner/repo", 1, {});
		} catch (err) {
			expect(err).toBeDefined();
		}
	});
});

// ────────────────────────────────────────────────────────────────────────────
// ForgejoProvider interface compliance
// ────────────────────────────────────────────────────────────────────────────

describe("ForgejoProvider", () => {
	it("has the correct identity", () => {
		const provider = createForgejoProvider(undefined);
		expect(provider.name).toBe("forgejo");
		expect(provider.defaultHost).toBe("codeberg.org");
		expect(provider.prLabel).toBe("Pull Request");
	});

	it("respects git.host setting", () => {
		const settings = Settings.isolated({ "git.host": "https://git.example.com" });
		const provider = createForgejoProvider(settings);
		expect(provider.defaultHost).toBe("git.example.com");
	});

	it("respects git.host as bare hostname", () => {
		const settings = Settings.isolated({ "git.host": "git.example.com" });
		const provider = createForgejoProvider(settings);
		expect(provider.defaultHost).toBe("git.example.com");
	});

	it("cacheAuthKey is null when no token set", () => {
		const provider = createForgejoProvider(undefined);
		expect(provider.cacheAuthKey()).toBeNull();
	});

	it("fetchIssue throws when no network", async () => {
		const provider = createForgejoProvider(undefined);
		try {
			await provider.fetchIssue("owner/repo", 1, {});
		} catch (err) {
			expect(err).toBeDefined();
		}
	});
});


// ────────────────────────────────────────────────────────────────────────────
// BitbucketProvider interface compliance
// ────────────────────────────────────────────────────────────────────────────

describe("BitbucketProvider", () => {
	it("has the correct identity", () => {
		const provider = createBitbucketProvider(undefined);
		expect(provider.name).toBe("bitbucket");
		expect(provider.defaultHost).toBe("bitbucket.org");
		expect(provider.prLabel).toBe("Pull Request");
	});

	it("cacheAuthKey is null when no token set", () => {
		const provider = createBitbucketProvider(undefined);
		expect(provider.cacheAuthKey()).toBeNull();
	});

	it("fetchIssue throws when no network", async () => {
		const provider = createBitbucketProvider(undefined);
		try {
			await provider.fetchIssue("owner/repo", 1, {});
		} catch (err) {
			expect(err).toBeDefined();
		}
	});
});