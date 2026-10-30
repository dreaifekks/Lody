import * as stylex from '@stylexjs/stylex';
import { useAtomValue } from 'jotai';
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  Crosshair,
  ExternalLink,
  MessageSquare,
  MessageSquareDot,
  PanelRightClose,
  PanelRightOpen,
  SlidersHorizontal,
  Star,
  TriangleAlert,
} from 'lucide-react';
import type { SessionId } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { Menu } from '@lody/ui/menu';
import { NumberField } from '@lody/ui/number-field';
import { Popover } from '@lody/ui/popover';
import { Tabs } from '@lody/ui/tabs';
import { Textarea } from '@lody/ui/textarea';
import { Toggle } from '@lody/ui/toggle';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { getImageMimeTypeForPath } from '@/lib/image-file-preview';
import type { SessionFileProvider } from '@/lib/session-file-provider';
import { useResolvedTheme } from '@/theme-provider';
import { MarkdownRenderer } from '../ai-gui/markdown-renderer';
import { AnnotationItem } from './article-annotation-markers';
import {
  articleAnnotationsAtom,
  useArticleAnnotationActions,
  type ArticleAnnotation,
} from './article-annotations';
import { ArticleDialogThreadContext } from './board-article-dialog';
import { MAX_PAGE_ERRORS } from '../sessions/article-html-frame';
import {
  CompareHtmlBoard,
  CompareImageBoard,
  type CompareBoardControl,
  type ComparePick,
} from './compare-board-frame';
import {
  compareContentHash,
  parseCompareManifest,
  type CompareManifest,
  type CompareSize,
  type CompareVariant,
} from './compare-manifest';

/** A file of the comparison as read now. */
export type CompareFile =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array; readonly mimeType: string }
  | { readonly kind: 'missing'; readonly message: string };

export type CompareFileReader = (path: string) => Promise<CompareFile>;

/** How often an open comparison looks for the agent's new revisions. */
const RECHECK_MS = 5_000;
const WIDTHS = [1440, 1280, 1024, 834, 390] as const;
const MIN_PAGE_WIDTH = 240;
const MAX_PAGE_WIDTH = 3840;
const ZOOMS = [0.5, 1] as const;
const GAP = 24;
const PADDING = 16;
/** The narrowest an option's header gets, however small the option is drawn. */
const MIN_HEADER = 140;

const styles = stylex.create({
  root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space[2],
    paddingBlock: space[2],
    paddingInline: space[3],
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.separator,
  },
  title: {
    flex: '1 1 160px',
    minWidth: 0,
    margin: 0,
    fontSize: '0.875rem',
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  intro: {
    maxHeight: '22%',
    overflowY: 'auto',
    paddingInline: space[4],
    paddingBlock: space[2],
    fontSize: '0.8125rem',
    color: colors.secondaryLabel,
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.separator,
  },
  draft: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space[2],
    paddingBlock: space[2],
    paddingInline: space[3],
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.separator,
  },
  draftWhere: {
    flexShrink: 0,
    maxWidth: '30%',
    paddingTop: '6px',
    fontSize: '0.75rem',
    color: colors.secondaryLabel,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  draftInput: { flex: '1 1 auto', minWidth: 0 },
  hint: {
    paddingInline: space[3],
    paddingBlock: space[1],
    fontSize: '0.75rem',
    color: colors.secondaryLabel,
  },
  stage: { flex: '1 1 auto', minHeight: 0, overflow: 'auto' },
  boards: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: `${GAP}px`,
    padding: `${PADDING}px`,
    width: 'max-content',
    minWidth: '100%',
    boxSizing: 'border-box',
  },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(2, max-content)' },
  option: { display: 'flex', flexDirection: 'column', gap: space[1], minWidth: 0 },
  head: { display: 'flex', alignItems: 'center', gap: space[1], minWidth: 0, height: '28px' },
  letter: {
    flexShrink: 0,
    minWidth: '20px',
    height: '20px',
    paddingInline: '4px',
    borderRadius: '6px',
    backgroundColor: colors.hoverFill,
    fontSize: '0.75rem',
    fontWeight: 600,
    lineHeight: '20px',
    textAlign: 'center',
  },
  label: {
    flex: '1 1 auto',
    minWidth: 0,
    fontSize: '0.8125rem',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  count: { flexShrink: 0, fontSize: '0.75rem', color: colors.secondaryLabel },
  widths: { display: 'flex', flexDirection: 'column', gap: space[1], width: '168px' },
  widthChoice: { justifyContent: 'flex-start' },
  // Words and the picked star in the label colour: the light accent is too pale for them.
  updated: { color: colors.label },
  changedIcon: { color: colors.accent },
  warning: { color: colors.warning },
  picked: { color: colors.label },
  frame: {
    alignSelf: 'center',
    borderRadius: '6px',
    overflow: 'hidden',
    boxShadow: `0 0 0 1px ${colors.separator}`,
  },
  missing: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: space[3],
    fontSize: '0.75rem',
    color: colors.secondaryLabel,
    textAlign: 'center',
    boxSizing: 'border-box',
  },
  pin: {
    position: 'absolute',
    width: '12px',
    height: '12px',
    marginLeft: '-6px',
    marginTop: '-6px',
    borderRadius: '6px',
    backgroundColor: colors.accent,
    boxShadow: '0 0 0 2px #fff',
    pointerEvents: 'none',
  },
  pinSent: { opacity: 0.55 },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[3],
    width: 'min(320px, 80vw)',
    maxHeight: '50vh',
    overflowY: 'auto',
  },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: space[1] },
  errorList: {
    margin: 0,
    paddingLeft: '18px',
    fontSize: '0.75rem',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    color: colors.secondaryLabel,
    overflowWrap: 'anywhere',
  },
});

