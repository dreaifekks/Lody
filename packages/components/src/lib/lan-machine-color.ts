import type { CSSProperties } from 'react';
import { normalizeLanMachineColor, type LanMachineColor } from '@lody/shared/lan-control';

/** The shade of a machine color in the current theme (`--lan-machine-*` in index.css). */
export function lanMachineColorValue(color: LanMachineColor): string {
  return `hsl(var(--lan-machine-${color}))`;
}

/** The text color a member gave a machine's name; nothing for none or an unknown one. */
export function lanMachineNameStyle(color: unknown): CSSProperties | undefined {
  const known = normalizeLanMachineColor(color);
  return known ? { color: lanMachineColorValue(known) } : undefined;
}
