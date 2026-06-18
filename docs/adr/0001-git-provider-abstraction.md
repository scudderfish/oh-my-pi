# ADR 0001: Git Provider Abstraction for `issue://` and `pr://`

**Status:** Accepted · **Date:** 2026-06-18 · **Driver:** @agent

## Context

The `issue://` and `pr://` internal URL schemes are hardwired to GitHub via the `gh` CLI:
- `git.github` in `utils/git.ts` spawns `gh` for every operation
- `gh.ts` bundles fetch, cache, and formatting logic
- `github-cache.ts` provides SQLite-backed caching (mostly provider-agnostic schema)
- `gh-cache-invalidation.ts` pattern-matches `gh issue|pr` mutating subcommands

Users working with GitLab, Forgejo, Gitea, or Codeberg cannot use `issue://` / `pr://`. The web scraper at `web/scrapers/gitlab.ts` already knows how to read GitLab issues/MRs via REST API when given a full URL, but this path is not wired into the protocol handlers.

## Decision

Introduce a **`GitProvider` abstraction** under `packages/coding-agent/src/git-providers/`. The `issue://` and `pr://` protocol handlers dispatch to the configured provider at resolution time.

### Key properties

1. **`issue://` and `pr://` remain forge-agnostic.** No provider-prefixed schemes (`gh-issue://`, `gl-issue://`). The same URL shapes work everywhere; one config key (`git.provider`) switches the backend.

2. **Default repo resolution uses git remotes** instead of provider-specific CLI (`gh repo view`). Parse `git remote get-url origin` to extract `owner/repo`. Works for any provider without a CLI installed.

3. **REST API primary, CLI fallback** for GitLab and Forgejo. GitHub stays on `gh` CLI (the REST API would require a different auth model). For GitLab/Forgejo, direct REST API calls are the primary path; the CLI (`glab`/`forgejo-cli`) is only used when explicitly configured or auto-detected.

4. **Shared cache.** The SQLite cache gets a `provider` column. `getOrFetchView<T>` already accepts a generic fetch callback — the provider string just joins the cache key.

5. **Backward compatibility.** Existing `github.cache.*` settings continue working for the `github` provider. Old cache rows without a `provider` column are treated as `github`.

## Architecture

```
git-providers/
  provider.ts         → GitProvider interface
  registry.ts         → factory: providerFromSettings(settings) → GitProvider
  cache.ts            → renamed from github-cache.ts (+ provider column)
  invalidation.ts     → renamed from gh-cache-invalidation.ts (+ multi-CLI matchers)
  github.ts           → GithubProvider (wraps existing gh.ts fetchers)
  gitlab.ts           → GitLabApiProvider (REST + glab fallback)
  forgejo.ts          → ForgejoApiProvider (REST)
```

### GitProvider interface

```typescript
interface GitProvider {
  readonly name: "github" | "gitlab" | "forgejo";
  readonly defaultHost: string;

  resolveDefaultRepo(cwd: string, signal?: AbortSignal): Promise<string>;

  fetchIssue(repo: string, number: number, opts: FetchOptions): Promise<IssuePayload>;
  listIssues(repo: string, opts: ListOptions): Promise<IssueListItem[]>;

  fetchPr(repo: string, number: number, opts: FetchOptions): Promise<PrPayload>;
  listPrs(repo: string, opts: ListOptions): Promise<PrListItem[]>;
  fetchPrDiff(repo: string, number: number): Promise<PrDiffPayload>;

  cacheAuthKey(): string | null;
}
```

### Protocol handler changes

Both `IssueProtocolHandler` and `PrProtocolHandler` already receive `context.settings`. At resolution time they call `providerFromSettings(settings)` to get the active provider, then delegate all fetches to it.

### Settings

New settings under the `git.*` namespace:

| Path | Type | Default | Description |
|---|---|---|---|
| `git.provider` | enum | `"github"` | `"github"`, `"gitlab"`, or `"forgejo"` |
| `git.host` | string | `""` | Self-hosted instance URL (empty = default: `gitlab.com`, `codeberg.org`, etc.) |
| `git.token` | string | `""` | Personal access token (env fallback: `GITLAB_TOKEN`, `FORGEJO_TOKEN`, ...) |
| `git.cli` | string | `""` | CLI binary override (auto-detected when empty) |
| `git.cache.*` | — | inherits from `github.cache.*` | TTL settings (soft+hard), enabled flag |

Existing `github.cache.*` settings remain for backward compat — `GithubProvider` reads them. The new `git.cache.*` takes priority.

## Consequences

- **Positive**: Single config key switches the provider; no duplicate URL schemes.
- **Positive**: Git remote parsing eliminates `gh` dependency for repo detection.
- **Positive**: REST API path for GitLab/Forgejo means no CLI installation required.
- **Positive**: Cache already mostly provider-agnostic; minimal schema migration.
- **Negative**: Provider implementations must map platform-specific JSON responses to a uniform interface (e.g. "Merge Request" vs "Pull Request" terminology).
- **Negative**: The unified diff parser (`parsePrUnifiedDiff`) works for GitHub and Forgejo's raw `.diff` endpoint, but GitLab's `/changes` endpoint returns structured JSON — will need a conversion step.

## Implementation Order

1. Settings schema (`git.provider`, `git.host`, `git.token`, `git.cache.*`)
2. `GitProvider` interface + registry factory
3. `git-cache.ts` — rename from `github-cache.ts`, add `provider` column, bump schema
4. `parseGitRemoteUrl` — extract `owner/repo` from git remote URLs
5. `GithubProvider` — wraps existing `gh.ts` fetchers under the new interface
6. Wire protocol handlers — `issue-pr-protocol.ts` dispatches via provider
7. `git-cache-invalidation.ts` — rename from `gh-cache-invalidation.ts`, add multi-CLI matchers
8. `GitLabProvider` — REST API primary, `glab` fallback
9. `ForgejoProvider` — REST API
10. Tests — provider dispatch, mock API responses
