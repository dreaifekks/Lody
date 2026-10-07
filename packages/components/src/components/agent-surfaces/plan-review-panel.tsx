import { useCallback, useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { MessageSquarePlus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Textarea } from '@lody/ui/textarea';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space } from '@lody/ui/tokens/scales.stylex';
import type { LodyRequestReviewInput } from '@lody/shared';
import { MarkdownRenderer } from '@/components/ai-gui/markdown-renderer';
import { planReviewStatusLabel } from './plan-review-card';
import {
  buildPlanReviewDecisionMessage,
  planReviewIndexAtomFamily,
  type PlanReviewComment,
  type PlanReviewDecision,
  type PlanReviewStatus,
} from './plan-review-model';

const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    backgroundColor: colors.background,
  },
  header: {
    display: 'flex',
    alignItems: 'baseline',
    gap: space[2],
    paddingBlock: space[3],
    paddingInline: space[4],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: colors.separator,
  },
  titleBlock: { display: 'flex', flexDirection: 'column', gap: space[1], minWidth: 0, flexGrow: 1 },
  title: { fontSize: '14px', fontWeight: 500, color: colors.label, overflowWrap: 'anywhere' },
  summary: { fontSize: '12px', color: colors.secondaryLabel },
  status: { flexShrink: 0, fontSize: '12px', color: colors.secondaryLabel },
  body: {
    position: 'relative',
    flexGrow: 1,
    minHeight: 0,
    overflowY: 'auto',
    paddingBlock: space[3],
    paddingInline: space[4],
  },
  commentButton: { position: 'absolute', zIndex: 2 },
  draft: {
    position: 'absolute',
    zIndex: 2,
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    width: 'min(320px, calc(100% - 32px))',
    padding: space[2],
    borderRadius: radius.small,
    backgroundColor: colors.raisedBackground,
    boxShadow: '0 4px 16px rgb(0 0 0 / 0.16)',
  },
  draftActions: { display: 'flex', justifyContent: 'flex-end', gap: space[2] },
  footer: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    paddingBlock: space[3],
    paddingInline: space[4],
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.separator,
  },
  comments: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1.5],
    maxHeight: '30vh',
    overflowY: 'auto',
  },
  comment: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space[2],
    paddingBlock: space[1.5],
    paddingInline: space[2],
    borderRadius: radius.small,
    backgroundColor: colors.wellBackground,
    fontSize: '12px',
  },
  commentText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flexGrow: 1 },
  quote: {
    color: colors.secondaryLabel,
    overflow: 'hidden',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
  },
  commentBody: { color: colors.label, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: space[2] },
});

type Point = { top: number; left: number };

/**
 * A plan in the side panel. Selecting text offers a comment; the two buttons
 * send the decision, with every commented passage quoted, as the user's next
 * message. Only the latest plan of a conversation the viewer may answer has
 * buttons.
 */
export function PlanReviewPanel({
  sessionId,
  toolCallId,
  canAct,
  onSubmit,
}: {
  sessionId: string;
  toolCallId: string;
  canAct: boolean;
  /** Sends the message; resolves false when it was not accepted. */
  onSubmit: (decision: PlanReviewDecision, text: string) => Promise<boolean>;
}) {
  const index = useAtomValue(planReviewIndexAtomFamily(sessionId));
  const entry = index.byId.get(toolCallId);
  if (!entry) return null;
  return (
    <PlanReviewPanelView
      // A different plan starts with no comments.
      key={toolCallId}
      input={entry.input}
      status={entry.status}
      canAct={canAct}
      onSubmit={onSubmit}
    />
  );
}

