// Static conversation sharing in a LAN workspace: the hub of the LAN keeps
// the published copies. The window captures with the upstream exporter and
// hands the package to the shell, whose agent service uploads it with the
// hub's credential; the window never addresses the hub for a share. The hooks
// return what the upstream share dialog renders, so it is the same dialog.
// See `.agents/docs/lan-sharing.md#shared-conversations`.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useAtomValue, useStore } from 'jotai';
import { useTranslation } from 'react-i18next';
import i18next from 'i18next';
import type { SessionShareManagementEntry } from '@lody/cloud-api';
import type {
  LocalProjectControlResponse,
  MachineId,
  SessionMeta,
  WorkspaceId,
} from '@lody/shared';
import {
  LAN_SHARE_IMAGE_MAX_BYTES,
  sniffLanShareImage,
  type LanSharedConversation,
  type LanShareImageKind,
  type LanShareSettingsResult,
} from '@lody/shared/lan-share';
import {
  mapShareConcurrent,
  prepareSharePackage,
  type PreparedSharePackage,
} from '@lody/shared/session-sharing';
import { userAtom } from '@/atoms';
import { sessionMetaCacheAtom } from '@/atoms/doc-meta';
import { activeWorkspaceRuntimeAtom, type SessionDocStore } from '@/atoms/runtime';
import type { useSessionShareManagement } from '@/hooks/use-session-share-management';
import { useAppCapability } from '@/lib/app-platform';
import { isElectronRenderer } from '@/lib/electron';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { sessionShareErrorMessage, type ShareActionStage } from '@/lib/session-share-errors';
import type { SessionPublicShareStatus } from '@/lib/session-sharing';
import type { SharePublishPhase, SharePublishResult } from '@/hooks/use-session-share-management';

// The shell fills in the machine it runs on.
const THIS_MACHINE = '' as MachineId;
/** A list read this recently is good enough for a header that just mounted. */
const FRESH_MS = 30_000;

export type LanSharesState =
  | { status: 'loading' }
  /** This workspace is not one of a LAN of this machine, or nothing here can say. */
  | { status: 'unavailable' }
  | { status: 'ready'; shares: LanSharedConversation[] }
  | { status: 'failed' };

type Entry = {
  state: LanSharesState;
  loadedAt: number;
  loading: Promise<void> | null;
  listeners: Set<() => void>;
};

const entries = new Map<string, Entry>();

function entryOf(workspaceId: string): Entry {
  let entry = entries.get(workspaceId);
  if (!entry) {
    entry = { state: { status: 'loading' }, loadedAt: 0, loading: null, listeners: new Set() };
    entries.set(workspaceId, entry);
  }
  return entry;
}

function control() {
  return isElectronRenderer() ? (getIpcServices()?.localProjects ?? null) : null;
}

/** Reads the shares of a workspace's LAN again; every hook that shows them follows. */
export function refreshLanShares(workspaceId: string): Promise<void> {
  const entry = entryOf(workspaceId);
  if (entry.loading) return entry.loading;
  const loading = (async () => {
    const response: LocalProjectControlResponse | null =
      (await control()
        ?.control({
          type: 'lan/shares',
          machineId: THIS_MACHINE,
          workspaceId: workspaceId as WorkspaceId,
        })
        .catch(() => null)) ?? null;
    if (response?.ok) {
      entry.state =
        response.type === 'lan/shares'
          ? { status: 'ready', shares: response.result.shares }
          : { status: 'failed' };
    } else if (
      !response ||
      response.error === 'workspace_not_found' ||
      response.error === 'daemon_unavailable' ||
      // An agent service of a build without shares does not know the request.
      response.error === 'invalid_request'
    ) {
      entry.state = { status: 'unavailable' };
    } else {
      entry.state = { status: 'failed' };
    }
    entry.loadedAt = Date.now();
  })().finally(() => {
    entry.loading = null;
    for (const listener of entry.listeners) listener();
  });
  entry.loading = loading;
  return loading;
}

const NONE = { status: 'unavailable' } as const;

/** The shares of a workspace's LAN; `null` workspace reads as unavailable. */
export function useLanShares(workspaceId: string | null): LanSharesState {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!workspaceId) return () => {};
      const entry = entryOf(workspaceId);
      entry.listeners.add(listener);
      return () => entry.listeners.delete(listener);
    },
    [workspaceId]
  );
  const state = useSyncExternalStore(subscribe, () =>
    workspaceId ? entryOf(workspaceId).state : NONE
  );
  useEffect(() => {
    if (!workspaceId) return;
    const entry = entryOf(workspaceId);
    if (Date.now() - entry.loadedAt > FRESH_MS) void refreshLanShares(workspaceId);
  }, [workspaceId]);
  return state;
}

