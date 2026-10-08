import {
  HostedConfigCategorySchema,
  HostedConfigImportResultSchema,
  HostedConfigPreviewSchema,
} from '../hosted-config';
import {
  LanAgentInstallResultSchema,
  LAN_GITHUB_TOKEN_MAX,
  LanGitHubStateSchema,
  LanGitHubTokenResultSchema,
  LanUsageReportSchema,
  LanMachineUpdateResultSchema,
  LanMachineRestartResultSchema,
  LAN_MACHINE_ALIAS_MAX,
  LanMachinesSchema,
  isLanMemberControlType,
  normalizeLanMachineColor,
} from '../lan-control';
import { LanShareIdSchema, LanSharedConversationSchema, LanShareSourceSchema } from '../lan-share';
import type { LocalProjectControlRequest, LocalProjectControlResponse } from '../message';

export const LOCAL_PROJECT_CONTROL_PATH = '/project-control';

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isOptionalBoolean(value: unknown): boolean {
  return typeof value === 'undefined' || typeof value === 'boolean';
}

function isOptionalInteger(value: unknown): boolean {
  return typeof value === 'undefined' || (Number.isInteger(value) && (value as number) > 0);
}

function isOptionalString(value: unknown): boolean {
  return typeof value === 'undefined' || typeof value === 'string';
}

