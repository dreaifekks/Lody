import { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import type { LoroDoc } from 'loro-crdt';
import {
  getBoardRoomId,
  readBoardDocument,
  writeBoardNotes,
  type BoardDocument,
} from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { useResolvedWorkspaceScope } from './use-resolved-workspace-scope';

/** Only the open notes panel subscribes; the workspace repo owns persistence and transport. */
export function useBoardDocument(id: string) {
  const active = useAtomValue(activeWorkspaceRuntimeAtom);
  const scope = useResolvedWorkspaceScope();
  const runtime = scope.enabled && scope.workspaceId === active?.workspaceId ? active : null;
  const [value, setValue] = useState<{
    runtime: typeof runtime;
    id: string;
    document: BoardDocument;
    save: (text: string) => Promise<void>;
  } | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!runtime) return undefined;
    let disposed = false;
    let off: (() => void) | undefined;
    let leave: (() => void) | undefined;
    setError(false);
    void (async () => {
      const handle = await runtime.repo.openPersistedDoc(getBoardRoomId(id));
      if (disposed) return;
      const doc = handle.doc as LoroDoc;
      const save = async (text: string) => {
        if (disposed) throw new Error('Board document closed');
        writeBoardNotes(doc, { kind: 'replace', text, updatedBy: 'user', now: Date.now() });
        await runtime.repo.flush();
      };
      const update = () => {
        if (!disposed) setValue({ runtime, id, document: readBoardDocument(doc), save });
      };
      off = doc.subscribe(update);
      update();
      const room = await handle.joinRoom();
      if (disposed) {
        room.unsubscribe();
        return;
      }
      leave = () => room.unsubscribe();
      await room.firstSyncedWithRemote;
      update();
    })().catch(() => {
      if (!disposed) setError(true);
    });
    return () => {
      disposed = true;
      off?.();
      leave?.();
    };
  }, [runtime, id]);
  return { ...(value?.runtime === runtime && value?.id === id ? value : null), error };
}