/**
 * Whether conversations of this workspace are shared through its LAN's hub:
 * the `lanSharing` capability, no hosted sharing, and a workspace of a LAN.
 */
export function useLanSharing(workspaceId: string | null | undefined): boolean {
  const hosted = useAppCapability('teamSharing');
  const lan = useAppCapability('lanSharing') && !hosted && isElectronRenderer();
  const state = useLanShares(lan ? (workspaceId ?? null) : null);
  return lan && (state.status === 'ready' || state.status === 'failed');
}

function latestRootedAt(
  state: LanSharesState,
  sessionId: string
): LanSharedConversation | null | undefined {
  if (state.status === 'loading') return undefined;
  if (state.status !== 'ready') return null;
  return (
    state.shares
      .filter((share) => share.rootSourceId === sessionId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null
  );
}

/** The header's statement: whether a share rooted at this conversation is published. */
export function useLanSessionShareStatus(
  workspaceId: string | null,
  sessionId: string
): SessionPublicShareStatus {
  const state = useLanShares(workspaceId);
  if (!workspaceId) return 'none';
  const share = latestRootedAt(state, sessionId);
  if (share === undefined) return 'unknown';
  return share ? 'shared' : 'none';
}

/** A LAN share in the shape the upstream dialog reads. Every member of a LAN may manage it. */
export function toLanShareEntry(
  share: LanSharedConversation,
  publisherUserId: string
): SessionShareManagementEntry {
  return {
    shareId: share.shareId,
    rootSessionId: share.rootSourceId,
    publisherUserId,
    status: 'active',
    revision: share.revision,
    credentialVersion: 1,
    currentDeploymentId: share.deployment,
    title: share.title,
    createdAt: Date.parse(share.createdAt),
    updatedAt: Date.parse(share.updatedAt),
    sourceIds: share.sources,
    selectedSourceIds: share.sources.map((source) => source.sourceId),
    canManage: true,
    canRevoke: true,
  };
}

/**
 * Freezes the selected conversations with the upstream exporter. A LAN keeps
 * the picture of a message as a file, which sharing omits with every file;
 * a typed image only the hosted store backs, so it fails the capture.
 */
async function captureLanSessionShare(options: {
  sessions: readonly SessionMeta[];
  rootSessionId: string;
  previousSourceIds?: readonly { sourceId: string; conversationId: string }[];
  signal: AbortSignal;
  runtime: {
    prepareSessionTarget: (
      sessionId: SessionMeta['id'],
      machineId: SessionMeta['machineId']
    ) => Promise<unknown>;
    acquireSessionStore: (sessionId: SessionMeta['id']) => Promise<SessionDocStore>;
    releaseSessionStoreRef: (sessionId: SessionMeta['id']) => void;
  };
}): Promise<PreparedSharePackage> {
  const stores: Array<{ store: SessionDocStore; releaseSync: () => void }> = [];
  try {
    const ordered = await mapShareConcurrent(
      options.sessions,
      async (session, _index, signal) => {
        await options.runtime.prepareSessionTarget(session.id, session.machineId);
        signal.throwIfAborted();
        const store = await options.runtime.acquireSessionStore(session.id);
        stores.push({ store, releaseSync: store.acquireSync() });
        return store;
      },
      options.signal
    );
    // Every document hydrates before any history is read, as upstream captures.
    await Promise.all(ordered.map((store) => store.firstSynced));
    options.signal.throwIfAborted();
    const histories = await Promise.all(
      ordered.map((store) => store.sessionData.history.readAll())
    );
    return await prepareSharePackage({
      fileAttachmentOmissionText: i18next.t(
        'sharing.fileAttachmentOmitted',
        'File attachment not included in this share'
      ),
      rootSourceId: options.rootSessionId,
      previousSourceIds: options.previousSourceIds,
      capturedAt: new Date().toISOString(),
      conversations: options.sessions.map((meta, index) => ({
        sourceId: meta.id,
        title: meta.title ?? '',
        history: histories[index],
        parentSourceId: meta.parentSessionId ?? undefined,
        openedBySourceId: meta.openedBySessionId ?? undefined,
        childSessionPlacement:
          meta.childSessionPlacement === 'side-panel' ? 'side-panel' : undefined,
      })),
      signal: options.signal,
      // No compressHistory: the reader page the hub serves decodes no Zstd.
      readAttachment: () => Promise.reject(new Error('Share attachment unavailable')),
    });
  } finally {
    for (const { store, releaseSync } of stores) {
      releaseSync();
      options.runtime.releaseSessionStoreRef(store.sessionId);
    }
  }
}

class LanShareRequestError extends Error {
  constructor(
    message: string,
    readonly data: { code?: string } | null
  ) {
    super(message);
  }
}

function failure(response: LocalProjectControlResponse | null | undefined): Error {
  if (!response) return new Error('Share publication failed');
  if (response.ok) return new Error('Share publication failed');
  const status =
    typeof response.data === 'object' && response.data !== null && 'status' in response.data
      ? response.data.status
      : null;
  return new LanShareRequestError(
    response.message,
    status === 409
      ? { code: 'share_conflict' }
      : status === 404
        ? { code: 'share_unavailable' }
        : null
  );
}

async function copyLink(url: string | null): Promise<boolean> {
  if (!url) return false;
  try {
    await navigator.clipboard.writeText(url);
    return true;
  } catch {
    return false;
  }
}

/** Revokes a LAN share; the list every hook shows follows. */
export async function revokeLanShare(workspaceId: string, shareId: string): Promise<void> {
  const response = await control()?.control({
    type: 'lan/share-revoke',
    machineId: THIS_MACHINE,
    workspaceId: workspaceId as WorkspaceId,
    shareId,
  });
  await refreshLanShares(workspaceId);
  if (!response?.ok) throw failure(response);
}

/** Why a change of the share pages' settings was refused, as the window words it. */
export type LanShareSettingsErrorCode = 'too_large' | 'unsupported' | 'invalid_address' | 'failed';

export class LanShareSettingsError extends Error {
  constructor(readonly code: LanShareSettingsErrorCode) {
    super(code);
    this.name = 'LanShareSettingsError';
  }
}

function settingsResult(response: LocalProjectControlResponse | null | undefined) {
  if (
    response?.ok &&
    (response.type === 'lan/share-settings' || response.type === 'lan/share-image')
  )
    return response.result;
  const status =
    response && !response.ok && typeof response.data === 'object' && response.data !== null
      ? (response.data as { status?: unknown }).status
      : null;
  throw new LanShareSettingsError(
    status === 413
      ? 'too_large'
      : status === 415
        ? 'unsupported'
        : status === 400 && response?.type === 'lan/share-settings'
          ? 'invalid_address'
          : 'failed'
  );
}

/** The settings of the share pages of a workspace's LAN. */
export async function readLanShareSettings(workspaceId: string): Promise<LanShareSettingsResult> {
  return settingsResult(
    await control()
      ?.control({
        type: 'lan/share-settings',
        machineId: THIS_MACHINE,
        workspaceId: workspaceId as WorkspaceId,
      })
      .catch(() => null)
  );
}

/** Sets where readers reach the shares, or `null` for the hub's own address; the links follow. */
export async function saveLanSharePublicUrl(
  workspaceId: string,
  publicUrl: string | null
): Promise<LanShareSettingsResult> {
  const response = await control()
    ?.control({
      type: 'lan/share-settings',
      machineId: THIS_MACHINE,
      workspaceId: workspaceId as WorkspaceId,
      publicUrl,
    })
    .catch(() => null);
  const result = settingsResult(response);
  await refreshLanShares(workspaceId);
  return result;
}

/**
 * Gives the hub an image of its share pages, or `null` for Lody's icon again.
 * What the hub would refuse is refused here, before it is sent.
 */
export async function saveLanShareImage(
  workspaceId: string,
  kind: LanShareImageKind,
  bytes: Uint8Array | null
): Promise<LanShareSettingsResult> {
  if (bytes) {
    if (bytes.byteLength > LAN_SHARE_IMAGE_MAX_BYTES[kind])
      throw new LanShareSettingsError('too_large');
    if (!sniffLanShareImage(bytes, kind)) throw new LanShareSettingsError('unsupported');
  }
  const setShareImage = isElectronRenderer() ? getIpcServices()?.lan.setShareImage : undefined;
  return settingsResult(await setShareImage?.({ workspaceId, kind, bytes }).catch(() => null));
}

/** What the upstream share dialog renders, for a conversation of a LAN workspace. */
export function useLanSessionShareManagement(
  workspaceId: WorkspaceId,
  sessionId: string,
  candidateIds: string[],
  shareId?: string
): ReturnType<typeof useSessionShareManagement> {
  const { t } = useTranslation();
  const store = useStore();
  const meta = useAtomValue(sessionMetaCacheAtom);
  const userId = useAtomValue(userAtom)?.id ?? '';
  const state = useLanShares(workspaceId);
  const share =
    state.status === 'ready' && shareId
      ? (state.shares.find((candidate) => candidate.shareId === shareId) ?? null)
      : latestRootedAt(state, sessionId);
  const entry = share ? toLanShareEntry(share, userId) : share;
  const [selectedDraft, setSelected] = useState<string[] | null>(null);
  const [pending, setPending] = useState<PreparedSharePackage | null>(null);
  const [phase, setPhase] = useState<SharePublishPhase>('idle');
  const [result, setResult] = useState<SharePublishResult | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  const selected = selectedDraft ?? (entry ? entry.selectedSourceIds : [sessionId]);

  const run = async (action: (setStage: (stage: ShareActionStage) => void) => Promise<void>) => {
    if (busy) return;
    let stage: ShareActionStage = 'capture';
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action((next) => {
        stage = next;
      });
    } catch (cause) {
      if (!lifetime.current?.signal.aborted) {
        if (cause instanceof LanShareRequestError && cause.data?.code === 'share_conflict') {
          setConflict(true);
        }
        setError(sessionShareErrorMessage(cause, stage, t));
      }
    } finally {
      setPhase('idle');
      if (!lifetime.current?.signal.aborted) setBusy(false);
    }
  };

  const publish = () =>
    run(async (setStage) => {
      const signal = lifetime.current?.signal;
      const runtime = store.get(activeWorkspaceRuntimeAtom);
      const publishShare = getIpcServices()?.lan.publishShare;
      if (!signal || !runtime || runtime.workspaceId !== workspaceId || !publishShare)
        throw new Error('Share source unavailable');
      const byId = new Map(Object.values(meta).map((session) => [session.id as string, session]));
      const sessions = selected.map((id) => byId.get(id)).filter((s): s is SessionMeta => !!s);
      if (sessions.length !== selected.length || !selected.includes(sessionId))
        throw new Error('Share source unavailable');
      let prepared = pending;
      if (!prepared) {
        setStage('capture');
        setPhase('capturing');
        prepared = await captureLanSessionShare({
          runtime,
          sessions,
          rootSessionId: sessionId,
          previousSourceIds: entry?.sourceIds,
          signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
        });
        setPending(prepared);
      }
      setStage('publish');
      setPhase('publishing');
      const response = await publishShare({
        workspaceId,
        ...(entry ? { shareId: entry.shareId, expectedRevision: entry.revision } : {}),
        rootSourceId: sessionId,
        sources: prepared.sourceIds,
        manifest: prepared.manifestBytes,
        objects: [...prepared.objects].map(([id, bytes]) => ({ id, bytes })),
      });
      if (!response.ok || response.type !== 'lan/share-publish') throw failure(response);
      await refreshLanShares(workspaceId);
      if (signal.aborted) return;
      const url = response.result.share.url;
      setResult({ url, copied: await copyLink(url) });
      setPending(null);
      setSelected(null);
    });

  return {
    entry,
    selected,
    hasPending: pending !== null,
    conflict,
    progress: 0,
    phase,
    result,
    shareLink: result?.url ?? share?.url ?? null,
    canCapture:
      entry !== undefined &&
      selected.every(
        (id) =>
          candidateIds.includes(id) && Object.values(meta).some((session) => session.id === id)
      ),
    busy,
    error,
    notice,
    // A LAN link is the address alone; there is no credential to keep.
    hasSecret: true,
    onSelect(ids: string[]) {
      if (!busy) {
        setSelected(ids);
        setPending(null);
      }
    },
    onPublish: publish,
    onDiscard: () => {
      setPending(null);
      setConflict(false);
      void refreshLanShares(workspaceId);
    },
    onCopy: () =>
      run(async (setStage) => {
        setStage('copy');
        const url = result?.url ?? share?.url ?? null;
        if (!url) throw new Error('Share credential unavailable');
        await navigator.clipboard.writeText(url);
        if (result) setResult({ ...result, copied: true });
        else setNotice(t('settings.shares.copied', 'Share link copied'));
      }),
    onReset: () => Promise.resolve(),
    onRevoke: () =>
      run(async (setStage) => {
        if (!entry) return;
        setStage('revoke');
        await revokeLanShare(workspaceId, entry.shareId);
        setResult(null);
      }),
  };
}
