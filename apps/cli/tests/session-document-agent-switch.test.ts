import { describe, expect, it } from 'vitest';
import { LoroRepo } from 'loro-repo';
import { v4 as uuidv4 } from 'uuid';

import { SessionDocument } from '../src/lib/loro/doc';
import type { ACPSessionId, AgentConfigId, SessionId } from '@lody/shared';

describe('SessionDocument agent switch', () => {
  it('drops the previous agent conversation with the switch, so no other agent resumes it', async () => {
    const repo = await LoroRepo.create({});
    try {
      const doc = new SessionDocument(repo, uuidv4() as SessionId);
      await doc.initOffline({ history: [] });
      await doc.setACPSessionId('acp-old' as ACPSessionId);

      await doc.setAgentConfig({
        agentConfigId: 'codex-config' as AgentConfigId,
        cliType: 'builtin',
        agentType: 'codex',
      });

      const meta = await doc.getMetaState();
      expect(meta).toMatchObject({
        agentConfigId: 'codex-config',
        cliType: 'builtin',
        agentType: 'codex',
      });
      expect(meta?.acpSessionId).toBeUndefined();
    } finally {
      await repo.destroy();
    }
  });
});