function isWorktreeSetupConfig(value: unknown): boolean {
  return (
    isObjectRecord(value) &&
    isObjectRecord(value.scripts) &&
    (typeof value.scripts.bash === 'undefined' || typeof value.scripts.bash === 'string') &&
    (typeof value.scripts.powershell === 'undefined' ||
      typeof value.scripts.powershell === 'string') &&
    (typeof value.timeoutMs === 'undefined' ||
      (typeof value.timeoutMs === 'number' &&
        Number.isInteger(value.timeoutMs) &&
        value.timeoutMs > 0))
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isLocalProjectHistoryProvider(value: unknown): boolean {
  return (
    isObjectRecord(value) &&
    (value.cliType === 'builtin' || value.cliType === 'registry') &&
    typeof value.agentType === 'string' &&
    value.agentType.trim().length > 0
  );
}

function isLocalProjectFileListResult(value: unknown): boolean {
  return (
    isObjectRecord(value) && isStringArray(value.paths) && typeof value.truncated === 'boolean'
  );
}

function isLocalProjectFileReadResult(value: unknown): boolean {
  return (
    isObjectRecord(value) &&
    typeof value.path === 'string' &&
    typeof value.content === 'string' &&
    typeof value.truncated === 'boolean'
  );
}

function isLocalProjectDirectoryListResult(value: unknown): boolean {
  return (
    isObjectRecord(value) &&
    Array.isArray(value.entries) &&
    value.entries.every(
      (entry) =>
        isObjectRecord(entry) &&
        typeof entry.name === 'string' &&
        (entry.type === 'file' || entry.type === 'directory')
    ) &&
    typeof value.truncated === 'boolean'
  );
}

function isProjectSkillsResult(value: unknown): boolean {
  return (
    isObjectRecord(value) &&
    Array.isArray(value.groups) &&
    value.groups.every(
      (group) =>
        isObjectRecord(group) &&
        (group.scope === 'project' || group.scope === 'global' || group.scope === 'system') &&
        typeof group.dir === 'string' &&
        Array.isArray(group.skills) &&
        group.skills.every(
          (skill) =>
            isObjectRecord(skill) &&
            typeof skill.id === 'string' &&
            typeof skill.name === 'string' &&
            (typeof skill.description === 'undefined' || typeof skill.description === 'string') &&
            (typeof skill.version === 'undefined' || typeof skill.version === 'string') &&
            (typeof skill.author === 'undefined' || typeof skill.author === 'string') &&
            typeof skill.relativePath === 'string' &&
            (typeof skill.absolutePath === 'undefined' || typeof skill.absolutePath === 'string') &&
            typeof skill.isSymlink === 'boolean' &&
            (typeof skill.symlinkTarget === 'undefined' ||
              typeof skill.symlinkTarget === 'string') &&
            (typeof skill.content === 'undefined' || typeof skill.content === 'string')
        ) &&
        typeof group.truncated === 'boolean' &&
        (typeof group.skippedExternalSymlinks === 'undefined' ||
          (Number.isInteger(group.skippedExternalSymlinks) &&
            (group.skippedExternalSymlinks as number) >= 0)) &&
        (typeof group.error === 'undefined' || typeof group.error === 'string')
    ) &&
    (typeof value.contentFingerprint === 'undefined' ||
      typeof value.contentFingerprint === 'string')
  );
}

function isLocalProjectBrowseRootsResult(value: unknown): boolean {
  return (
    isObjectRecord(value) &&
    (value.platform === 'darwin' || value.platform === 'linux' || value.platform === 'win32') &&
    (value.pathSeparator === '/' || value.pathSeparator === '\\') &&
    typeof value.homeDir === 'string' &&
    (typeof value.drives === 'undefined' || isStringArray(value.drives))
  );
}

function isLocalProjectBrowseDirectoryResult(value: unknown): boolean {
  return (
    isObjectRecord(value) &&
    typeof value.path === 'string' &&
    (value.parentPath === null || typeof value.parentPath === 'string') &&
    Array.isArray(value.entries) &&
    value.entries.every((entry) => {
      if (
        !isObjectRecord(entry) ||
        typeof entry.name !== 'string' ||
        typeof entry.absolutePath !== 'string' ||
        typeof entry.isSymlink !== 'boolean' ||
        typeof entry.hidden !== 'boolean'
      ) {
        return false;
      }
      const hints = entry.hints;
      return (
        (typeof hints === 'undefined' ||
          (isObjectRecord(hints) &&
            (typeof hints.git === 'undefined' || typeof hints.git === 'boolean'))) &&
        (typeof entry.registeredProjectId === 'undefined' ||
          typeof entry.registeredProjectId === 'string') &&
        (typeof entry.error === 'undefined' || entry.error === 'unreadable')
      );
    }) &&
    typeof value.truncated === 'boolean' &&
    (typeof value.nextCursor === 'undefined' || typeof value.nextCursor === 'string')
  );
}

function isLocalProjectGitState(value: unknown): boolean {
  if (!isObjectRecord(value)) {
    return false;
  }

  if (value.git === false) {
    return true;
  }

  return (
    value.git === true &&
    isStringArray(value.branches) &&
    (value.currentBranch === null || typeof value.currentBranch === 'string') &&
    (value.defaultBranch === null || typeof value.defaultBranch === 'string') &&
    (value.githubRepoFullName === null || typeof value.githubRepoFullName === 'string') &&
    isObjectRecord(value.workingTree) &&
    typeof value.workingTree.clean === 'boolean' &&
    typeof value.workingTree.staged === 'boolean' &&
    typeof value.workingTree.unstaged === 'boolean' &&
    typeof value.workingTree.untracked === 'boolean' &&
    typeof value.workingTree.conflicted === 'boolean'
  );
}

function isLocalProjectCheckoutBranchResult(value: unknown): boolean {
  if (!isObjectRecord(value) || typeof value.success !== 'boolean') {
    return false;
  }

  if (value.success) {
    return typeof value.currentBranch === 'string';
  }

  return typeof value.error === 'string';
}

function isLocalProjectHistorySyncSummary(value: unknown): boolean {
  return (
    isObjectRecord(value) &&
    typeof value.listed === 'number' &&
    Number.isInteger(value.listed) &&
    value.listed >= 0 &&
    typeof value.imported === 'number' &&
    Number.isInteger(value.imported) &&
    value.imported >= 0 &&
    typeof value.refreshed === 'number' &&
    Number.isInteger(value.refreshed) &&
    value.refreshed >= 0 &&
    typeof value.skipped === 'number' &&
    Number.isInteger(value.skipped) &&
    value.skipped >= 0 &&
    typeof value.conflicted === 'number' &&
    Number.isInteger(value.conflicted) &&
    value.conflicted >= 0 &&
    typeof value.failed === 'number' &&
    Number.isInteger(value.failed) &&
    value.failed >= 0 &&
    Array.isArray(value.failures) &&
    value.failures.every(
      (failure) =>
        isObjectRecord(failure) &&
        typeof failure.acpSessionId === 'string' &&
        typeof failure.message === 'string'
    )
  );
}

function isLocalProjectHistoryCatalogItem(value: unknown): boolean {
  return (
    isObjectRecord(value) &&
    typeof value.acpSessionId === 'string' &&
    typeof value.title === 'string' &&
    (typeof value.updatedAt === 'undefined' || typeof value.updatedAt === 'string') &&
    (typeof value.importedSessionId === 'undefined' ||
      typeof value.importedSessionId === 'string') &&
    (typeof value.status === 'undefined' ||
      value.status === 'available' ||
      value.status === 'imported' ||
      value.status === 'sync_conflict')
  );
}

function isLocalProjectHistoryCatalogResult(value: unknown): boolean {
  return (
    isObjectRecord(value) &&
    typeof value.listed === 'number' &&
    Number.isInteger(value.listed) &&
    value.listed >= 0 &&
    typeof value.lastListedAt === 'number' &&
    Number.isInteger(value.lastListedAt) &&
    value.lastListedAt >= 0 &&
    Array.isArray(value.sessions) &&
    value.sessions.every(isLocalProjectHistoryCatalogItem)
  );
}

function isLocalProjectHistoryImportResult(value: unknown): boolean {
  return (
    isObjectRecord(value) &&
    isLocalProjectHistorySyncSummary(value.summary) &&
    isLocalProjectHistoryCatalogResult(value.catalog)
  );
}

function isLocalProjectHistoryConflictResolveResult(value: unknown): boolean {
  return (
    isObjectRecord(value) &&
    typeof value.sessionId === 'string' &&
    typeof value.acpSessionId === 'string' &&
    value.status === 'resolved' &&
    isLocalProjectHistoryCatalogResult(value.catalog)
  );
}

function isWorkspaceIds(value: unknown): boolean {
  return isStringArray(value);
}

function isLocalProjectWorktreeCleanupItem(value: unknown, failure = false): boolean {
  return (
    isObjectRecord(value) &&
    typeof value.sessionId === 'string' &&
    typeof value.title === 'string' &&
    typeof value.path === 'string' &&
    (!failure || typeof value.message === 'string')
  );
}

function isLocalProjectWorktreeCleanupPreflightResult(value: unknown): boolean {
  return (
    isObjectRecord(value) &&
    Array.isArray(value.clean) &&
    value.clean.every((item) => isLocalProjectWorktreeCleanupItem(item)) &&
    Array.isArray(value.dirty) &&
    value.dirty.every((item) => isLocalProjectWorktreeCleanupItem(item)) &&
    Array.isArray(value.failed) &&
    value.failed.every((item) => isLocalProjectWorktreeCleanupItem(item, true))
  );
}

export function isLocalProjectControlRequest(value: unknown): value is LocalProjectControlRequest {
  if (
    !isObjectRecord(value) ||
    typeof value.type !== 'string' ||
    typeof value.machineId !== 'string'
  ) {
    return false;
  }

  if (value.type === 'local-project/add') {
    return (
      typeof value.rootPath === 'string' &&
      (typeof value.workspace === 'undefined' || typeof value.workspace === 'string') &&
      isOptionalBoolean(value.allWorkspaces)
    );
  }

  if (value.type === 'local-project/prepare-add') {
    return typeof value.workspaceId === 'string' && typeof value.rootPath === 'string';
  }

  if (value.type === 'local-project/list-roots') {
    return true;
  }

  if (value.type === 'local-project/browse-dir') {
    return (
      isOptionalString(value.workspaceId) &&
      isOptionalString(value.absolutePath) &&
      isOptionalBoolean(value.showHidden) &&
      isOptionalInteger(value.limit) &&
      isOptionalString(value.cursor)
    );
  }

  if (value.type === 'local-project/delete') {
    return typeof value.workspaceId === 'string' && typeof value.localProjectId === 'string';
  }

  if (value.type === 'local-project/removal-preflight') {
    return (
      typeof value.workspaceId === 'string' &&
      typeof value.localProjectId === 'string' &&
      isOptionalString(value.requestedByUserId)
    );
  }

  if (value.type === 'local-project/list') {
    return true;
  }

  if (value.type === 'local-project/git-state') {
    return typeof value.workspaceId === 'string' && typeof value.localProjectId === 'string';
  }

  if (value.type === 'local-project/list-files') {
    return (
      typeof value.workspaceId === 'string' &&
      typeof value.localProjectId === 'string' &&
      isOptionalInteger(value.maxFiles) &&
      isOptionalString(value.requestedByUserId)
    );
  }

  if (value.type === 'local-project/list-dir') {
    return (
      typeof value.workspaceId === 'string' &&
      typeof value.localProjectId === 'string' &&
      typeof value.relativePath === 'string' &&
      isOptionalInteger(value.limit) &&
      isOptionalString(value.requestedByUserId)
    );
  }

  if (value.type === 'local-project/list-skills') {
    return (
      typeof value.workspaceId === 'string' &&
      typeof value.localProjectId === 'string' &&
      isStringArray(value.skillDirs) &&
      isOptionalString(value.requestedByUserId)
    );
  }

  if (value.type === 'local-project/list-global-skills') {
    return typeof value.workspaceId === 'string' && isOptionalString(value.requestedByUserId);
  }

  if (value.type === 'local-project/read-file') {
    return (
      typeof value.workspaceId === 'string' &&
      typeof value.localProjectId === 'string' &&
      typeof value.relativePath === 'string' &&
      isOptionalInteger(value.maxBytes) &&
      isOptionalString(value.requestedByUserId)
    );
  }

  if (value.type === 'local-project/checkout-branch') {
    return (
      typeof value.workspaceId === 'string' &&
      typeof value.localProjectId === 'string' &&
      typeof value.branchName === 'string'
    );
  }

  if (value.type === 'local-project/get-worktree-setup') {
    return (
      typeof value.workspaceId === 'string' &&
      typeof value.localProjectId === 'string' &&
      isOptionalString(value.requestedByUserId)
    );
  }

  if (value.type === 'local-project/set-worktree-setup') {
    return (
      typeof value.workspaceId === 'string' &&
      typeof value.localProjectId === 'string' &&
      isWorktreeSetupConfig(value.config) &&
      isOptionalString(value.requestedByUserId)
    );
  }

  if (value.type === 'local-project/get-worktree-cleanup') {
    return (
      typeof value.workspaceId === 'string' &&
      typeof value.localProjectId === 'string' &&
      isOptionalString(value.requestedByUserId)
    );
  }

  if (value.type === 'local-project/set-worktree-cleanup') {
    return (
      typeof value.workspaceId === 'string' &&
      typeof value.localProjectId === 'string' &&
      isWorktreeSetupConfig(value.config) &&
      isOptionalString(value.requestedByUserId)
    );
  }

  if (value.type === 'local-project/sync-history') {
    return (
      typeof value.workspaceId === 'string' &&
      typeof value.localProjectId === 'string' &&
      isLocalProjectHistoryProvider(value.provider) &&
      isOptionalString(value.requestedByUserId)
    );
  }

  if (value.type === 'local-project/import-history') {
    return (
      typeof value.workspaceId === 'string' &&
      typeof value.localProjectId === 'string' &&
      isLocalProjectHistoryProvider(value.provider) &&
      isStringArray(value.acpSessionIds) &&
      isOptionalString(value.requestedByUserId)
    );
  }

  if (value.type === 'local-project/resolve-history-conflict') {
    return (
      typeof value.workspaceId === 'string' &&
      typeof value.localProjectId === 'string' &&
      isLocalProjectHistoryProvider(value.provider) &&
      typeof value.sessionId === 'string' &&
      typeof value.acpSessionId === 'string' &&
      isOptionalString(value.requestedByUserId)
    );
  }

  if (value.type === 'worktree/list-files') {
    return (
      typeof value.repoFullName === 'string' &&
      typeof value.sessionId === 'string' &&
      isOptionalInteger(value.maxFiles)
    );
  }

  if (value.type === 'worktree/read-file') {
    return (
      typeof value.repoFullName === 'string' &&
      typeof value.sessionId === 'string' &&
      typeof value.relativePath === 'string' &&
      isOptionalInteger(value.maxBytes)
    );
  }

  if (value.type === 'hosted-config/preview') {
    return typeof value.workspaceId === 'string';
  }

  if (value.type === 'hosted-config/import') {
    return (
      typeof value.workspaceId === 'string' &&
      typeof value.sourceWorkspaceId === 'string' &&
      Array.isArray(value.categories) &&
      value.categories.every((category) => HostedConfigCategorySchema.safeParse(category).success)
    );
  }

  if (
    value.type === 'lan/update-machine' ||
    value.type === 'lan/restart-machine' ||
    value.type === 'lan/github'
  ) {
    return typeof value.workspaceId === 'string';
  }

  if (value.type === 'lan/github-token') {
    return (
      typeof value.workspaceId === 'string' &&
      (value.token === null ||
        (typeof value.token === 'string' &&
          value.token.trim().length > 0 &&
          value.token.length <= LAN_GITHUB_TOKEN_MAX))
    );
  }

  if (value.type === 'lan/shares') {
    return typeof value.workspaceId === 'string';
  }

  if (value.type === 'lan/share-publish') {
    return (
      typeof value.workspaceId === 'string' &&
      typeof value.directory === 'string' &&
      value.directory.length > 0 &&
      (value.shareId === undefined || LanShareIdSchema.safeParse(value.shareId).success) &&
      (value.expectedRevision === undefined ||
        (Number.isInteger(value.expectedRevision) && Number(value.expectedRevision) > 0)) &&
      typeof value.rootSourceId === 'string' &&
      Array.isArray(value.sources) &&
      value.sources.length > 0 &&
      value.sources.every((source) => LanShareSourceSchema.safeParse(source).success)
    );
  }

  if (value.type === 'lan/share-revoke') {
    return (
      typeof value.workspaceId === 'string' && LanShareIdSchema.safeParse(value.shareId).success
    );
  }

  if (value.type === 'lan/install-agent') {
    return typeof value.workspaceId === 'string' && typeof value.agentType === 'string';
  }

  if (value.type === 'lan/usage') {
    return (
      typeof value.workspaceId === 'string' &&
      (value.sinceMs === undefined ||
        (Number.isInteger(value.sinceMs) && (value.sinceMs as number) >= 0))
    );
  }

  if (value.type === 'lan/machines') {
    return true;
  }

  if (value.type === 'lan/alias-machine') {
    return (
      typeof value.target === 'string' &&
      (value.alias === null ||
        (typeof value.alias === 'string' && value.alias.length <= LAN_MACHINE_ALIAS_MAX)) &&
      (value.color === undefined ||
        value.color === null ||
        normalizeLanMachineColor(value.color) !== null)
    );
  }

  if (value.type === 'lan/forward') {
    return (
      isObjectRecord(value.request) &&
      typeof value.request.type === 'string' &&
      isLanMemberControlType(value.request.type) &&
      isLocalProjectControlRequest(value.request)
    );
  }

  return false;
}

export function isLocalProjectControlResponse(
  value: unknown
): value is LocalProjectControlResponse {
  if (!isObjectRecord(value) || typeof value.type !== 'string' || typeof value.ok !== 'boolean') {
    return false;
  }

  if (!value.ok) {
    return typeof value.error === 'string' && typeof value.message === 'string';
  }

  if (value.type === 'local-project/add') {
    return (
      isObjectRecord(value.result) &&
      typeof value.result.localProjectId === 'string' &&
      typeof value.result.name === 'string' &&
      typeof value.result.rootPath === 'string' &&
      isWorkspaceIds(value.result.workspaceIds)
    );
  }

  if (value.type === 'local-project/prepare-add') {
    return (
      isObjectRecord(value.result) &&
      typeof value.result.localProjectId === 'string' &&
      typeof value.result.name === 'string' &&
      typeof value.result.rootPath === 'string' &&
      typeof value.result.alreadyRegistered === 'boolean'
    );
  }

  if (value.type === 'local-project/list-roots') {
    return isLocalProjectBrowseRootsResult(value.result);
  }

  if (value.type === 'local-project/browse-dir') {
    return isLocalProjectBrowseDirectoryResult(value.result);
  }

  if (value.type === 'local-project/delete') {
    return (
      isObjectRecord(value.result) &&
      typeof value.result.localProjectId === 'string' &&
      typeof value.result.name === 'string' &&
      typeof value.result.rootPath === 'string' &&
      isWorkspaceIds(value.result.workspaceIds)
    );
  }

  if (value.type === 'local-project/removal-preflight') {
    return isLocalProjectWorktreeCleanupPreflightResult(value.result);
  }

  if (value.type === 'local-project/list') {
    return (
      isObjectRecord(value.result) &&
      Array.isArray(value.result.workspaces) &&
      value.result.workspaces.every(
        (workspace) =>
          isObjectRecord(workspace) &&
          typeof workspace.workspaceId === 'string' &&
          typeof workspace.workspaceName === 'string' &&
          Array.isArray(workspace.projects) &&
          workspace.projects.every(
            (project) =>
              isObjectRecord(project) &&
              typeof project.localProjectId === 'string' &&
              typeof project.name === 'string' &&
              typeof project.rootPath === 'string'
          )
      )
    );
  }

  if (value.type === 'local-project/list-files' || value.type === 'worktree/list-files') {
    return isLocalProjectFileListResult(value.result);
  }

  if (value.type === 'local-project/list-dir') {
    return isLocalProjectDirectoryListResult(value.result);
  }

  if (value.type === 'local-project/list-skills') {
    return isProjectSkillsResult(value.result);
  }

  if (value.type === 'local-project/list-global-skills') {
    return isProjectSkillsResult(value.result);
  }

  if (value.type === 'local-project/read-file' || value.type === 'worktree/read-file') {
    return value.result === null || isLocalProjectFileReadResult(value.result);
  }

  if (value.type === 'local-project/git-state') {
    return isLocalProjectGitState(value.result);
  }

  if (value.type === 'local-project/checkout-branch') {
    return isLocalProjectCheckoutBranchResult(value.result);
  }

  if (value.type === 'local-project/get-worktree-setup') {
    return value.result === null || isWorktreeSetupConfig(value.result);
  }

  if (value.type === 'local-project/set-worktree-setup') {
    return isWorktreeSetupConfig(value.result);
  }

  if (value.type === 'local-project/get-worktree-cleanup') {
    return value.result === null || isWorktreeSetupConfig(value.result);
  }

  if (value.type === 'local-project/set-worktree-cleanup') {
    return isWorktreeSetupConfig(value.result);
  }

  if (value.type === 'local-project/sync-history') {
    return isLocalProjectHistoryCatalogResult(value.result);
  }

  if (value.type === 'local-project/import-history') {
    return isLocalProjectHistoryImportResult(value.result);
  }

  if (value.type === 'local-project/resolve-history-conflict') {
    return isLocalProjectHistoryConflictResolveResult(value.result);
  }

  if (value.type === 'hosted-config/preview') {
    return HostedConfigPreviewSchema.safeParse(value.result).success;
  }

  if (value.type === 'hosted-config/import') {
    return HostedConfigImportResultSchema.safeParse(value.result).success;
  }

  if (value.type === 'lan/update-machine') {
    return LanMachineUpdateResultSchema.safeParse(value.result).success;
  }

  if (value.type === 'lan/restart-machine') {
    return LanMachineRestartResultSchema.safeParse(value.result).success;
  }

  if (value.type === 'lan/install-agent') {
    return LanAgentInstallResultSchema.safeParse(value.result).success;
  }

  if (value.type === 'lan/usage') {
    return LanUsageReportSchema.safeParse(value.result).success;
  }

  if (value.type === 'lan/github') {
    return LanGitHubStateSchema.safeParse(value.result).success;
  }

  if (value.type === 'lan/github-token') {
    return LanGitHubTokenResultSchema.safeParse(value.result).success;
  }

  if (value.type === 'lan/shares') {
    return (
      isObjectRecord(value.result) &&
      Array.isArray(value.result.shares) &&
      value.result.shares.every((share) => LanSharedConversationSchema.safeParse(share).success)
    );
  }

  if (value.type === 'lan/share-publish') {
    return (
      isObjectRecord(value.result) &&
      LanSharedConversationSchema.safeParse(value.result.share).success
    );
  }

  if (value.type === 'lan/share-revoke') {
    return isObjectRecord(value.result) && typeof value.result.revoked === 'boolean';
  }

  if (value.type === 'lan/machines') {
    return LanMachinesSchema.safeParse(value.result).success;
  }

  if (value.type === 'lan/alias-machine') {
    return (
      isObjectRecord(value.result) &&
      (value.result.alias === null || typeof value.result.alias === 'string') &&
      (value.result.color === undefined ||
        value.result.color === null ||
        normalizeLanMachineColor(value.result.color) !== null)
    );
  }

  if (value.type === 'lan/forward') {
    return (
      isObjectRecord(value.result) &&
      isObjectRecord(value.result.response) &&
      typeof value.result.response.type === 'string' &&
      isLanMemberControlType(value.result.response.type) &&
      isLocalProjectControlResponse(value.result.response)
    );
  }

  return false;
}
