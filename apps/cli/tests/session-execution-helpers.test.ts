import { afterEach, describe, expect, it } from 'vitest';

import { setLanSessionCommand } from '../src/lib/lan/lan-session-command';
import { buildPrompt } from '../src/session/session-execution-helpers';

const SESSION_REMINDERS =
  '\n\nUse the available Lody MCP tools when relevant; rely on their tool descriptions for complete, current capabilities and usage guidance.' +
  "\n\nFile paths in your replies become links that open relative to this session's working directory: " +
  'write a file inside it by its full path from there, and a file anywhere else by its absolute path.';

describe('session execution prompt helpers', () => {
  afterEach(() => {
    setLanSessionCommand(null);
  });

  it('replaces detailed Lody MCP guidance with a concise reminder', () => {
    const prompt = buildPrompt('inspect the UI');

    expect(prompt).toBe(`inspect the UI${SESSION_REMINDERS}`);
    expect(prompt).not.toContain('lody_upload_images');
    expect(prompt).not.toContain('lody_session_create');
  });

  it('keeps GitHub worktree instructions without detailed Lody MCP guidance', () => {
    const prompt = buildPrompt('fix the bug', {
      kind: 'github',
      repoFullName: 'owner/repo',
      branch: 'feature',
    });

    expect(prompt).toContain('Name branches based on the task content');
    expect(prompt).toContain('Use the available Lody MCP tools when relevant');
    expect(prompt).not.toContain('The "lody" MCP server provides tools');
    expect(prompt).not.toContain('lody_upload_images');
  });

  it('adds nothing where no agent service offers the LAN command, as on the hosted platform', () => {
    expect(buildPrompt('ship the patch')).toBe(`ship the patch${SESSION_REMINDERS}`);
  });

  it('adds nothing on a machine that belongs to no LAN', () => {
    setLanSessionCommand({ binDir: '/data/session-bin', env: {}, isLanMember: () => false });

    expect(buildPrompt('ship the patch')).toBe(`ship the patch${SESSION_REMINDERS}`);
  });

  it('tells the agent of a LAN member how to reach the other machines, from the turn it joined', () => {
    let hubs = 0;
    setLanSessionCommand({ binDir: '/data/session-bin', env: {}, isLanMember: () => hubs > 0 });
    const before = buildPrompt('ship the patch');
    hubs = 1;

    expect(before).toBe(`ship the patch${SESSION_REMINDERS}`);
    expect(buildPrompt('ship the patch')).toBe(
      `ship the patch${SESSION_REMINDERS}\n\n` +
        'This machine is a member of a Lody LAN. `lody-lan lan machines` lists the other machines, ' +
        '`lody-lan lan shell <machine> -- <command>` runs a command on one, and ' +
        '`lody-lan lan forward <machine> <port>` reaches a port there; see `lody-lan lan --help`.'
    );
  });
});
