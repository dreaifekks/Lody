import { useContext, useMemo, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { radius } from '@lody/ui/tokens/scales.stylex';
import { ZoomableImageViewer } from '@/components/shared/zoomable-image-viewer';
import { SessionImagePreviewContext } from './session-image-preview-context';

const styles = stylex.create({
  frame: {
    display: 'block',
    width: '100%',
    borderWidth: 0,
    padding: 0,
    backgroundColor: 'transparent',
    cursor: 'zoom-in',
  },
  image: {
    display: 'block',
    width: '100%',
    maxHeight: '20rem',
    borderRadius: radius.small,
    objectFit: 'contain',
  },
});

/** A picture a tool call returned: it opens in the gallery of its turn, or alone where none holds it. */
export function ToolContentImage({
  src,
  alt,
  galleryKey,
}: {
  src: string;
  alt: string;
  galleryKey: string;
}) {
  const preview = useContext(SessionImagePreviewContext);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const images = useMemo(() => [{ key: galleryKey, src }], [galleryKey, src]);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => {
          if (!preview?.openImagePreview(galleryKey)) setOpen(true);
        }}
        {...stylex.props(styles.frame)}
      >
        <img src={src} alt={alt} {...stylex.props(styles.image)} />
      </button>
      <ZoomableImageViewer
        open={open}
        onClose={() => setOpen(false)}
        images={images}
        index={0}
        portalAnchorRef={anchorRef}
      />
    </>
  );
}
