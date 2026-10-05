/**
 * Pure Git branch-name validation.
 *
 * `wsg explain` must read a saved manifest without touching Git (no subprocess,
 * no network), and manifest validation checks every `repos[].branch`. The
 * previous implementation shelled out to `git check-ref-format --branch`, which
 * made "read-only" explain depend on a Git installation being on `PATH`.
 *
 * This module reproduces the exact decision of
 * `git check-ref-format --branch <name>` using pure string rules, so manifest
 * validation (and therefore explain) never spawns a process. The rules mirror
 * `check_refname_format()`/`check_refname_component()` in Git's `refs.c`:
 *
 * - the name is treated as `refs/heads/<name>` unless it is already a
 *   fully-qualified `refs/heads/...` ref;
 * - a name beginning with `-` is rejected by `--branch` (option confusion);
 * - ASCII control characters, space, and `~ ^ : ? * [ \` are forbidden;
 * - DEL (0x7f) is forbidden;
 * - the sequence `@{` is forbidden;
 * - empty path components (leading/trailing/double `/`) are forbidden;
 * - a component may not start with `.` or end with `.lock`;
 * - the whole ref may not end with `.` and may not contain `..`.
 *
 * `test/git.test.ts` cross-checks this against the real Git for a broad corpus,
 * which is what keeps `wsg create`'s pre-flight and `--resume` safety intact.
 *
 * Intentional deviation: `--branch` also expands the "previous branch"
 * shorthand `@{-N}` and reports success, but that is not a literal branch name
 * (`refs/heads/@{-N}` is rejected because `@{` is forbidden). WSG never emits
 * or stores such a value, so this validator rejects it rather than resolving
 * checkout history, which would require a Git repository.
 */

/**
 * Forbidden characters anywhere in a branch name. `\x00-\x20` covers ASCII
 * control characters and space; `\x7f` is DEL; the remainder are Git's
 * reserved punctuation characters.
 */
const FORBIDDEN_BRANCH_CHARS = /[\x00-\x20\x7f~^:?*[\\]/;

/**
 * Returns `true` iff `name` is accepted by `git check-ref-format --branch`.
 * Pure: performs no I/O and spawns no subprocess.
 */
export function checkBranchName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) {
    return false;
  }

  // `--branch` rejects a name that could be parsed as an option. A
  // fully-qualified `refs/heads/-foo` is still accepted because it does not
  // begin with a dash; `check_branch_ref()` only prepends the prefix.
  if (name.startsWith('-')) {
    return false;
  }

  if (FORBIDDEN_BRANCH_CHARS.test(name)) {
    return false;
  }

  if (name.includes('@{')) {
    return false;
  }

  const full = name.startsWith('refs/heads/') ? name : `refs/heads/${name}`;

  // A refname cannot end with a dot or a slash.
  if (full.endsWith('.') || full.endsWith('/')) {
    return false;
  }

  // No `..` anywhere in the refname.
  if (full.includes('..')) {
    return false;
  }

  for (const component of full.split('/')) {
    if (component.length === 0) {
      return false; // leading, trailing, or doubled slash
    }
    if (component.startsWith('.')) {
      return false;
    }
    if (component.endsWith('.lock')) {
      return false;
    }
  }

  return true;
}
