export type BuildStamp = { repository: string; tag: string; commit?: string };

export function readBuildStamp(env?: Record<string, string | undefined>): BuildStamp | null;

export function defineBuildStamp(
  env?: Record<string, string | undefined>
): { __LODY_LAN_RELEASE_JSON__: string };

export const REPOSITORY_PATTERN: RegExp;
export const TAG_PATTERN: RegExp;
export const COMMIT_PATTERN: RegExp;
