// A stand-in for the agy CLI's `antigravity acp`, for the Antigravity stream
// tests. Speaks ACP over stdio like agy: its four modes, plus `mode`, `model`,
// and `thought_level` config options. It refuses any mode it does not know, so a leaked `yolo` or
// `auto_review` fails the request just as agy would. A prompt starting with
// "report-mode" answers "mode=<current>"; anything else is echoed back.
import { createInterface } from 'node:readline';

const MODES = [
  { id: 'default', name: 'Default', description: 'Ask before each action' },
  { id: 'accept-edits', name: 'Accept edits', description: 'Edit files without asking' },
  { id: 'auto', name: 'Auto', description: 'Run in the sandbox; review the rest' },
  { id: 'plan', name: 'Plan', description: 'Plan without changing anything' },
];
const sessions = new Map();
let nextSession = 1;

const write = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

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
  {
    id: 'thought_level',
    name: 'Thought Level',
    category: 'thought_level',
    type: 'select',
    currentValue: session.thoughtLevel,
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  },
];
const sessionState = (session) => ({
  modes: { currentModeId: session.mode, availableModes: MODES },
  configOptions: configOptions(session),
});

const checkMode = (mode) => {
  if (!MODES.some((entry) => entry.id === mode)) throw new Error(`Unsupported mode: ${mode}`);
};

const openSession = (sessionId, params, method) => {
  const startMode = params?._meta?.lody?.sessionConfig?.configOptionValues?.mode;
  if (startMode !== undefined) checkMode(startMode);
  const session = sessions.get(sessionId) ?? {
    mode: 'default',
    model: 'gemini-4-argon',
    thoughtLevel: 'medium',
    lastOpenMethod: method,
  };
  session.lastOpenMethod = method;
  if (startMode) session.mode = startMode;
  sessions.set(sessionId, session);
  return session;
};

const handle = (message) => {
  switch (message.method) {
    case 'initialize':
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
        agentInfo: { name: 'antigravity-acp', version: 'fixture' },
      };
    case 'session/new': {
      const sessionId = `fake-session-${process.pid}-${nextSession++}`;
      return { sessionId, ...sessionState(openSession(sessionId, message.params, message.method)) };
    }
    case 'session/load':
    case 'session/resume':
      return sessionState(openSession(message.params.sessionId, message.params, message.method));
    case 'session/set_mode':
    case 'session/set_config_option': {
      const session = sessions.get(message.params.sessionId);
      const configId = message.method === 'session/set_mode' ? 'mode' : message.params.configId;
      const value =
        message.method === 'session/set_mode' ? message.params.modeId : message.params.value;
      if (configId === 'mode') {
        checkMode(value);
        session.mode = value;
      } else if (configId === 'model') {
        session.model = value;
      } else if (configId === 'thought_level') {
        session.thoughtLevel = value;
      }
      return message.method === 'session/set_mode' ? {} : { configOptions: configOptions(session) };
    }
    case 'session/prompt': {
      const { sessionId, prompt } = message.params;
      const text = prompt.map((block) => block.text ?? '').join('');
      write({
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: text.startsWith('report-mode')
                ? `mode=${sessions.get(sessionId).mode}`
                : text.startsWith('report-open-method')
                  ? `open=${sessions.get(sessionId).lastOpenMethod}`
                  : text,
            },
          },
        },
      });
      return { stopReason: 'end_turn' };
    }
    default:
      throw new Error(`Method not found: ${message.method}`);
  }
};

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined || message.method === 'session/cancel') return;
  try {
    write({ id: message.id, result: handle(message) });
  } catch (error) {
    write({ id: message.id, error: { code: -32602, message: error.message } });
  }
});
process.stdin.on('end', () => process.exit(0));
