import { Navigate, createFileRoute } from '@tanstack/react-router';
import { HostedImportSetting } from '@/components/settings/hosted-import-setting';
import { useIsMobile } from '@/hooks/use-mobile';

export const Route = createFileRoute('/$workspaceName/_auth/settings/import')({
  component: HostedImportSettingsRoute,
});

export function HostedImportSettingsRoute() {
  const isMobile = useIsMobile();
  const { workspaceName } = Route.useParams();

  // The hosted installation is read on the machine the desktop runs on.
  if (isMobile) {
    return (
      <Navigate
        to="/$workspaceName/settings"
        params={{ workspaceName }}
        search={(previous) => previous}
        replace
      />
    );
  }

  return <HostedImportSetting />;
}
