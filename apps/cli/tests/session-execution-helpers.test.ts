import { normalizeBoardMeta } from '@lody/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalProjectId } from '@lody/shared';

import { setLanSessionCommand } from '../src/lib/lan/lan-session-command';
import { BOARD_UI_COMPARISON_GUIDE, buildPrompt } from '../src/session/session-execution-helpers';

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

  it('keeps GitHub guidance without opting into first-task branch naming', () => {
    const prompt = buildPrompt('fix the bug', {
      kind: 'github',
      repoFullName: 'owner/repo',
      branch: 'feature',
    });

    expect(prompt).toContain("use GitHub's branch rename flow");
    expect(prompt).toContain('Use the available Lody MCP tools when relevant');
    expect(prompt).not.toContain('Before starting this task, rename the branch');
  });

  it('combines first-task instructions with task references and feedback context for local worktrees', () => {
    const prompt = buildPrompt(
      'Fix the checkout observer',
      { kind: 'local', localProjectId: 'local-1' as LocalProjectId, useWorktree: true },
      [
        {
          type: 'issue',
          number: 42,
          title: ' Checkout observer ',
          url: 'https://github.com/owner/repo/issues/42',
        },
      ],
      ' feedback-1 ',
      { branchToRename: 'lody/12345678-abc-2' }
    );

    expect(prompt).toContain(
      'Fix the checkout observer\n\n\n- issue#42: Checkout observer (https://github.com/owner/repo/issues/42)\n'
    );
    expect(prompt).toContain('The postId is feedback-1.');
    expect(prompt).toContain('git branch -m lody/12345678-abc-2 <name>');
    expect(prompt).not.toContain('inspect');
    expect(prompt).toContain(
      'Do not use main, master, or dev, include sensitive input, or force-overwrite an existing branch.'
    );
    expect(prompt).toContain('if renaming fails, report it briefly and continue the task.');
    expect(prompt).not.toContain('gh pr create');
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
        '`lody-lan lan shell <machine> -- <command>` runs a command on one, ' +
        '`lody-lan lan cp [-r] <src> <machine>:<dst>` copies files either way (use it for files, ' +
        'not pipes into `lan shell`), and ' +
        '`lody-lan lan forward <machine> <port>` reaches a port there; see `lody-lan lan --help`.'
    );
  });
});

it('adds role-specific Board instructions while retaining the task and existing reminders', () => {
  const board = normalizeBoardMeta({
    version: 1,
    id: 'bd_prompt',
    name: 'Ship',
    purpose: 'A working release',
    coordinatorSessionId: 'coordinator',
    createdAtMs: 1,
    createdByUserId: 'user',
    rules: { executorConstraints: 'Commit only. Run tests.', maxRoundsPerThread: 4 },
  });
  if (!board) throw new Error('Invalid fixture');
  const coordinator = buildPrompt('My task', undefined, undefined, undefined, {
    boardContext: { board, role: 'coordinator' },
    branchToRename: 'lody/test',
  });
  expect(coordinator).toMatch(/^My task/);
  expect(coordinator).toContain(SESSION_REMINDERS);
  expect(coordinator).toContain('git branch -m lody/test <name>');
  expect(coordinator).toContain(
    'You are the main session of Board "Ship": you assign its work. Goal: A working release.'
  );
  // The main session assigns work and is not woken by thread events.
  expect(coordinator).toContain('you do not implement it and you do not summarize results');
  expect(coordinator).toContain('You are not woken when a thread finishes, fails or waits');
  expect(coordinator).toContain("arrive with the user's next message");
  expect(coordinator).toContain('lody_board_overview');
  expect(coordinator).toContain('end your turn');
  expect(coordinator).toContain(
    'Round enforcement, handoff and daily digests are not available yet'
  );
  expect(coordinator).toContain('Thread rules from the Board settings:\nCommit only. Run tests.');
  expect(coordinator).toContain('lody_board_notes_replace');
  expect(coordinator).toContain('You maintain MEMORY.md');
  const thread = buildPrompt('Implement', undefined, undefined, undefined, {
    boardContext: { board },
  });
  // A thread coordinates its own task and reports to the user.
  expect(thread).toContain('You own this task end to end and report to the user directly');
  expect(thread).toContain('open sessions under your thread with lody_session_create');
  expect(thread).toContain('include reviewer conclusions verbatim in your reply');
  expect(thread).toContain("The Board's main session coordinator assigned this task.");
  expect(thread).toContain('CHAIN_DEPTH_EXCEEDED');
  expect(thread).not.toContain('the coordinator decides');
  expect(thread).not.toContain('Executor constraints');
  expect(thread).toContain('lody_board_notes_append');
  expect(thread).toContain('Thread rules from the Board settings:\nCommit only. Run tests.');
  expect(thread).not.toContain('You are the main session');
  // The Board directory is reached by tools from another machine.
  expect(thread).toContain('lody_board_files_list');
  expect(thread).toContain('The main session maintains MEMORY.md.');
  // Threads and the sessions they open learn how to hand over UI options; the main session does not build UI.
  expect(thread).toContain(BOARD_UI_COMPARISON_GUIDE);
  expect(coordinator).not.toContain('.compare.md');
  const local = buildPrompt('Implement', undefined, undefined, undefined, {
    boardContext: { board, directory: '/data/boards/ws/bd_prompt' },
  });
  expect(local).toContain('Put files every member should see in /data/boards/ws/bd_prompt/files');
  expect(local).toContain('/data/boards/ws/bd_prompt/memory');
  expect(local).not.toContain('lody_board_files_list');
});

