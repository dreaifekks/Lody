import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatBtwFileName, type BtwSelectionAttachment } from './btw-atoms';
import { BTW_ACCENT_TEXT_CLASS } from './btw-info-bar-toggle';

export function BtwComposerFooter({
  modelLabel,
  articleFileName,
}: {
  readonly modelLabel: string;
  readonly articleFileName?: string | null;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
      <span
        data-btw-model-pill=""
        className={cn(
          'inline-flex max-w-full shrink-0 items-center truncate rounded-md bg-primary/12 px-2 py-0.5 text-[11px] font-medium',
          BTW_ACCENT_TEXT_CLASS
        )}
      >
        {modelLabel}
      </span>
      {articleFileName ? (
        <span
          data-btw-article-pill=""
          className="inline-flex min-w-0 max-w-[11rem] items-center truncate rounded-md bg-foreground/[0.06] px-2 py-0.5 text-[11px] text-foreground/75 dark:bg-white/[0.07] dark:text-muted-foreground"
          title={articleFileName}
        >
          {articleFileName}
        </span>
      ) : null}
    </div>
  );
}

export function BtwPendingSelectionChip({
  selection,
  onRemove,
}: {
  readonly selection: BtwSelectionAttachment;
  readonly onRemove?: () => void;
}) {
  const fileName = formatBtwFileName(selection.path) ?? selection.path;
  return (
    <div className="flex flex-wrap items-center gap-1.5 pb-1">
      <span
        data-btw-pending-selection=""
        className={cn(
          'inline-flex max-w-full items-center gap-1 rounded-md bg-primary/12 px-2 py-0.5 text-[11px]',
          BTW_ACCENT_TEXT_CLASS
        )}
        title={selection.text}
      >
        <span className="truncate">{fileName} 选区</span>
        {onRemove ? (
          <button
            type="button"
            aria-label="移除选区引用"
            onClick={onRemove}
            className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm hover:bg-primary/20"
          >
            <X className="h-2.5 w-2.5" aria-hidden="true" />
          </button>
        ) : null}
      </span>
    </div>
  );
}
