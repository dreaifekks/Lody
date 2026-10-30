// A stand-in for `agy_acp_server` in its `default` mode, for the Auto Review
// tests. Speaks ACP over stdio like the real server: three modes, a `mode`
// config option, and a permission request (allow_always / allow / deny) before
// each tool call. It refuses any mode it does not know, so a leaked
// `auto_review` fails the request just as the real server would.
//
// A main-session prompt carries the tool calls to request, in order, as
// `_meta.fixtureSteps`; the agent reports each outcome as message text
// ("<title>: <optionId|cancelled>"). Without steps, "report-mode" answers
// "mode=<current>" and anything else is echoed back. A reviewer prompt ("You are Lody Auto Review...") answers a
// verdict chosen by markers in the action: "stuck-review" never answers (nor
// honors a cancel), "broken-review" answers prose, "refuse" answers ask, anything
// else allow. Its reason echoes the context it was given.
import { existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const MODES = [
  { id: 'default', name: 'Default', description: 'Default permission prompt flow' },
  { id: 'auto_edit', name: 'Auto Edit', description: 'Auto-approve file edit tools' },
  { id: 'yolo', name: 'YOLO', description: 'Auto-approve all tools' },
];
const sessions = new Map();
const waiting = new Map();
let nextId = 1;
let nextSession = 1;

const write = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const update = (sessionId, value) =>
  write({ method: 'session/update', params: { sessionId, update: value } });
const request = (method, params) =>
  new Promise((resolve) => {
    const id = `agent-${nextId++}`;
    waiting.set(id, resolve);
    write({ id, method, params });
  });

const configOptions = (session) => [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: session.model,
    options: [
      { value: 'gemini-4-argon', name: 'Gemini 4 Argon' },
      { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
    ],
  },
  {
    id: 'mode',
    name: 'Session Mode',
    category: 'mode',
    type: 'select',
    currentValue: session.mode,
    options: MODES.map((mode) => ({
      value: mode.id,
      name: mode.name,
      description: mode.description,
    })),
  },
];
const sessionState = (session) => ({
  modes: { currentModeId: session.mode, availableModes: MODES },
  configOptions: configOptions(session),
});

const openSession = (sessionId, params) => {
  const startMode = params?._meta?.lody?.sessionConfig?.configOptionValues?.mode;
  if (startMode !== undefined && !MODES.some((mode) => mode.id === startMode)) {
    throw new Error(`Unsupported mode: ${startMode}`);
  }
  const session = sessions.get(sessionId) ?? {
    mode: 'default',
    model: 'gemini-4-argon',
    cancelled: false,
  };
  if (startMode) session.mode = startMode;
  sessions.set(sessionId, session);
  return session;
};

const reviewerVerdict = (text, session) => {
  const field = (name) => new RegExp(`${name}: """([\\s\\S]*?)"""`).exec(text)?.[1] ?? '';
  const subcommands = (/Sub-commands:\n((?:\d+\. .*\n?)+)/.exec(text)?.[1] ?? '')
    .trim()
    .split('\n')
    .filter(Boolean);
  const context = `user=${field("The user's latest message")}; replying-to=${field(
    "The agent's message the user was replying to"
  )}; subcommands=${subcommands.length}; git=${/git repository: yes/.test(text) ? 'yes' : 'no'}; model=${session.model}`;
  const action = text.slice(text.lastIndexOf('\n<action>\n'));
  if (action.includes('broken-review')) return 'I think this is probably fine.';
  if (action.includes('refuse'))
    return JSON.stringify({ decision: 'ask', reason: `not requested (${context})` });
  return JSON.stringify({ decision: 'allow', reason: `matches the request (${context})` });
};

const runPrompt = async (sessionId, text, steps) => {
  const session = sessions.get(sessionId);
  // Like agy: one prompt at a time per session.
  if (session.busy) throw new Error('Session is already processing a prompt');
  session.busy = true;
  try {
    return await runPromptBody(session, sessionId, text, steps);
  } finally {
    session.busy = false;
  }
};

const runPromptBody = async (session, sessionId, text, steps) => {
  session.cancelled = false;
  if (text.startsWith('You are Lody Auto Review')) {
    // Never answers, not even a cancel.
    if (text.slice(text.lastIndexOf('\n<action>\n')).includes('stuck-review'))
      return new Promise(() => {});
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: reviewerVerdict(text, session) },
    });
    return 'end_turn';
  }
  if (!steps) {
    const reply = text.startsWith('report-mode') ? `mode=${session.mode}` : text;
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: reply },
    });
    return 'end_turn';
  }
  for (const [index, step] of steps.entries()) {
    const toolCall = { toolCallId: `tool-${index + 1}`, status: 'pending', ...step };
    update(sessionId, { sessionUpdate: 'tool_call', ...toolCall });
    const response = await request('session/request_permission', {
      sessionId,
      toolCall,
      options: [
        { optionId: 'allow_always', name: 'Allow Always (risky)', kind: 'allow_always' },
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    });
    const outcome =
      response.outcome.outcome === 'selected' ? response.outcome.optionId : 'cancelled';
    update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: toolCall.toolCallId,
      status: outcome === 'allow' || outcome === 'allow_always' ? 'completed' : 'failed',
    });
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `${step.title}: ${outcome}\n` },
    });
    if (session.cancelled) return 'cancelled';
  }
  return 'end_turn';
};

const handle = async (message) => {
  switch (message.method) {
    case 'initialize':
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
        agentInfo: { name: 'antigravity-acp', version: 'fixture' },
      };
    case 'session/new': {
      const sessionId = `fake-session-${process.pid}-${nextSession++}`;
      return { sessionId, ...sessionState(openSession(sessionId, message.params)) };
    }
    case 'session/load':
    case 'session/resume':
      return sessionState(openSession(message.params.sessionId, message.params));
    case 'session/set_mode':
    case 'session/set_config_option': {
      const session = sessions.get(message.params.sessionId);
      const configId = message.method === 'session/set_mode' ? 'mode' : message.params.configId;
      const value =
        message.method === 'session/set_mode' ? message.params.modeId : message.params.value;
      if (configId === 'mode') {
        if (!MODES.some((mode) => mode.id === value)) throw new Error(`Unsupported mode: ${value}`);
        session.mode = value;
      } else if (configId === 'model') {
        session.model = value;
      }
      return message.method === 'session/set_mode' ? {} : { configOptions: configOptions(session) };
    }
    case 'session/prompt': {
      const text = message.params.prompt.map((block) => block.text ?? '').join('');
      return {
        stopReason: await runPrompt(
          message.params.sessionId,
          text,
          message.params._meta?.fixtureSteps
        ),
      };
    }
    default:
      throw new Error(`Method not found: ${message.method}`);
  }
};

// FAKE_AGY_HANG_ONCE=<file>: the first process to find <file> missing creates
// it and never answers `initialize`, like a wedged server.
const hangOnce = process.env.FAKE_AGY_HANG_ONCE;
const hang = hangOnce !== undefined && !existsSync(hangOnce);
if (hang) writeFileSync(hangOnce, 'hung');

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (hang) return;
  if (message.method === undefined) {
    waiting.get(message.id)?.(message.result);
    waiting.delete(message.id);
    return;
  }
  if (message.method === 'session/cancel') {
    const session = sessions.get(message.params.sessionId);
    if (session) {
      session.cancelled = true;
    }
    return;
  }
  handle(message).then(
    (result) => write({ id: message.id, result }),
    (error) => write({ id: message.id, error: { code: -32602, message: error.message } })
  );
});
process.stdin.on('end', () => process.exit(0));