interface LoadedVariant {
  readonly variant: CompareVariant;
  readonly hash: string;
  readonly html?: string;
  readonly url?: string;
  readonly missing?: string;
}

interface Loaded {
  readonly manifest: CompareManifest | null;
  readonly error: string | null;
  readonly variants: readonly LoadedVariant[];
  /** Changes only when something read differs. */
  readonly key: string;
}

/**
 * The manifest and its options, reread every few seconds while open so the
 * agent's revisions show. A picture keeps its object URL until its bytes change.
 */
function useCompareFiles(read: CompareFileReader, manifestPath: string): Loaded | null {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const urls = new Map<string, { hash: string; url: string }>();
    const load = async (): Promise<Loaded> => {
      const head = await read(manifestPath);
      if (head.kind !== 'text')
        return {
          manifest: null,
          error: head.kind === 'missing' ? head.message : null,
          variants: [],
          key: `error:${head.kind === 'missing' ? head.message : ''}`,
        };
      const manifest = parseCompareManifest(head.text, manifestPath);
      const files = await Promise.all(manifest.variants.map((variant) => read(variant.path)));
      const variants = manifest.variants.map((variant, index): LoadedVariant => {
        const file = files[index];
        if (file.kind === 'missing') return { variant, hash: 'missing', missing: file.message };
        if (file.kind === 'text') {
          const hash = compareContentHash(file.text);
          return variant.kind === 'html'
            ? { variant, hash, html: file.text }
            : {
                variant,
                hash,
                url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(file.text)}`,
              };
        }
        const hash = compareContentHash(file.bytes);
        let held = urls.get(variant.path);
        if (held?.hash !== hash) {
          if (held) URL.revokeObjectURL(held.url);
          held = {
            hash,
            url: URL.createObjectURL(
              new Blob([Uint8Array.from(file.bytes)], { type: file.mimeType })
            ),
          };
          urls.set(variant.path, held);
        }
        return { variant, hash, url: held.url };
      });
      return {
        manifest,
        error: null,
        variants,
        key: [compareContentHash(head.text), ...variants.map((item) => item.hash)].join(':'),
      };
    };
    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) {
        timer = setTimeout(tick, RECHECK_MS);
        return;
      }
      void load().then(
        (next) => {
          if (stopped) return;
          setLoaded((current) => (current?.key === next.key ? current : next));
          timer = setTimeout(tick, RECHECK_MS);
        },
        (error: unknown) => {
          if (stopped) return;
          setLoaded((current) =>
            current?.manifest
              ? current
              : { manifest: null, error: String(error), variants: [], key: 'failed' }
          );
          timer = setTimeout(tick, RECHECK_MS);
        }
      );
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      for (const held of urls.values()) URL.revokeObjectURL(held.url);
    };
  }, [manifestPath, read]);
  return loaded;
}

type Layout = 'row' | 'grid' | 'single';

const NO_VARIANTS: readonly LoadedVariant[] = [];

/**
 * One scale for a row of options of these widths: the largest that fits the
 * room, counting an option too small for its header at the header's width.
 */
export function fitScale(widths: readonly number[], room: number): number {
  const gaps = GAP * (widths.length - 1);
  let scale = Math.min(1, (room - gaps) / widths.reduce((sum, width) => sum + width, 0));
  for (let pass = 0; pass < widths.length; pass += 1) {
    const free = widths.filter((width) => width * scale >= MIN_HEADER);
    if (free.length === 0) break;
    const held = (widths.length - free.length) * MIN_HEADER;
    const next = Math.min(1, (room - gaps - held) / free.reduce((sum, width) => sum + width, 0));
    if (next === scale) break;
    scale = next;
  }
  return Math.max(0.05, scale);
}
type Mode = 'app' | 'light' | 'dark';

/** Where a new comment goes: an option, and the spot in it the reader pointed at. */
interface Draft {
  /** The option's file: its letter may change when the agent reorders the list. */
  readonly path: string;
  readonly spot?: ComparePick;
}

const quoteOf = (variant: CompareVariant, spot?: ComparePick): string =>
  [
    `${variant.letter} · ${variant.label}`,
    ...(spot ? [spot.label || `(${Math.round(spot.x)}, ${Math.round(spot.y)})`] : []),
  ].join(' · ');

/**
 * Several UI options side by side, from a `.compare.md` manifest
 * (experimental): each laid out at its design size and drawn at one shared
 * scale, so they compare fairly. Side by side and in a grid they share one
 * scroll; one at a time, they flip in place. Scrolling one option's page
 * scrolls the others' to the same place. The reader can comment on an option
 * or a spot in it and pick the one to build on: all of it waits as article
 * comments and goes with the thread's next message (`comments`).
 */
export function BoardCompareView({
  scope,
  manifestPath,
  read,
  comments,
  onOpenInTab,
}: {
  /**
   * Where the files come from (a thread, or a Board's area): two places can
   * hold the same path, and an option's controls come back only to its own.
   */
  scope: string;
  manifestPath: string;
  read: CompareFileReader;
  /** The thread whose next message carries the comments; null where there is none. */
  comments: { readonly threadId: SessionId; readonly ownerThreadId: SessionId } | null;
  onOpenInTab?: () => void;
}) {
  const { t } = useTranslation();
  const loaded = useCompareFiles(read, manifestPath);
  const appMode = useResolvedTheme();
  const threadPane = useContext(ArticleDialogThreadContext);
  const [layoutChoice, setLayout] = useState<Layout | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  // One option's own page width, by file; the width menu above sets them all again.
  const [optionWidths, setOptionWidths] = useState<ReadonlyMap<string, number>>(new Map());
  const [zoom, setZoom] = useState<number | null>(null);
  const [modeChoice, setModeChoice] = useState<Mode>('app');
  const [current, setCurrent] = useState('A');
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftText, setDraftText] = useState('');
  const [seen, setSeen] = useState<ReadonlyMap<string, string>>(new Map());
  const [errors, setErrors] = useState<ReadonlyMap<string, readonly string[]>>(new Map());
  const [stageWidth, setStageWidth] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const controls = useRef(new Map<string, CompareBoardControl>());
  const allAnnotations = useAtomValue(articleAnnotationsAtom);
  const actions = useArticleAnnotationActions();
  const mode = modeChoice === 'app' ? appMode : modeChoice;
  const variants = loaded?.variants ?? NO_VARIANTS;
  const ready = loaded !== null;
  // More than three in a row draws each too small to read: a grid until the reader chooses.
  const layout = layoutChoice ?? (variants.length > 3 ? 'grid' : 'row');

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const measure = () => setStageWidth(stage.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [ready]);

  // The first revision of each option is what "updated" counts from.
  useEffect(() => {
    setSeen((previous) => {
      const missing = variants.filter((item) => !previous.has(item.variant.path));
      if (missing.length === 0) return previous;
      const next = new Map(previous);
      for (const item of missing) next.set(item.variant.path, item.hash);
      return next;
    });
  }, [variants]);

  const annotations = useMemo(
    () =>
      comments
        ? allAnnotations.filter(
            (item) =>
              item.threadId === comments.threadId &&
              item.ownerThreadId === comments.ownerThreadId &&
              item.compare?.manifest === manifestPath
          )
        : [],
    [allAnnotations, comments, manifestPath]
  );
  const sizeOf = (variant: CompareVariant): CompareSize => ({
    width: optionWidths.get(variant.path) ?? width ?? variant.size.width,
    height: variant.size.height,
  });
  const shown =
    layout === 'single'
      ? variants.filter((item) => item.variant.letter === current).slice(0, 1)
      : variants;
  const room = Math.max(0, stageWidth - PADDING * 2);
  const fit = (() => {
    if (shown.length === 0 || room === 0) return 1;
    const widths =
      layout === 'grid'
        ? Array<number>(Math.min(2, shown.length)).fill(
            Math.max(...shown.map((item) => sizeOf(item.variant).width))
          )
        : shown.map((item) => sizeOf(item.variant).width);
    return fitScale(widths, room);
  })();
  const scale = zoom ?? fit;

  const follow = (from: string, top: number) => {
    for (const [path, control] of controls.current) if (path !== from) control.scrollTo(top);
  };
  const choose = (letter: string) => {
    setCurrent(letter);
    setDraft(null);
  };

  const togglePick = (item: LoadedVariant) => {
    if (!comments) return;
    const mine = annotations.find(
      (annotation) =>
        annotation.compare?.pick && !annotation.sent && annotation.path === item.variant.path
    );
    for (const annotation of annotations)
      if (annotation.compare?.pick && !annotation.sent) actions.remove(annotation.id);
    if (mine) return;
    actions.add({
      threadId: comments.threadId,
      ownerThreadId: comments.ownerThreadId,
      path: item.variant.path,
      quote: quoteOf(item.variant),
      comment: t('boards.compare.pickComment', 'Build on this option'),
      block: { index: 0, text: item.hash },
      compare: { manifest: manifestPath, letter: item.variant.letter, pick: true },
    });
  };
  const addComment = (item: LoadedVariant, text: string, spot?: ComparePick) => {
    if (!comments || !text.trim()) return;
    actions.add({
      threadId: comments.threadId,
      ownerThreadId: comments.ownerThreadId,
      path: item.variant.path,
      quote: quoteOf(item.variant, spot),
      comment: text.trim(),
      block: { index: spot ? 1 + Math.round(spot.y) : 0, text: item.hash },
      compare: {
        manifest: manifestPath,
        letter: item.variant.letter,
        ...(spot ? { spot: { x: Math.round(spot.x), y: Math.round(spot.y) } } : {}),
      },
    });
  };
  const draftItem = draft ? variants.find((item) => item.variant.path === draft.path) : undefined;
  const saveDraft = () => {
    if (draft && draftItem) addComment(draftItem, draftText, draft.spot);
    setDraft(null);
    setDraftText('');
  };

  const title = loaded?.manifest?.title ?? manifestPath.split('/').at(-1) ?? manifestPath;
  const widthLabel = width === null ? t('boards.compare.widthOwn', 'Own width') : `${width}px`;

  return (
    <div
      {...stylex.props(styles.root)}
      data-board-compare
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest('textarea, input, [role="menu"]')) return;
        if (event.key === 'Escape' && (picking || draft)) {
          event.preventDefault();
          event.stopPropagation();
          setPicking(false);
          setDraft(null);
          return;
        }
        if (layout !== 'single' || variants.length === 0) return;
        const index = variants.findIndex((item) => item.variant.letter === current);
        const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
        const digit = /^[1-9]$/u.test(event.key) ? Number(event.key) - 1 : -1;
        const next = step !== 0 ? (index + step + variants.length) % variants.length : digit;
        if (next < 0 || next >= variants.length) return;
        event.preventDefault();
        choose(variants[next].variant.letter);
      }}
    >
      <div {...stylex.props(styles.toolbar)}>
        <h2 {...stylex.props(styles.title)} title={manifestPath}>
          {title}
        </h2>
        <Tabs.Root value={layout} onValueChange={(value) => setLayout(value as Layout)}>
          <Tabs.List size="small" aria-label={t('boards.compare.layout', 'Layout')}>
            <Tabs.Tab value="row">{t('boards.compare.row', 'Side by side')}</Tabs.Tab>
            <Tabs.Tab value="grid">{t('boards.compare.grid', 'Grid')}</Tabs.Tab>
            <Tabs.Tab value="single">{t('boards.compare.single', 'One at a time')}</Tabs.Tab>
          </Tabs.List>
        </Tabs.Root>
        <Menu.Root>
          <Menu.Trigger
            aria-label={t('boards.compare.display', 'Display')}
            render={<Button type="button" variant="ghost" size="small" />}
          >
            <SlidersHorizontal size={14} aria-hidden />
            {widthLabel} · {zoom === null ? t('boards.compare.fit', 'Fit') : `${zoom * 100}%`}
          </Menu.Trigger>
          <Menu.Content align="end">
            <Menu.Group>
              <Menu.GroupLabel>{t('boards.compare.width', 'Width')}</Menu.GroupLabel>
              <Menu.RadioGroup
                value={width === null ? 'own' : String(width)}
                onValueChange={(value) => {
                  setWidth(value === 'own' ? null : Number(value));
                  setOptionWidths(new Map());
                }}
              >
                <Menu.RadioItem value="own" indicator="check">
                  {t('boards.compare.widthOwn', 'Own width')}
                </Menu.RadioItem>
                {WIDTHS.map((option) => (
                  <Menu.RadioItem key={option} value={String(option)} indicator="check">
                    {`${option}px`}
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Group>
            <Menu.Separator />
            <Menu.Group>
              <Menu.GroupLabel>{t('boards.compare.zoom', 'Zoom')}</Menu.GroupLabel>
              <Menu.RadioGroup
                value={zoom === null ? 'fit' : String(zoom)}
                onValueChange={(value) => setZoom(value === 'fit' ? null : Number(value))}
              >
                <Menu.RadioItem value="fit" indicator="check">
                  {t('boards.compare.fit', 'Fit')}
                </Menu.RadioItem>
                {ZOOMS.map((option) => (
                  <Menu.RadioItem key={option} value={String(option)} indicator="check">
                    {`${option * 100}%`}
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Group>
            <Menu.Separator />
            <Menu.Group>
              <Menu.GroupLabel>{t('boards.compare.theme', 'Theme')}</Menu.GroupLabel>
              <Menu.RadioGroup
                value={modeChoice}
                onValueChange={(value) => setModeChoice(value as Mode)}
              >
                <Menu.RadioItem value="app" indicator="check">
                  {t('boards.compare.themeApp', 'Like the app')}
                </Menu.RadioItem>
                <Menu.RadioItem value="light" indicator="check">
                  {t('boards.compare.themeLight', 'Light')}
                </Menu.RadioItem>
                <Menu.RadioItem value="dark" indicator="check">
                  {t('boards.compare.themeDark', 'Dark')}
                </Menu.RadioItem>
              </Menu.RadioGroup>
            </Menu.Group>
          </Menu.Content>
        </Menu.Root>
        {comments ? (
          <Toggle
            size="small"
            icon
            pressed={picking}
            onPressedChange={(pressed) => {
              setPicking(pressed);
              if (!pressed && draft?.spot) setDraft(null);
            }}
            aria-label={t('boards.compare.point', 'Comment on a spot')}
            title={t('boards.compare.point', 'Comment on a spot')}
          >
            <Crosshair aria-hidden />
          </Toggle>
        ) : null}
        {threadPane ? (
          <Button
            type="button"
            variant="ghost"
            size="small"
            icon
            aria-label={
              threadPane.hidden
                ? t('boards.compare.showThread', 'Show the conversation')
                : t('boards.compare.hideThread', 'Hide the conversation')
            }
            title={
              threadPane.hidden
                ? t('boards.compare.showThread', 'Show the conversation')
                : t('boards.compare.hideThread', 'Hide the conversation')
            }
            onClick={() => threadPane.setHidden(!threadPane.hidden)}
          >
            {threadPane.hidden ? <PanelRightOpen aria-hidden /> : <PanelRightClose aria-hidden />}
          </Button>
        ) : null}
        {onOpenInTab ? (
          <Button
            type="button"
            variant="ghost"
            size="small"
            icon
            aria-label={t('boards.compare.openInTab', 'Open the list in a tab')}
            title={t('boards.compare.openInTab', 'Open the list in a tab')}
            onClick={onOpenInTab}
          >
            <ExternalLink aria-hidden />
          </Button>
        ) : null}
      </div>
      {loaded?.manifest?.intro ? (
        <div {...stylex.props(styles.intro)}>
          <MarkdownRenderer text={loaded.manifest.intro} />
        </div>
      ) : null}
      {picking && !draft ? (
        <p {...stylex.props(styles.hint)}>
          {t('boards.compare.pointHint', 'Click a spot in an option to comment on it. Esc stops.')}
        </p>
      ) : null}
      {draft && draftItem ? (
        <div {...stylex.props(styles.draft)} data-compare-draft>
          <span {...stylex.props(styles.draftWhere)} title={quoteOf(draftItem.variant, draft.spot)}>
            {quoteOf(draftItem.variant, draft.spot)}
          </span>
          <div {...stylex.props(styles.draftInput)}>
            <Textarea
              resize="none"
              rows={2}
              autoFocus
              aria-label={t('boards.compare.comment', 'Comment')}
              value={draftText}
              maxLength={10_000}
              onChange={(event) => setDraftText(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  saveDraft();
                }
                // Esc stops pointing too, as the hint says.
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  setDraft(null);
                  setPicking(false);
                }
              }}
            />
          </div>
          <Button type="button" size="small" variant="ghost" onClick={() => setDraft(null)}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button type="button" size="small" disabled={!draftText.trim()} onClick={saveDraft}>
            {t('boards.compare.add', 'Add')}
          </Button>
        </div>
      ) : null}
      {layout === 'single' && variants.length > 0 ? (
        <div {...stylex.props(styles.toolbar)}>
          <Tabs.Root value={current} onValueChange={(value) => choose(String(value))}>
            <Tabs.List
              size="small"
              activateOnFocus
              aria-label={t('boards.compare.options', 'Options')}
            >
              {variants.map((item) => (
                <Tabs.Tab
                  key={item.variant.letter}
                  value={item.variant.letter}
                  title={item.variant.label}
                >
                  {item.variant.letter}
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs.Root>
        </div>
      ) : null}
      <div ref={stageRef} {...stylex.props(styles.stage)}>
        {loaded === null ? (
          <p {...stylex.props(styles.hint)}>{t('boards.loading', 'Loading…')}</p>
        ) : !loaded.manifest ? (
          <p {...stylex.props(styles.hint)}>
            {t('boards.compare.unreadable', 'Could not read the list: {{reason}}', {
              reason: loaded.error ?? '',
            })}
          </p>
        ) : variants.length === 0 ? (
          <p {...stylex.props(styles.hint)}>
            {t(
              'boards.compare.empty',
              'No options in this list. Each option is a list item starting with a link to an .html file or a picture.'
            )}
          </p>
        ) : (
          <div {...stylex.props(styles.boards, layout === 'grid' && styles.grid)}>
            {/* Every option stays mounted, one at a time included: flipping keeps each page as it was. */}
            {variants.map((item) => {
              const { variant } = item;
              const size = sizeOf(variant);
              const visible = shown.includes(item);
              // Errors belong to the revision that reported them.
              const revision = `${variant.path}:${item.hash}`;
              const mine = annotations.filter((annotation) => annotation.path === variant.path);
              return (
                <div
                  key={variant.path}
                  {...stylex.props(styles.option)}
                  // An option smaller than its header sits centred under it.
                  style={{
                    width: Math.max(MIN_HEADER, size.width * scale),
                    ...(visible ? {} : { display: 'none' }),
                  }}
                  data-compare-option={variant.letter}
                >
                  <OptionHeader
                    item={item}
                    annotations={mine}
                    updated={seen.has(variant.path) && seen.get(variant.path) !== item.hash}
                    onSeen={() =>
                      setSeen((previous) => new Map(previous).set(variant.path, item.hash))
                    }
                    errors={errors.get(revision) ?? []}
                    commentable={comments !== null}
                    width={size.width}
                    ownWidth={variant.size.width}
                    onWidth={(next) =>
                      setOptionWidths((previous) => new Map(previous).set(variant.path, next))
                    }
                    onPick={() => togglePick(item)}
                    onComment={(text) => addComment(item, text)}
                    onAttachErrors={(list) => {
                      if (!comments) return;
                      actions.add({
                        threadId: comments.threadId,
                        ownerThreadId: comments.ownerThreadId,
                        path: variant.path,
                        quote: list.join('\n'),
                        comment: t(
                          'sessions.article.pageErrors.comment',
                          'The page reported these errors.'
                        ),
                        block: { index: -1, text: '' },
                      });
                      setErrors((previous) => new Map(previous).set(revision, []));
                    }}
                  />
                  <div {...stylex.props(styles.frame)}>
                    <OptionBoard
                      key={revision}
                      scope={scope}
                      item={item}
                      size={size}
                      scale={scale}
                      mode={mode}
                      picking={picking && comments !== null && visible}
                      register={(control) => {
                        if (control) controls.current.set(variant.path, control);
                        else controls.current.delete(variant.path);
                      }}
                      onScroll={(top, own) => {
                        if (own) follow(variant.path, top);
                      }}
                      onPick={(spot) => {
                        setDraft({ path: variant.path, spot });
                        setDraftText('');
                      }}
                      onError={(message) =>
                        setErrors((previous) => {
                          const list = previous.get(revision) ?? [];
                          if (list.includes(message) || list.length >= MAX_PAGE_ERRORS)
                            return previous;
                          return new Map(previous).set(revision, [...list, message]);
                        })
                      }
                      overlay={(scrollTop) =>
                        [
                          ...mine.filter((annotation) => annotation.compare?.spot),
                          ...(draft?.path === variant.path && draft.spot
                            ? [{ id: 'draft', compare: { spot: draft.spot } } as const]
                            : []),
                        ].map((annotation) => {
                          const spot = annotation.compare!.spot!;
                          return (
                            <span
                              key={annotation.id}
                              {...stylex.props(
                                styles.pin,
                                'sent' in annotation && annotation.sent ? styles.pinSent : null
                              )}
                              style={{ left: spot.x * scale, top: (spot.y - scrollTop) * scale }}
                              title={'comment' in annotation ? annotation.comment : undefined}
                              data-compare-pin
                            />
                          );
                        })
                      }
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function OptionBoard({
  scope,
  item,
  onError,
  ...board
}: {
  scope: string;
  item: LoadedVariant;
  size: CompareSize;
  scale: number;
  mode: 'light' | 'dark';
  picking: boolean;
  register: (control: CompareBoardControl | null) => void;
  onScroll: (top: number, own: boolean) => void;
  onPick: (pick: ComparePick) => void;
  onError: (message: string) => void;
  overlay: (scrollTop: number) => ReactNode;
}) {
  const { t } = useTranslation();
  if (item.html !== undefined)
    return (
      <CompareHtmlBoard
        {...board}
        title={item.variant.label}
        html={item.html}
        stateKey={`compare:${scope}:${item.variant.path}`}
        onError={onError}
      />
    );
  if (item.url !== undefined)
    return <CompareImageBoard {...board} title={item.variant.label} url={item.url} />;
  return (
    <div
      {...stylex.props(styles.missing)}
      style={{
        width: board.size.width * board.scale,
        height: Math.max(80, board.size.height * board.scale),
      }}
    >
      {t('boards.compare.missing', 'Could not read {{path}}: {{reason}}', {
        path: item.variant.path,
        reason: item.missing ?? '',
      })}
    </div>
  );
}

/**
 * An option's name over it, with what the reader can do about it: pick it,
 * read and add comments, see that the agent has rewritten it, and its page's errors.
 */
function OptionHeader({
  item,
  annotations,
  updated,
  onSeen,
  errors,
  commentable,
  onPick,
  onComment,
  onAttachErrors,
  width,
  ownWidth,
  onWidth,
}: {
  /** The page width it is laid out at now, and the one its list gives it. */
  width: number;
  ownWidth: number;
  onWidth: (width: number) => void;
  item: LoadedVariant;
  annotations: readonly ArticleAnnotation[];
  updated: boolean;
  onSeen: () => void;
  errors: readonly string[];
  commentable: boolean;
  onPick: () => void;
  onComment: (text: string) => void;
  onAttachErrors: (errors: readonly string[]) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const { variant } = item;
  const picked = annotations.some((annotation) => annotation.compare?.pick && !annotation.sent);
  const changed = (annotation: ArticleAnnotation) =>
    annotation.sent !== undefined && annotation.block.text !== item.hash;
  const commentsLabel = t('sessions.article.annotation.count', 'Comments ({{count}})', {
    count: annotations.length,
  });
  return (
    <div {...stylex.props(styles.head)}>
      <span {...stylex.props(styles.letter)}>{variant.letter}</span>
      <span
        {...stylex.props(styles.label)}
        title={variant.note ? `${variant.label} — ${variant.note}` : variant.label}
      >
        {variant.label}
      </span>
      <OptionWidth width={width} ownWidth={ownWidth} onWidth={onWidth} />
      {updated ? (
        <Button
          type="button"
          size="mini"
          variant="ghost"
          onClick={onSeen}
          title={t(
            'boards.compare.updatedHint',
            'The agent rewrote this option. Click to mark it seen.'
          )}
        >
          <span {...stylex.props(styles.updated)}>{t('boards.compare.updated', 'Updated')}</span>
        </Button>
      ) : null}
      {errors.length > 0 ? (
        <Popover.Root>
          <Popover.Trigger
            render={
              <Button
                type="button"
                size="mini"
                variant="ghost"
                icon
                aria-label={t(
                  'sessions.article.pageErrors.count',
                  'The page reported {{count}} errors',
                  {
                    count: errors.length,
                  }
                )}
              />
            }
          >
            <TriangleAlert size={14} aria-hidden {...stylex.props(styles.warning)} />
          </Popover.Trigger>
          <Popover.Content side="bottom" align="end">
            <div {...stylex.props(styles.list)}>
              <ol {...stylex.props(styles.errorList)}>
                {errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ol>
              {commentable ? (
                <div {...stylex.props(styles.actions)}>
                  <Button
                    type="button"
                    size="mini"
                    variant="ghost"
                    onClick={() => onAttachErrors(errors)}
                  >
                    {t('sessions.article.pageErrors.attach', 'Add to the next message')}
                  </Button>
                </div>
              ) : null}
            </div>
          </Popover.Content>
        </Popover.Root>
      ) : null}
      {commentable ? (
        <>
          <Popover.Root>
            <Popover.Trigger
              render={
                <Button type="button" size="mini" variant="ghost" icon aria-label={commentsLabel} />
              }
            >
              {annotations.some(changed) && !annotations.some((annotation) => !annotation.sent) ? (
                <MessageSquareDot size={14} aria-hidden {...stylex.props(styles.changedIcon)} />
              ) : (
                <MessageSquare size={14} aria-hidden />
              )}
            </Popover.Trigger>
            <Popover.Content side="bottom" align="end">
              <div {...stylex.props(styles.list)} aria-label={commentsLabel} role="list">
                {annotations.map((annotation) => (
                  <AnnotationItem
                    key={annotation.id}
                    annotation={annotation}
                    changed={changed(annotation)}
                  />
                ))}
                <Textarea
                  resize="none"
                  rows={2}
                  aria-label={t('boards.compare.commentOption', 'Comment on this option')}
                  placeholder={t('boards.compare.commentOption', 'Comment on this option')}
                  value={text}
                  maxLength={10_000}
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && text.trim()) {
                      event.preventDefault();
                      onComment(text);
                      setText('');
                    }
                  }}
                />
                <div {...stylex.props(styles.actions)}>
                  <Button
                    type="button"
                    size="mini"
                    disabled={!text.trim()}
                    onClick={() => {
                      onComment(text);
                      setText('');
                    }}
                  >
                    {t('boards.compare.add', 'Add')}
                  </Button>
                </div>
              </div>
            </Popover.Content>
          </Popover.Root>
          {annotations.length > 0 ? (
            <span {...stylex.props(styles.count)} aria-hidden>
              {annotations.length}
            </span>
          ) : null}
          <Toggle
            size="mini"
            icon
            pressed={picked}
            onPressedChange={onPick}
            aria-label={t('boards.compare.pick', 'Build on this option')}
            title={t('boards.compare.pick', 'Build on this option')}
          >
            <Star
              aria-hidden
              fill={picked ? 'currentColor' : 'none'}
              {...stylex.props(picked && styles.picked)}
            />
          </Toggle>
        </>
      ) : null}
    </div>
  );
}

/** Reads a comparison's files from a thread's workspace, as its file viewer does. */
export function useSessionCompareReader(
  provider: SessionFileProvider | null
): CompareFileReader | null {
  return useMemo(
    () =>
      provider
        ? async (path: string): Promise<CompareFile> => {
            const opened = await provider.openFile(path);
            if (opened.status !== 'ready')
              return { kind: 'missing', message: opened.message ?? opened.reason };
            const { snapshot } = opened;
            if (snapshot.kind === 'text') return { kind: 'text', text: snapshot.text };
            if (snapshot.kind === 'binary')
              return {
                kind: 'bytes',
                bytes:
                  snapshot.bytes ??
                  new Uint8Array(await (await fetch(snapshot.url!)).arrayBuffer()),
                mimeType:
                  snapshot.mimeType ?? getImageMimeTypeForPath(path) ?? 'application/octet-stream',
              };
            return {
              kind: 'missing',
              message:
                snapshot.kind === 'unavailable'
                  ? (snapshot.message ?? snapshot.reason)
                  : 'too large',
            };
          }
        : null,
    [provider]
  );
}

/** A thread's comparison in the article window: its files from the thread's workspace. */
export function SessionBoardCompareView({
  fileProvider,
  ...view
}: Omit<Parameters<typeof BoardCompareView>[0], 'read'> & {
  fileProvider: SessionFileProvider | null;
}) {
  const { t } = useTranslation();
  const read = useSessionCompareReader(fileProvider);
  return read ? (
    <BoardCompareView {...view} read={read} />
  ) : (
    <p {...stylex.props(styles.hint)}>{t('boards.loading', 'Loading…')}</p>
  );
}

/**
 * One option's page width: what it is laid out at now, and the choices — the
 * list's own, the presets, or any width typed in.
 */
function OptionWidth({
  width,
  ownWidth,
  onWidth,
}: {
  width: number;
  ownWidth: number;
  onWidth: (width: number) => void;
}) {
  const { t } = useTranslation();
  const label = t('boards.compare.optionWidth', 'Page width: {{width}}px', { width });
  const choice = (value: number, text: string) => (
    <Button
      key={text}
      type="button"
      size="mini"
      variant={value === width ? 'secondary' : 'ghost'}
      {...stylex.props(styles.widthChoice)}
      onClick={() => onWidth(value)}
    >
      {text}
    </Button>
  );
  return (
    <Popover.Root>
      <Popover.Trigger
        render={
          <Button type="button" size="mini" variant="ghost" aria-label={label} title={label} />
        }
      >
        <span {...stylex.props(styles.count)}>{width}</span>
      </Popover.Trigger>
      <Popover.Content side="bottom" align="end">
        <div {...stylex.props(styles.widths)}>
          {choice(
            ownWidth,
            t('boards.compare.widthOwnValue', 'Own width · {{width}}px', { width: ownWidth })
          )}
          {WIDTHS.map((option) => choice(option, `${option}px`))}
          <NumberField.Root
            key={width}
            defaultValue={width}
            min={MIN_PAGE_WIDTH}
            max={MAX_PAGE_WIDTH}
            step={10}
            onValueCommitted={(next) => {
              if (next !== null) onWidth(next);
            }}
          >
            <NumberField.Group>
              <NumberField.Input
                aria-label={t('boards.compare.widthCustom', 'Custom width (px)')}
                // The field commits on blur; Enter is how a typed width is meant to land.
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
              />
            </NumberField.Group>
          </NumberField.Root>
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}
