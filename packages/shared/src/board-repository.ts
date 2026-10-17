import type { LoroDoc } from 'loro-crdt';

export const BOARD_DOC_PREFIX = 'board-';
export const BOARD_NOTES_MAX_BYTES = 256 * 1024;
export const getBoardRoomId = (id: string): string => `${BOARD_DOC_PREFIX}${id}`;
export type BoardDocument = {
  notes: string;
  meta: { updatedAtMs?: number; updatedBy?: string };
};

/** One LoroText, shared by renderer and daemon; concurrent appends remain separate operations. */
export function readBoardDocument(doc: LoroDoc): BoardDocument {
  const meta = doc.getMap('meta');
  return {
    notes: doc.getText('notes').toString(),
    meta: {
      updatedAtMs: meta.get('updatedAtMs') as number | undefined,
      updatedBy: meta.get('updatedBy') as string | undefined,
    },
  };
}

export function writeBoardNotes(
  doc: LoroDoc,
  input: { kind: 'append' | 'replace'; text: string; updatedBy: string; now: number }
): BoardDocument {
  const notes = doc.getText('notes');
  const next = input.kind === 'append' ? notes.toString() + input.text : input.text;
  if (new TextEncoder().encode(next).byteLength > BOARD_NOTES_MAX_BYTES)
    throw new Error('BOARD_NOTES_CAPACITY');
  // No await between capacity check and mutation. Replace deletes only the text
  // this replica has seen; an unseen concurrent append survives CRDT merge.
  if (input.kind === 'replace') notes.delete(0, notes.length);
  notes.insert(notes.length, input.text);
  const meta = doc.getMap('meta');
  meta.set('updatedAtMs', input.now);
  meta.set('updatedBy', input.updatedBy);
  doc.commit();
  return readBoardDocument(doc);
}
