const LOCAL_PROJECT_CONTROL_PATH = '/project-control';

// Kept equal to LAN_MACHINE_ALIAS_MAX and LAN_MACHINE_COLORS of lan-control.ts.
const LAN_MACHINE_ALIAS_MAX = 32;
const LAN_MACHINE_COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'];
// Kept equal to LAN_GITHUB_TOKEN_MAX of lan-control.ts.
const LAN_GITHUB_TOKEN_MAX = 1000;
// Kept equal to LAN_SHARE_ID_PATTERN and LanShareSourceSchema of lan-share.ts.
const LAN_SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const LAN_SHARE_CONVERSATION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
// Kept equal to LAN_SHARE_IMAGE_KINDS and LanShareSettingsResultSchema of lan-share.ts.
const LAN_SHARE_IMAGE_KINDS = ['icon', 'preview'];
const LAN_SHARE_SETTINGS_RESULT_KEYS = ['hubUrl', 'icon', 'preview', 'publicUrl'];

const LAN_MEMBER_CONTROL_TYPES = new Set([
  'lan/update-machine',
  'lan/install-agent',
  'hosted-config/preview',
  'hosted-config/import',
  'lan/usage',
  'lan/restart-machine',
  'lan/github',
]);

const HOSTED_CONFIG_CATEGORIES = new Set([
  'agentConfigs',
  'mcpServers',
  'agentRoles',
  'localProjects',
  'worktreeScripts',
]);

function isLanShareId(value) {
  return typeof value === 'string' && LAN_SHARE_ID_PATTERN.test(value);
}

function isLanShareSource(value) {
  return (
    isObjectRecord(value) &&
    typeof value.sourceId === 'string' &&
    value.sourceId.length > 0 &&
    value.sourceId.length <= 256 &&
    typeof value.conversationId === 'string' &&
    LAN_SHARE_CONVERSATION_ID_PATTERN.test(value.conversationId)
  );
}

function isLanSharedConversation(value) {
  return (
    isObjectRecord(value) &&
    isLanShareId(value.shareId) &&
    typeof value.title === 'string' &&
    Array.isArray(value.sources) &&
    value.sources.every(isLanShareSource) &&
    Number.isInteger(value.revision) &&
    (value.url === null || typeof value.url === 'string')
  );
}

function isLanShareSettingsResult(value) {
  return (
    isObjectRecord(value) &&
    Object.keys(value).sort().join() === LAN_SHARE_SETTINGS_RESULT_KEYS.join() &&
    (value.publicUrl === null || typeof value.publicUrl === 'string') &&
    (value.hubUrl === null || typeof value.hubUrl === 'string') &&
    typeof value.icon === 'boolean' &&
    typeof value.preview === 'boolean'
  );
}

function isHostedConfigItems(value) {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isObjectRecord(item) &&
        HOSTED_CONFIG_CATEGORIES.has(item.category) &&
        typeof item.id === 'string' &&
        typeof item.name === 'string' &&
        typeof item.action === 'string'
    )
  );
}

function isObjectRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isOptionalBoolean(value) {
  return typeof value === 'undefined' || typeof value === 'boolean';
}

function isOptionalInteger(value) {
  return typeof value === 'undefined' || (Number.isInteger(value) && value > 0);
}

function isOptionalString(value) {
  return typeof value === 'undefined' || typeof value === 'string';
}

function isWorktreeSetupConfig(value) {
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

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isLocalProjectHistoryProvider(value) {
  return (
    isObjectRecord(value) &&
    (value.cliType === 'builtin' || value.cliType === 'registry') &&
    typeof value.agentType === 'string' &&
    value.agentType.trim().length > 0
  );
}

function isLocalProjectFileListResult(value) {
  return (
    isObjectRecord(value) && isStringArray(value.paths) && typeof value.truncated === 'boolean'
  );
}

function isLocalProjectFileReadResult(value) {
  return (
    isObjectRecord(value) &&
    typeof value.path === 'string' &&
    typeof value.content === 'string' &&
    typeof value.truncated === 'boolean'
  );
}

function isLocalProjectDirectoryListResult(value) {
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

function isProjectSkillsResult(value) {
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
            group.skippedExternalSymlinks >= 0)) &&
        (typeof group.error === 'undefined' || typeof group.error === 'string')
    ) &&
    (typeof value.contentFingerprint === 'undefined' ||
      typeof value.contentFingerprint === 'string')
  );
}

