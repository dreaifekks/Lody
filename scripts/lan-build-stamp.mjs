// What a build of the self-hosted LAN fork is stamped with so that it follows
// its own releases. Bundler configurations import this module, and a bundler
// that inlines its configuration puts code in front of what it imports, so it
// stays free of an interpreter line and of everything the stamp does not need.

export const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/u;
export const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
export const COMMIT_PATTERN = /^[a-f0-9]{7,40}$/u;

/**
 * The repository the workflow of a build ran in and the tag that workflow
 * publishes. `null` for a build made anywhere else, which follows nothing.
 * Naming them wrongly fails the build instead of shipping one that silently
 * cannot update.
 */
export function readBuildStamp(env = process.env) {
  const repository = env.LODY_LAN_REPOSITORY?.trim();
  const tag = env.LODY_LAN_TAG?.trim();
  if (!repository || !tag) return null;
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error(`Invalid LODY_LAN_REPOSITORY ${JSON.stringify(repository)}`);
  }
  if (!TAG_PATTERN.test(tag)) throw new Error(`Invalid LODY_LAN_TAG ${JSON.stringify(tag)}`);
  const commit = env.LODY_LAN_COMMIT?.trim();
  if (commit && !COMMIT_PATTERN.test(commit)) {
    throw new Error(`Invalid LODY_LAN_COMMIT ${JSON.stringify(commit)}`);
  }
  return { repository, tag, ...(commit ? { commit } : {}) };
}

/** The stamp as the `define` of a bundler: a constant holding JSON, or `null`. */
export function defineBuildStamp(env = process.env) {
  const stamp = readBuildStamp(env);
  return {
    __LODY_LAN_RELEASE_JSON__: stamp ? JSON.stringify(JSON.stringify(stamp)) : 'null',
  };
}
