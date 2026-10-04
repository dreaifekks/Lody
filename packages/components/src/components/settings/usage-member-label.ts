import { createContext, useContext } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * What the usage page calls the second split of its numbers. The hosted page
 * splits by member; a LAN, whose members are one user, splits by machine.
 */
export const UsageMemberLabelContext = createContext<string | undefined>(undefined);

export function useUsageMemberLabel(): string {
  const { t } = useTranslation();
  return useContext(UsageMemberLabelContext) ?? t('workspace.usage.byUser');
}