it('omits an empty Board goal and adds the user instructions for every member', () => {
  const board = normalizeBoardMeta({
    version: 1,
    id: 'bd_named',
    name: 'Named only',
    coordinatorSessionId: 'coordinator',
    createdAtMs: 1,
    createdByUserId: 'user',
    instructions: 'Check nmem first.',
  });
  if (!board) throw new Error('Invalid fixture');
  for (const role of ['coordinator', undefined] as const) {
    const prompt = buildPrompt('Hello', undefined, undefined, undefined, {
      boardContext: { board, role },
    });
    expect(prompt).not.toContain('Goal:');
    expect(prompt).toContain('Board instructions, written by the user');
    expect(prompt.split('Check nmem first.')).toHaveLength(2);
  }
  const plain = normalizeBoardMeta({ ...board, instructions: '' });
  if (!plain) throw new Error('Invalid fixture');
  const plainThread = buildPrompt('Hello', undefined, undefined, undefined, {
    boardContext: { board: plain },
  });
  expect(plainThread).not.toContain('Board instructions');
  // No thread rules: no empty heading for them either.
  expect(plainThread).not.toContain('Thread rules');
});

it('lists a narrowed project scope for every member and says nothing for all projects', () => {
  const base = {
    version: 1,
    id: 'bd_scope',
    name: 'Scoped',
    coordinatorSessionId: 'coordinator',
    createdAtMs: 1,
    createdByUserId: 'user',
  };
  const board = normalizeBoardMeta({
    ...base,
    context: {
      projects: [
        { kind: 'local', machineId: 'devnuc', localProjectId: 'local-project-a', name: 'Lody' },
        { kind: 'github', repoFullName: 'owner/app' },
      ],
    },
  });
  if (!board) throw new Error('Invalid fixture');
  for (const role of ['coordinator', undefined] as const) {
    const prompt = buildPrompt('Hello', undefined, undefined, undefined, {
      boardContext: { board, role },
    });
    expect(prompt).toContain('Project scope: this Board works only in these projects.');
    expect(prompt).toContain(
      '- Lody on machine devnuc: workContext {"kind":"local","projectId":"local-project-a"} with machineId "devnuc"'
    );
    expect(prompt).toContain(
      '- owner/app on GitHub: workContext {"kind":"github","repo":"owner/app"}'
    );
    expect(prompt).toContain('BOARD_PROJECT_OUT_OF_SCOPE');
    expect(prompt).toContain('Chat sessions (workContext {"kind":"chat"})');
  }
  for (const context of [undefined, { projects: [] }]) {
    const all = normalizeBoardMeta({ ...base, ...(context ? { context } : {}) });
    if (!all) throw new Error('Invalid fixture');
    const prompt = buildPrompt('Hello', undefined, undefined, undefined, {
      boardContext: { board: all },
    });
    expect(prompt).not.toContain('Project scope');
    expect(prompt).not.toContain('BOARD_PROJECT_OUT_OF_SCOPE');
  }
});
