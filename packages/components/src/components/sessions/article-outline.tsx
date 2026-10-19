import * as stylex from '@stylexjs/stylex';
import { useEffect, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { radius, space } from '@lody/ui/tokens/scales.stylex';

type Heading = { readonly element: HTMLElement; readonly level: number; readonly text: string };

const styles = stylex.create({
  root: { position: 'absolute', zIndex: 2, insetInlineStart: space[2], insetBlockStart: space[4] },
  rail: { display: 'flex', flexDirection: 'column', gap: '5px', paddingBlock: space[1] },
  bar: { height: '2px', borderRadius: '1px', backgroundColor: colors.tertiaryLabel },
  list: {
    position: 'absolute',
    insetInlineStart: 0,
    insetBlockStart: 0,
    width: '240px',
    maxHeight: '60vh',
    overflowY: 'auto',
    padding: space[1],
    borderRadius: radius.medium,
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.popover,
  },
  item: {
    display: 'block',
    width: '100%',
    paddingBlock: '4px',
    paddingInlineEnd: space[2],
    borderRadius: radius.small,
    overflow: 'hidden',
    textAlign: 'start',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.8125rem',
    color: { default: colors.secondaryLabel, ':hover': colors.label },
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
  },
});

/**
 * The rendered article's headings as a thin rail; hovering opens them as a
 * list, and a click scrolls to that heading. Nothing shows for fewer than two.
 */
export function ArticleOutline({
  root,
  revision,
}: {
  root: RefObject<HTMLElement | null>;
  /** Changes whenever the rendered document does. */
  revision: string;
}) {
  const { t } = useTranslation();
  const [headings, setHeadings] = useState<readonly Heading[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const found = Array.from(root.current?.querySelectorAll<HTMLElement>('h1, h2, h3') ?? []);
    setHeadings(
      found.map((element) => ({
        element,
        level: Number(element.tagName.slice(1)),
        text: element.textContent?.trim() ?? '',
      }))
    );
  }, [revision, root]);
  if (headings.length < 2) return null;
  return (
    <nav
      aria-label={t('sessions.article.outline', 'Outline')}
      {...stylex.props(styles.root)}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <div {...stylex.props(styles.rail)} aria-hidden>
        {headings.map((heading, index) => (
          <div
            key={index}
            {...stylex.props(styles.bar)}
            style={{ width: 18 - heading.level * 3 }}
          />
        ))}
      </div>
      {open ? (
        <div {...stylex.props(styles.list)}>
          {headings.map((heading, index) => (
            <button
              key={index}
              type="button"
              {...stylex.props(styles.item)}
              style={{ paddingInlineStart: 8 + (heading.level - 1) * 12 }}
              onClick={() => {
                heading.element.scrollIntoView({ block: 'start', behavior: 'smooth' });
                setOpen(false);
              }}
            >
              {heading.text}
            </button>
          ))}
        </div>
      ) : null}
    </nav>
  );
}
