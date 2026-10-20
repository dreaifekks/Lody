import type { Meta, StoryObj } from '@storybook/react';
import { useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { PanelBottom } from 'lucide-react';

import type {
  TerminalChannel,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalTitleEvent,
  Unsubscribe,
} from '@/components/terminal/terminal-channel';
import { TerminalDock, type TerminalDockProps } from '@/components/terminal/terminal-dock';
import { terminalControllerAtom } from '@/components/terminal/terminal-controller';

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const BLUE = '\x1b[34m';
const DIM = '\x1b[2m';

class StoryTerminalChannel implements TerminalChannel {
  private seq = 0;
  private readonly terminals = new Map<string, { terminalId: string; cwd: string; line: string }>();
  private readonly dataHandlers = new Set<(event: TerminalDataEvent) => void>();
  private readonly exitHandlers = new Set<(event: TerminalExitEvent) => void>();
  private readonly titleHandlers = new Set<(event: TerminalTitleEvent) => void>();

  constructor(
    private readonly defaultCwd = '~/Documents/Codex/2026',
    private readonly banner = ''
  ) {}

  list() {
    return Promise.resolve(
      [...this.terminals.values()].map((terminal) => ({
        terminalId: terminal.terminalId,
        title: this.titleFor(terminal.cwd),
        cwd: terminal.cwd,
      }))
    );
  }

  open() {
    this.seq += 1;
    const terminalId = `story-${this.seq}`;
    this.terminals.set(terminalId, { terminalId, cwd: this.defaultCwd, line: '' });
    return Promise.resolve({ terminalId, cwd: this.defaultCwd });
  }

  attach(terminalId: string): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return;
    queueMicrotask(() => {
      this.emitTitle(terminalId, this.titleFor(terminal.cwd));
      this.emitData(
        terminalId,
        `${DIM}(storybook shell - no backend)${RESET}\r\n${this.banner}${this.prompt(terminal.cwd)}`
      );
    });
  }

  input(terminalId: string, data: string): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return;
    for (const char of data) {
      if (char === '\r') {
        this.runCommand(terminal);
      } else if (char === '\x7f') {
        terminal.line = terminal.line.slice(0, -1);
        this.emitData(terminalId, '\b \b');
      } else if (char >= ' ') {
        terminal.line += char;
        this.emitData(terminalId, char);
      }
    }
  }

  resize(): void {}

  close(terminalId: string): void {
    if (!this.terminals.delete(terminalId)) return;
    this.emitExit(terminalId, 0);
  }

  closeSession(): void {
    for (const terminalId of [...this.terminals.keys()]) {
      this.close(terminalId);
    }
  }

  readClipboardText(): string {
    return '';
  }

  writeClipboardText(): void {}

  onData(handler: (event: TerminalDataEvent) => void): Unsubscribe {
    this.dataHandlers.add(handler);
    return () => this.dataHandlers.delete(handler);
  }

  onExit(handler: (event: TerminalExitEvent) => void): Unsubscribe {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  onTitle(handler: (event: TerminalTitleEvent) => void): Unsubscribe {
    this.titleHandlers.add(handler);
    return () => this.titleHandlers.delete(handler);
  }

  private runCommand(terminal: { terminalId: string; cwd: string; line: string }): void {
    const [name, ...args] = terminal.line.trim().split(/\s+/);
    terminal.line = '';
    const output =
      name === 'pwd'
        ? terminal.cwd
        : name === 'ls'
          ? `${BLUE}src${RESET}  package.json  README.md`
          : name === 'echo'
            ? args.join(' ')
            : name
              ? `${DIM}story: '${name}' is not wired up${RESET}`
              : '';
    this.emitData(
      terminal.terminalId,
      `\r\n${output ? `${output}\r\n` : ''}${this.prompt(terminal.cwd)}`
    );
  }

  private prompt(cwd: string): string {
    return `${GREEN}leon${RESET} ${DIM}in${RESET} ${BLUE}${cwd}${RESET}\r\n$ `;
  }

  private titleFor(cwd: string): string {
    const parts = cwd.split('/').filter(Boolean);
    return `leon@story - ${parts[parts.length - 1] ?? cwd}`;
  }

  private emitData(terminalId: string, data: string): void {
    for (const handler of this.dataHandlers) {
      handler({ type: 'data', terminalId, data });
    }
  }

  private emitTitle(terminalId: string, title: string): void {
    for (const handler of this.titleHandlers) handler({ type: 'title', terminalId, title });
  }

  private emitExit(terminalId: string, exitCode: number): void {
    for (const handler of this.exitHandlers) handler({ type: 'exit', terminalId, exitCode });
  }
}

