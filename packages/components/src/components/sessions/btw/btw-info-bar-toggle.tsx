import { CircleAlert, Hand, MessageCircle, MessageCircleDashed, X } from 'lucide-react';
import { Tooltip } from '@lody/ui/tooltip';
import { cn } from '@/lib/utils';
import { commands, formatKeyBinding } from '@/lib/commands';
import type { MainConversationStatus } from './main-conversation-status';

export const BTW_SURFACE_BG_CLASS =
  'bg-[color-mix(in_srgb,hsl(var(--primary))_3.5%,hsl(var(--background)))] dark:bg-[color-mix(in_srgb,hsl(var(--primary))_5%,hsl(var(--background)))]';

export const BTW_SURFACE_BG_OVERRIDE_CLASS =
  '!bg-[color-mix(in_srgb,hsl(var(--primary))_3.5%,hsl(var(--background)))] dark:!bg-[color-mix(in_srgb,hsl(var(--primary))_5%,hsl(var(--background)))]';

/**
 * High-contrast primary accent text for small `/btw` chips and pills on tinted
 * light surfaces (WCAG AA >= 4.5:1 in Lody Light) while keeping native `text-primary`
 * in dark themes.
 */
export const BTW_ACCENT_TEXT_CLASS =
  'text-[color-mix(in_srgb,hsl(var(--primary))_60%,hsl(var(--foreground)))] dark:text-primary';

export type BtwInfoBarToggleProps = {
  readonly isOpen: boolean;
  readonly isBtwStreaming: boolean;
  readonly hasBtwUnread: boolean;
  readonly btwTurnCount: number;
  readonly mainStatus: MainConversationStatus;
  readonly onToggle: () => void;
};

const BASE_CHIP_CLASS =
  'relative inline-flex h-6 w-6 shrink-0 select-none items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

function getBtwShortcutHint(): string {
  const binding = commands.getKeybindingsFor('session.toggleBtw')[0];
  return binding ? formatKeyBinding(binding) : '⌘/';
}

export function BtwInfoBarToggle({
  isOpen,
  isBtwStreaming,
  hasBtwUnread,
  btwTurnCount,
  mainStatus,
  onToggle,
}: BtwInfoBarToggleProps) {
  let toneClass: string;
  let tooltip: string;
  let iconNode: React.ReactNode;
  let cornerDot: React.ReactNode = null;
  let statusAttr: string;

  if (!isOpen) {
    if (isBtwStreaming) {
      statusAttr = 'btw-streaming';
      toneClass = 'bg-primary/12 text-primary hover:bg-primary/20';
      tooltip = '/btw 回复中…';
      cornerDot = (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-[3px] top-[3px] h-[5.5px] w-[5.5px] animate-pulse rounded-full bg-primary ring-[1.5px] ring-[hsl(var(--composer))] dark:ring-input"
        />
      );
    } else if (hasBtwUnread) {
      statusAttr = 'btw-unread';
      toneClass = 'text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground';
      tooltip = '/btw 有新回复';
      cornerDot = (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-[3px] top-[3px] h-[5.5px] w-[5.5px] rounded-full bg-primary ring-[1.5px] ring-[hsl(var(--composer))] dark:ring-input"
        />
      );
    } else if (btwTurnCount > 0) {
      statusAttr = 'btw-history';
      toneClass = 'text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground';
      tooltip = `/btw (${btwTurnCount} 轮)`;
      cornerDot = (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-[3px] top-[3px] h-[5.5px] w-[5.5px] rounded-full bg-primary/55 ring-[1.5px] ring-[hsl(var(--composer))] dark:ring-input"
        />
      );
    } else {
      statusAttr = 'btw-idle';
      toneClass = 'text-muted-foreground hover:bg-muted-foreground/10 hover:text-foreground';
      tooltip = `/btw 临时旁白 (${getBtwShortcutHint()})`;
    }
    iconNode = <MessageCircleDashed className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />;
  } else {
    statusAttr = `main-${mainStatus.kind}`;
    tooltip = mainStatus.tooltip;
    switch (mainStatus.kind) {
      case 'waiting':
        toneClass = 'bg-status-warning/15 text-status-warning hover:bg-status-warning/25';
        iconNode = <Hand className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />;
        break;
      case 'working':
        toneClass = 'bg-primary/12 text-primary hover:bg-primary/20';
        iconNode = (
          <MessageCircle className="h-3.5 w-3.5 shrink-0 animate-pulse" aria-hidden="true" />
        );
        break;
      case 'done':
        toneClass = 'bg-status-success/13 text-status-success hover:bg-status-success/20';
        iconNode = <MessageCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />;
        break;
      case 'error':
        toneClass = 'bg-destructive/13 text-destructive hover:bg-destructive/20';
        iconNode = <CircleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />;
        break;
      case 'idle':
      default:
        toneClass = 'bg-muted-foreground/10 text-foreground hover:bg-muted-foreground/15';
        iconNode = <MessageCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />;
        break;
    }
  }

  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <button
            type="button"
            data-btw-toggle=""
            data-btw-open={isOpen ? 'true' : 'false'}
            data-btw-status={statusAttr}
            aria-label={tooltip}
            aria-pressed={isOpen}
            onClick={onToggle}
            className={cn(BASE_CHIP_CLASS, toneClass)}
          >
            {iconNode}
            {cornerDot}
          </button>
        }
      />
      <Tooltip.Content side="top">{tooltip}</Tooltip.Content>
    </Tooltip.Root>
  );
}

export function BtwInfoBarClearButton({ onClear }: { readonly onClear: () => void }) {
  const label = '清空 /btw';
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <button
            type="button"
            data-btw-clear=""
            aria-label={label}
            onClick={onClear}
            className={cn(
              BASE_CHIP_CLASS,
              'text-muted-foreground/75 hover:bg-muted-foreground/10 hover:text-foreground'
            )}
          >
            <X className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          </button>
        }
      />
      <Tooltip.Content side="top">{label}</Tooltip.Content>
    </Tooltip.Root>
  );
}
