import { useAtomValue } from 'jotai';
import { Copy, Download } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MachineId, SessionMeta } from '@lody/shared';
import { currentWorkspaceIdAtom } from '@/atoms';
import { getMachineMetaByIdAtomFamily } from '@/atoms/machines';
import type { SessionFileMenuItem } from '@/hooks/use-session-file-actions';
import { useMachineOnlineStatus } from '@/hooks/use-machine-online-status';
import { MemberFileProvider } from '@/lib/board-directory-file-provider';
import { writeTextToClipboard } from '@/lib/clipboard';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { machineLinkName, type MachineFileLink } from '@/lib/machine-file-link';
import type { SessionFileErrorActions } from '@/lib/session-file-actions';
import { toast } from '@/lib/toast';
import { SessionFileActionsMenu } from '../sessions/session-file-actions-menu';
import {
  SessionFileContentView,
  type SessionFileContentViewProps,
} from '../sessions/session-file-content-view';
import { SessionFileNoticeCard } from '../sessions/session-file-error-state';

/**
 * What a machine's file offers wherever it shows: its path copied the way a
 * link names it (`<machine>:<path>`), and the file saved whole from there.
 */
function useMachineFileActions(machineId: MachineId, path: string) {
  const { t } = useTranslation();
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const machine = useAtomValue(getMachineMetaByIdAtomFamily(machineId));
  const ownName = machine?.ownName ?? machine?.name;
  const linkName = machineLinkName({
    id: machineId,
    ...(ownName === undefined ? {} : { name: ownName }),
    lanAlias: machine?.lanAlias,
  });
  return useMemo(() => {
    const ipc = getIpcServices();
    const fileName = path.split(/[\\/]/u).pop() || path;
    const copyPath = () => {
      void writeTextToClipboard(`${linkName}:${path}`).then((ok) => {
        if (ok) toast.success(t('sessions.fileViewer.pathCopied', 'File path copied'));
      });
    };
    const download =
      ipc && workspaceId
        ? () => {
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
          }
        : null;
    const errorActions: SessionFileErrorActions = {
      onCopyPath: copyPath,
      ...(download ? { onDownload: download } : {}),
    };
    const menuItems: SessionFileMenuItem[] = [
      {
        id: 'copy-absolute-path',
        label: t('sessions.fileViewer.copyPath', 'Copy file path'),
        icon: Copy,
        run: copyPath,
      },
    ];
    if (download)
      menuItems.push({
        id: 'download',
        label: t('sessions.fileActions.download', 'Download file'),
        icon: Download,
        run: download,
      });
    return { errorActions, menuItems };
  }, [linkName, machineId, path, t, workspaceId]);
}

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
  'startLine' | 'endLine' | 'focusRequestSeq' | 'active' | 'article' | 'className'
>) {
  const { t } = useTranslation();
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const machine = useAtomValue(getMachineMetaByIdAtomFamily(machineId));
  const online = useMachineOnlineStatus(machineId);
  const [retried, setRetried] = useState(false);
  const { errorActions } = useMachineFileActions(machineId, path);
  const name = machine?.name ?? machineId;
  const provider = useMemo(() => {
    const ipc = getIpcServices();
    if (!ipc || !workspaceId) return null;
    return new MemberFileProvider(
      (asked) => asked,
      (machinePath) => ipc.machineRpc.openMemberFile({ workspaceId, machineId, machinePath })
    );
  }, [machineId, workspaceId]);

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
      foreignFile={{ actions: errorActions }}
      {...view}
    />
  );
}

/**
 * The side panel's ⋯ for a machine's file tab: the page's own actions, then
 * the machine's; never the page session's, whose editor and folders are elsewhere.
 */
export function MachineFileActionsMenu({
  file,
  filePath,
  leadingItems,
}: {
  file: MachineFileLink;
  /** The tab's path, which the page's own actions read. */
  filePath: string | null;
  leadingItems: readonly SessionFileMenuItem[];
}) {
  const { menuItems } = useMachineFileActions(file.machineId, file.path);
  return <SessionFileActionsMenu filePath={filePath} items={[...leadingItems, ...menuItems]} />;
}
