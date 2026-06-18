/**
 * Multi-provider cache invalidation for mutating git-forge commands.
 *
 * Currently re-exports from `../tools/gh-cache-invalidation` which only
 * detects `gh` CLI mutations. Future extensions will add `glab` and
 * `forgejo-cli` tokenizer patterns.
 */

export {
	invalidateGithubCacheForBashCommand,
} from "../tools/gh-cache-invalidation";