export function PlanReviewPanelView({
  input,
  status,
  canAct,
  onSubmit,
}: {
  input: LodyRequestReviewInput;
  status: PlanReviewStatus;
  canAct: boolean;
  onSubmit: (decision: PlanReviewDecision, text: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [comments, setComments] = useState<PlanReviewComment[]>([]);
  const [note, setNote] = useState('');
  const [selection, setSelection] = useState<{ quote: string; at: Point } | null>(null);
  const [draft, setDraft] = useState<{ quote: string; at: Point; body: string } | null>(null);
  const [sending, setSending] = useState(false);
  const decides = canAct && status === 'pending';

  const readSelection = useCallback(() => {
    const body = bodyRef.current;
    const current = window.getSelection();
    if (!decides || !body || !current || current.isCollapsed || current.rangeCount === 0) {
      setSelection(null);
      return;
    }
    const range = current.getRangeAt(0);
    const quote = current.toString().trim();
    if (!quote || !body.contains(range.commonAncestorContainer)) {
      setSelection(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    const frame = body.getBoundingClientRect();
    setSelection({
      quote,
      at: {
        top: rect.bottom - frame.top + body.scrollTop + 4,
        left: Math.max(0, Math.min(rect.left - frame.left, frame.width - 140)),
      },
    });
  }, [decides]);

  useEffect(() => {
    const onSelectionChange = () => {
      if (window.getSelection()?.isCollapsed) setSelection(null);
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, []);

  const saveDraft = () => {
    if (!draft) return;
    setComments((previous) => [
      ...previous,
      { id: `${Date.now()}-${previous.length}`, quote: draft.quote, body: draft.body },
    ]);
    setDraft(null);
  };

  const decide = async (decision: PlanReviewDecision) => {
    if (sending) return;
    const lead =
      decision === 'approve'
        ? comments.length > 0
          ? t(
              'agentSurfaces.planReview.approveWithCommentsLead',
              'I approve the plan "{{title}}". Implement it, taking these comments into account:',
              { title: input.title }
            )
          : t(
              'agentSurfaces.planReview.approveLead',
              'I approve the plan "{{title}}". Go ahead and implement it.',
              { title: input.title }
            )
        : t(
            'agentSurfaces.planReview.requestChangesLead',
            'Please revise the plan "{{title}}" and submit it for review again:',
            { title: input.title }
          );
    setSending(true);
    try {
      const accepted = await onSubmit(
        decision,
        buildPlanReviewDecisionMessage({ lead, comments, note })
      );
      if (accepted) {
        setComments([]);
        setNote('');
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div data-plan-review-panel {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.titleBlock)}>
          <span {...stylex.props(styles.title)}>{input.title}</span>
          {input.summary ? <span {...stylex.props(styles.summary)}>{input.summary}</span> : null}
        </div>
        {/* The buttons say it is waiting; otherwise say what happened. */}
        {decides ? null : (
          <span role="status" {...stylex.props(styles.status)}>
            {planReviewStatusLabel(t, status)}
          </span>
        )}
      </div>
      <div
        ref={bodyRef}
        onMouseUp={readSelection}
        onKeyUp={readSelection}
        {...stylex.props(styles.body)}
      >
        <MarkdownRenderer text={input.markdown} headingAnchors />
        {selection && !draft ? (
          <div
            {...stylex.props(styles.commentButton)}
            style={{ top: selection.at.top, left: selection.at.left }}
          >
            <Button
              variant="secondary"
              size="small"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setDraft({ quote: selection.quote, at: selection.at, body: '' });
                setSelection(null);
              }}
            >
              <MessageSquarePlus aria-hidden="true" />
              {t('agentSurfaces.planReview.comment', 'Comment')}
            </Button>
          </div>
        ) : null}
        {draft ? (
          <div {...stylex.props(styles.draft)} style={{ top: draft.at.top, left: draft.at.left }}>
            <Textarea
              autoFocus
              rows={3}
              value={draft.body}
              placeholder={t('agentSurfaces.planReview.commentPlaceholder', 'Your comment')}
              onChange={(event) => setDraft({ ...draft, body: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setDraft(null);
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) saveDraft();
              }}
            />
            <div {...stylex.props(styles.draftActions)}>
              <Button variant="ghost" size="small" onClick={() => setDraft(null)}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button
                variant="primary"
                size="small"
                disabled={!draft.body.trim()}
                onClick={saveDraft}
              >
                {t('agentSurfaces.planReview.addComment', 'Add comment')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
      {decides ? (
        <div {...stylex.props(styles.footer)}>
          {comments.length > 0 ? (
            <div {...stylex.props(styles.comments)}>
              {comments.map((comment) => (
                <div key={comment.id} data-plan-review-comment {...stylex.props(styles.comment)}>
                  <div {...stylex.props(styles.commentText)}>
                    <span {...stylex.props(styles.quote)}>&ldquo;{comment.quote}&rdquo;</span>
                    <span {...stylex.props(styles.commentBody)}>{comment.body}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="mini"
                    icon
                    aria-label={t('agentSurfaces.planReview.removeComment', 'Remove comment')}
                    onClick={() =>
                      setComments((previous) => previous.filter((item) => item.id !== comment.id))
                    }
                  >
                    <X aria-hidden="true" />
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
          <Textarea
            rows={2}
            value={note}
            placeholder={t('agentSurfaces.planReview.notePlaceholder', 'Anything else (optional)')}
            onChange={(event) => setNote(event.target.value)}
          />
          <div {...stylex.props(styles.actions)}>
            <Button
              variant="secondary"
              disabled={sending}
              onClick={() => void decide('request_changes')}
            >
              {t('agentSurfaces.planReview.requestChanges', 'Request changes')}
            </Button>
            <Button variant="primary" disabled={sending} onClick={() => void decide('approve')}>
              {t('agentSurfaces.planReview.approve', 'Approve')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