function DockHarness({ banner, ...props }: Partial<TerminalDockProps> & { banner?: string }) {
  const channel = useMemo(() => new StoryTerminalChannel(undefined, banner), [banner]);
  // Mirrors the session header's dock toggle: the dock is hidden until opened.
  const controller = useAtomValue(terminalControllerAtom);
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <div className="flex flex-none items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="text-sm text-muted-foreground">主内容区（对话）</span>
        <button
          type="button"
          onClick={() => controller?.toggleOpen()}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <PanelBottom className="h-3.5 w-3.5" />
          Toggle terminal dock
        </button>
      </div>
      <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
        点击右上角按钮，终端从底部弹出（浮动圆角卡片，tab 头在顶部），body 可拖动顶边调高
      </div>
      <TerminalDock channel={channel} {...props} />
    </div>
  );
}

// Each story renders through `DockHarness`, which injects its own mock channel;
// this meta-level channel only satisfies the required prop type for render-only stories.
const metaChannel = new StoryTerminalChannel();

const meta = {
  title: 'Terminal/TerminalDock',
  component: TerminalDock,
  parameters: { layout: 'fullscreen' },
  args: { channel: metaChannel },
} satisfies Meta<typeof TerminalDock>;

export default meta;
type Story = StoryObj<typeof meta>;

export const InLocalSession: Story = {
  render: () => <DockHarness sessionId="sess-1" defaultView="terminal" autoOpenFirstTerminal />,
};

// Plain click opens a URL in the system browser; Cmd/Ctrl + click asks for the
// side panel, which the harness only reports. Paths open only with the modifier.
const LINK_OUTPUT = [
  `  VITE v6.0.0  ready in 312 ms`,
  `  ➜  Local:   ${BLUE}http://localhost:5173/${RESET}`,
  `  ➜  Network: http://0.0.0.0:5173/`,
  `Docs (https://vite.dev/guide/), PR https://github.com/LodyAI/Lody/pull/1.`,
  `src/components/terminal/terminal-links.ts:42:7 - error TS2322`,
  `打开 http://localhost:3000，然后看 docs/准备.md`,
  `\x1b]8;;https://example.com/osc8\x07OSC 8 hyperlink\x1b]8;;\x07`,
  '',
].join('\r\n');

function LinkHarness({ sessionIsRemote }: { sessionIsRemote?: boolean }) {
  const [request, setRequest] = useState('');
  return (
    <>
      <div className="fixed left-3 top-12 z-10 text-xs text-muted-foreground">
        {request || 'Cmd/Ctrl + click a link to request the side panel'}
      </div>
      <DockHarness
        sessionId="sess-1"
        defaultView="terminal"
        autoOpenFirstTerminal
        banner={LINK_OUTPUT}
        sessionIsRemote={sessionIsRemote}
        onOpenUrlInSidePanel={(url) => setRequest(`Browser panel: ${url}`)}
        onOpenFileInSidePanel={(path) => setRequest(`File tab: ${path}`)}
      />
    </>
  );
}

export const WithLinks: Story = {
  render: () => <LinkHarness />,
};

// A session on another LAN machine: its loopback URLs go to the side panel on a plain click.
export const WithLinksRemoteSession: Story = {
  render: () => <LinkHarness sessionIsRemote />,
};

export const OutOfSession: Story = {
  render: () => <DockHarness />,
};

export const SessionStarting: Story = {
  render: () => <DockHarness sessionId="sess-1" canCreateTerminal={false} />,
};

export const Collapsed: Story = {
  render: () => <DockHarness sessionId="sess-1" />,
};
