import { useAtomValue } from 'jotai';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MachineId, SessionMeta } from '@lody/shared';
import { currentWorkspaceIdAtom } from '@/atoms';
import { getMachineMetaByIdAtomFamily } from '@/atoms/machines';
import { useMachineOnlineStatus } from '@/hooks/use-machine-online-status';
import { MemberFileProvider } from '@/lib/board-directory-file-provider';
import { writeTextToClipboard } from '@/lib/clipboard';
import { getIpcServices } from '@/lib/electron-ipc-client';
import type { SessionFileErrorActions } from '@/lib/session-file-actions';
import { toast } from '@/lib/toast';
import {
  SessionFileContentView,
  type SessionFileContentViewProps,
} from '../sessions/session-file-content-view';
import { SessionFileNoticeCard } from '../sessions/session-file-error-state';

/**
 * A file at a path of a LAN machine (`<machine>:<path>`), read with no session
 * through this machine's agent service, the way a Board's file is: read-only,
 * with what cannot show saved to disk whole. `reader` is the session the link
 * was read in; an article's comments go with its next message. While the
 * machine is away the view says so by name, and Retry reads anyway.
 */
export function MachineFileView({
  machineId,
  path,
  reader,
  ...view
}: {
  machineId: MachineId;
  path: string;
  reader: SessionMeta;
} & Pick<
  SessionFileContentViewProps,
  'startLine' | 'endLine' | 'active' | 'article' | 'className'
>) {
  const { t } = useTranslation();
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const machine = useAtomValue(getMachineMetaByIdAtomFamily(machineId));
  const online = useMachineOnlineStatus(machineId);
  const [retried, setRetried] = useState(false);
  const name = machine?.name ?? machineId;
  const provider = useMemo(() => {
    const ipc = getIpcServices();
    if (!ipc || !workspaceId) return null;
    return new MemberFileProvider(
      (asked) => asked,
      (machinePath) => ipc.machineRpc.openMemberFile({ workspaceId, machineId, machinePath })
    );
  }, [machineId, workspaceId]);
  const actions = useMemo((): SessionFileErrorActions => {
    const ipc = getIpcServices();
    const fileName = path.split(/[\\/]/u).pop() || path;
    return {
      onCopyPath: () => {
        void writeTextToClipboard(`${name}:${path}`).then((ok) => {
          if (ok) toast.success(t('sessions.fileViewer.pathCopied', 'File path copied'));
        });
      },
      ...(ipc && workspaceId
        ? {
            onDownload: () => {
              void ipc.machineRpc
                .saveMemberFile({ workspaceId, machineId, machinePath: path, fileName })
                .then((result) => {
                  if (!result.ok)
                    toast.error(
                      t('sessions.fileActions.downloadFailed', 'Could not download that file.'),
                      { description: result.error }
                    );
                  else if (result.saved)
                    toast.success(
                      t('sessions.fileActions.downloaded', 'Saved {{name}}', { name: fileName })
                    );
                });
            },
          }
        : {}),
    };
  }, [machineId, name, path, t, workspaceId]);

  if (online === 'offline' && !retried)
    return (
      <SessionFileNoticeCard
        presentation={{
          title: t('sessions.machineFile.offlineTitle', '{{machine}} is offline', {
            machine: name,
          }),
          description: t(
            'sessions.machineFile.offlineDescription',
            'This file is on {{machine}}. It opens once that machine is back online.',
            { machine: name }
          ),
        }}
        onRetry={() => setRetried(true)}
      />
    );
  return (
    <SessionFileContentView
      key={`${machineId}:${path}`}
      sessionId={reader.id}
      session={reader}
      filePath={path}
      fileProvider={provider}
      foreignFile={{ actions }}
      {...view}
    />
  );
}
