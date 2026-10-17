import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { Textarea } from '@lody/ui/textarea';
import { BOARD_NOTES_MAX_BYTES } from '@lody/shared';
import { MarkdownRenderer } from '@/components/ai-gui/markdown-renderer';
import { boardStyles } from './board-view';

export function BoardNotesEditor({
  notes,
  onSave,
}: {
  notes: string;
  onSave: (text: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const text = draft ?? notes;
  const oversized = new TextEncoder().encode(text).length > BOARD_NOTES_MAX_BYTES;
  return (
    <div {...stylex.props(boardStyles.form)}>
      <div {...stylex.props(boardStyles.controls)}>
        <Button variant="ghost" onClick={() => setPreview(!preview)}>
          {preview ? t('boards.editNotes', 'Edit') : t('boards.previewNotes', 'Preview')}
        </Button>
        <Button
          disabled={draft === null || saving || oversized}
          onClick={() => {
            void (async () => {
              setSaving(true);
              setError(false);
              try {
                await onSave(text);
                setDraft(null);
              } catch {
                setError(true);
              } finally {
                setSaving(false);
              }
            })();
          }}
        >
          {t('boards.saveNotes', 'Save notes')}
        </Button>
      </div>
      {preview ? (
        <MarkdownRenderer text={text} headingAnchors />
      ) : (
        <Textarea
          aria-label={t('boards.notes', 'Shared notes')}
          rows={14}
          value={text}
          disabled={saving}
          onChange={(e) => setDraft(e.target.value)}
        />
      )}
      {oversized || error ? (
        <p role="alert" {...stylex.props(boardStyles.error)}>
          {oversized
            ? t('boards.notesCapacity', 'Notes exceed the 256 KiB limit.')
            : t('boards.notesSaveFailed', 'Could not save notes. Your draft is retained.')}
        </p>
      ) : null}
    </div>
  );
}