function isLocalProjectBrowseRootsResult(value) {
  return (
    isObjectRecord(value) &&
    (value.platform === 'darwin' || value.platform === 'linux' || value.platform === 'win32') &&
    (value.pathSeparator === '/' || value.pathSeparator === '\\') &&
    typeof value.homeDir === 'string' &&
    (typeof value.drives === 'undefined' || isStringArray(value.drives))
  );
}

function isLocalProjectBrowseDirectoryResult(value) {
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

function isLocalProjectGitState(value) {
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

function isLocalProjectCheckoutBranchResult(value) {
  if (!isObjectRecord(value) || typeof value.success !== 'boolean') {
    return false;
  }

  if (value.success) {
    return typeof value.currentBranch === 'string';
  }

  return typeof value.error === 'string';
}

function isLocalProjectHistorySyncSummary(value) {
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

function isLocalProjectHistoryCatalogItem(value) {
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

function isLocalProjectHistoryCatalogResult(value) {
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

function isLocalProjectHistoryImportResult(value) {
  return (
    isObjectRecord(value) &&
    isLocalProjectHistorySyncSummary(value.summary) &&
    isLocalProjectHistoryCatalogResult(value.catalog)
  );
}

function isLocalProjectHistoryConflictResolveResult(value) {
  return (
    isObjectRecord(value) &&
    typeof value.sessionId === 'string' &&
    typeof value.acpSessionId === 'string' &&
    value.status === 'resolved' &&
    isLocalProjectHistoryCatalogResult(value.catalog)
  );
}

function isWorkspaceIds(value) {
  return isStringArray(value);
}

function isLocalProjectWorktreeCleanupItem(value, failure = false) {
  return (
    isObjectRecord(value) &&
    typeof value.sessionId === 'string' &&
    typeof value.title === 'string' &&
    typeof value.path === 'string' &&
    (!failure || typeof value.message === 'string')
  );
}

function isLocalProjectWorktreeCleanupPreflightResult(value) {
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

function isLocalProjectControlRequest(value) {
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

  if (
    value.type === 'hosted-config/preview' ||
    value.type === 'lan/update-machine' ||
    value.type === 'lan/restart-machine' ||
    value.type === 'lan/github'
  ) {
    return typeof value.workspaceId === 'string';
  }

  if (value.type === 'lan/shares') {
    return typeof value.workspaceId === 'string';
  }

  if (value.type === 'lan/share-publish') {
    return (
      typeof value.workspaceId === 'string' &&
      typeof value.directory === 'string' &&
      value.directory.length > 0 &&
      (value.shareId === undefined || isLanShareId(value.shareId)) &&
      (value.expectedRevision === undefined ||
        (Number.isInteger(value.expectedRevision) && value.expectedRevision > 0)) &&
      typeof value.rootSourceId === 'string' &&
      Array.isArray(value.sources) &&
      value.sources.length > 0 &&
      value.sources.every(isLanShareSource)
    );
  }

  if (value.type === 'lan/share-revoke') {
    return typeof value.workspaceId === 'string' && isLanShareId(value.shareId);
  }

  if (value.type === 'lan/share-settings') {
    return (
      typeof value.workspaceId === 'string' &&
      (value.publicUrl === undefined ||
        value.publicUrl === null ||
        (typeof value.publicUrl === 'string' && value.publicUrl.length <= 2048))
    );
  }

  if (value.type === 'lan/share-image') {
    return (
      typeof value.workspaceId === 'string' &&
      LAN_SHARE_IMAGE_KINDS.includes(value.kind) &&
      (value.path === null || (typeof value.path === 'string' && value.path.length > 0))
    );
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

  if (value.type === 'hosted-config/import') {
    return (
      typeof value.workspaceId === 'string' &&
      typeof value.sourceWorkspaceId === 'string' &&
      Array.isArray(value.categories) &&
      value.categories.every((category) => HOSTED_CONFIG_CATEGORIES.has(category))
    );
  }

  if (value.type === 'lan/install-agent') {
    return typeof value.workspaceId === 'string' && typeof value.agentType === 'string';
  }

  if (value.type === 'lan/usage') {
    return (
      typeof value.workspaceId === 'string' &&
      (value.sinceMs === undefined || (Number.isInteger(value.sinceMs) && value.sinceMs >= 0))
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
        LAN_MACHINE_COLORS.includes(value.color))
    );
  }

  if (value.type === 'lan/forward') {
    return (
      isObjectRecord(value.request) &&
      LAN_MEMBER_CONTROL_TYPES.has(value.request.type) &&
      isLocalProjectControlRequest(value.request)
    );
  }

  return false;
}

function isLocalProjectControlResponse(value) {
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
    return (
      isObjectRecord(value.result) &&
      typeof value.result.found === 'boolean' &&
      Array.isArray(value.result.sources) &&
      value.result.sources.every(
        (source) =>
          isObjectRecord(source) &&
          typeof source.workspaceId === 'string' &&
          typeof source.name === 'string' &&
          isHostedConfigItems(source.items)
      )
    );
  }

  if (value.type === 'hosted-config/import') {
    return (
      isObjectRecord(value.result) &&
      typeof value.result.workspaceId === 'string' &&
      isHostedConfigItems(value.result.items)
    );
  }

  if (value.type === 'lan/update-machine') {
    return (
      isObjectRecord(value.result) &&
      (value.result.outcome === 'started' || value.result.outcome === 'current') &&
      typeof value.result.version === 'string'
    );
  }

  if (value.type === 'lan/restart-machine') {
    return isObjectRecord(value.result) && value.result.outcome === 'started';
  }

  if (value.type === 'lan/github') {
    const isAccount = (account) =>
      account === null ||
      (isObjectRecord(account) && (account.login === null || typeof account.login === 'string'));
    return (
      isObjectRecord(value.result) && isAccount(value.result.own) && isAccount(value.result.lan)
    );
  }

  if (value.type === 'lan/github-token') {
    return (
      isObjectRecord(value.result) &&
      (value.result.login === null || typeof value.result.login === 'string')
    );
  }

  if (value.type === 'lan/shares') {
    return (
      isObjectRecord(value.result) &&
      Array.isArray(value.result.shares) &&
      value.result.shares.every(isLanSharedConversation)
    );
  }

  if (value.type === 'lan/share-publish') {
    return isObjectRecord(value.result) && isLanSharedConversation(value.result.share);
  }

  if (value.type === 'lan/share-revoke') {
    return isObjectRecord(value.result) && typeof value.result.revoked === 'boolean';
  }

  if (value.type === 'lan/share-settings' || value.type === 'lan/share-image') {
    return isLanShareSettingsResult(value.result);
  }

  if (value.type === 'lan/install-agent') {
    return (
      isObjectRecord(value.result) &&
      (value.result.outcome === 'started' || value.result.outcome === 'current') &&
      typeof value.result.agentType === 'string'
    );
  }

  if (value.type === 'lan/usage') {
    return (
      isObjectRecord(value.result) &&
      Array.isArray(value.result.rows) &&
      value.result.rows.every(
        (row) =>
          isObjectRecord(row) &&
          typeof row.startMs === 'number' &&
          typeof row.spanMs === 'number' &&
          typeof row.modelId === 'string' &&
          typeof row.inputTokens === 'number' &&
          typeof row.outputTokens === 'number' &&
          typeof row.cacheReadInputTokens === 'number' &&
          typeof row.cacheCreationInputTokens === 'number' &&
          typeof row.reasoningOutputTokens === 'number' &&
          typeof row.costUSD === 'number'
      )
    );
  }

  if (value.type === 'lan/machines') {
    return (
      isObjectRecord(value.result) &&
      Array.isArray(value.result.machines) &&
      value.result.machines.every(
        (machine) =>
          isObjectRecord(machine) &&
          typeof machine.machineId === 'string' &&
          typeof machine.name === 'string' &&
          typeof machine.self === 'boolean' &&
          Array.isArray(machine.lans) &&
          Array.isArray(machine.agents)
      )
    );
  }

  if (value.type === 'lan/alias-machine') {
    return (
      isObjectRecord(value.result) &&
      (value.result.alias === null || typeof value.result.alias === 'string') &&
      (value.result.color === undefined ||
        value.result.color === null ||
        LAN_MACHINE_COLORS.includes(value.result.color))
    );
  }

  if (value.type === 'lan/forward') {
    return (
      isObjectRecord(value.result) &&
      isObjectRecord(value.result.response) &&
      LAN_MEMBER_CONTROL_TYPES.has(value.result.response.type) &&
      isLocalProjectControlResponse(value.result.response)
    );
  }

  return false;
}

module.exports = {
  LOCAL_PROJECT_CONTROL_PATH,
  isLocalProjectControlRequest,
  isLocalProjectControlResponse,
};
