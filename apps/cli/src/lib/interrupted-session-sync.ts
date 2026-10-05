import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { SessionId } from '@lody/shared';

import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';

/**
 * Sessions whose turn this daemon's own shutdown cut off.
 *
 * Their last writes — the finalized reply and the "Lody restarted" notice —
 * land while a LAN self-update is restarting the hub too, so they stay in the
 * local store. After the restart nothing reopens such a session until the user
 * sends to it again, so the conversation kept showing a running turn and only
 * learned it was interrupted from that next send. The ids are kept in a
 * machine-local marker, and the next daemon reopens those documents once the
 * transport is back; joining the room pushes what the hub has not seen.
 */
export type InterruptedSessionSync = {
  /** Adds sessions to the marker; called before the agents are stopped. */
  record(sessionIds: readonly SessionId[]): Promise<void>;
  /**
   * Pushes every recorded session. A session stays recorded until its
   * document confirms the push, so a hub that is still restarting is retried
   * on the next call.
   */
  flush(): Promise<void>;
};

export function createInterruptedSessionSync(options: {
  filePath: string;
  logger: Logger;
  /** Opens the session's document and reports whether its writes reached the peer. */
  pushSession: (sessionId: SessionId) => Promise<boolean>;
}): InterruptedSessionSync {
  const { filePath, logger } = options;
  let inFlight: Promise<void> | null = null;

  const read = async (): Promise<SessionId[]> => {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((id): id is SessionId => typeof id === 'string' && id.length > 0)
        : [];
    } catch {
      return [];
    }
  };

  const write = async (sessionIds: readonly SessionId[]): Promise<void> => {
    if (sessionIds.length === 0) {
      await rm(filePath, { force: true });
      return;
    }
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(sessionIds)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporaryPath, filePath);
  };

  const flushOnce = async (): Promise<void> => {
    const recorded = await read();
    if (recorded.length === 0) return;
    const pending: SessionId[] = [];
    for (const sessionId of recorded) {
      let pushed = false;
      try {
        pushed = await options.pushSession(sessionId);
      } catch (error) {
        logger.debug(
          `[${sessionId}] Interrupted session not pushed yet: ${formatErrorMessage(error)}`
        );
      }
      if (pushed) {
        logger.debug(`[${sessionId}] Pushed the writes of a turn cut off by the last shutdown`);
      } else {
        pending.push(sessionId);
      }
    }
    // A record made meanwhile (another shutdown cannot overlap, but stay exact)
    // survives: keep whatever is still unconfirmed plus anything new.
    const latest = await read();
    await write(latest.filter((id) => !recorded.includes(id) || pending.includes(id)));
  };

  return {
    async record(sessionIds) {
      if (sessionIds.length === 0) return;
      const recorded = await read();
      await write([...new Set([...recorded, ...sessionIds])]);
    },
    async flush() {
      if (inFlight) return await inFlight;
      inFlight = flushOnce().finally(() => {
        inFlight = null;
      });
      return await inFlight;
    },
  };
}
