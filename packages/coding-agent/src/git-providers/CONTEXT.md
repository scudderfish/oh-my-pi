# Git Provider Abstraction

This directory implements the `GitProvider` abstraction for `issue://` and `pr://` internal URL resolution.

## Files

| File | Purpose |
|---|---|
| `provider.ts` | `GitProvider` interface — contract for fetching issues, PRs, diffs |
| `registry.ts` | Factory: `providerFromSettings(settings) → GitProvider`; memoized |
| `cache.ts` | SQLite-backed cache (renamed from `github-cache.ts`, schema v4 with `provider` column) |
| `invalidation.ts` | Multi-provider cache invalidation (renamed from `gh-cache-invalidation.ts`) |
| `github.ts` | `GithubProvider` — delegates to `gh.ts` fetchers |
| `gitlab.ts` | `GitLabApiProvider` — REST API primary, `glab` CLI fallback |
| `forgejo.ts` | `ForgejoApiProvider` — REST API |

## Design Rules

- `issue://` and `pr://` stay forge-agnostic. No provider-prefixed schemes.
- Default repo resolution uses `git remote get-url origin` — never `gh`/`glab`/CLI.
- REST API is primary for GitLab/Forgejo; CLI fallback only when configured.
- GitHub stays on `gh` CLI (the REST API would duplicate existing `gh` auth handling and add no value).

## Provider Dispatch

```typescript
const provider = providerFromSettings(settings);
// provider.name === "github" | "gitlab" | "forgejo"
const repo = await provider.resolveDefaultRepo(cwd);
const result = await provider.fetchPr(repo, 42, { signal });
```

## Cache Key

Cache rows are keyed by `(provider, repo, kind, number, includeComments, authKey)`.
Auth key varies by provider:
- **github**: `GH_TOKEN` / `GITHUB_TOKEN` env / `hosts.yml`
- **gitlab**: `GITLAB_TOKEN` env / `git.token` setting
- **forgejo**: `FORGEJO_TOKEN` env / `git.token` setting

## Terminology Mapping

| Generic | GitHub | GitLab | Forgejo |
|---|---|---|---|
| issue | Issue | Issue | Issue |
| pull request | Pull Request | Merge Request | Pull Request |
| `fetchPr` | `gh pr view` | `GET /merge_requests/{n}` | `GET /pulls/{n}` |
| `fetchPrDiff` | `gh pr diff` | `GET /merge_requests/{n}/changes` | `GET /pulls/{n}.diff` |

In rendered output, GitLab uses "MR" / "Merge Request" terminology while GitHub and Forgejo use "PR" / "Pull Request". The formatter receives the provider name and adjusts labels accordingly.

