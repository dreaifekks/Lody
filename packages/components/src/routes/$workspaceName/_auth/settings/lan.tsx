import { Navigate, createFileRoute } from '@tanstack/react-router';
import { LanSetting } from '@/components/settings/lan-setting';
import { useIsMobile } from '@/hooks/use-mobile';

export const Route = createFileRoute('/$workspaceName/_auth/settings/lan')({
  component: LanSettingsRoute,
});

export function LanSettingsRoute() {
  const isMobile = useIsMobile();
  const { workspaceName } = Route.useParams();

  // LANs are joined on the desktop, whose shell reaches them.
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

  return <LanSetting />;
}
