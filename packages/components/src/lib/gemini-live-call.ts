import type { MachineVoiceMode } from '@lody/shared';

/**
 * A Gemini Live call over the raw v1beta WebSocket, signed by a machine's
 * single-use token. Audio in and out, transcripts, the `hand_off_to_agent`
 * function the voice calls to give work to the session's agent, and
 * reconnection through session resumption all live here; the microphone and
 * the speakers are injected so the protocol can be driven without a browser.
 *
 * Wire format: https://aistudio.google.com/api-reference/live (JSON text
 * frames; some servers send them as binary frames, which read the same).
 */

const LIVE_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';

export const GEMINI_HAND_OFF_FUNCTION = 'hand_off_to_agent';

/** A token this close to expiring is not trusted to carry a reconnection; a fresh one is signed. */
const TOKEN_RENEW_MARGIN_MS = 60_000;

/**
 * The prebuilt voices of Gemini's native audio models, as the speech
 * generation page lists them. Settings stores them lower-cased.
 */
export const GEMINI_LIVE_VOICES = [
  'Zephyr',
  'Puck',
  'Charon',
  'Kore',
  'Fenrir',
  'Leda',
  'Orus',
  'Aoede',
  'Callirrhoe',
  'Autonoe',
  'Enceladus',
  'Iapetus',
  'Umbriel',
  'Algieba',
  'Despina',
  'Erinome',
  'Algenib',
  'Rasalgethi',
  'Laomedeia',
  'Achernar',
  'Alnilam',
  'Schedar',
  'Gacrux',
  'Pulcherrima',
  'Achird',
  'Zubenelgenubi',
  'Vindemiatrix',
  'Sadachbia',
  'Sadaltager',
  'Sulafat',
] as const;

/** The voice of the official Live examples, used until one is chosen. */
export const GEMINI_LIVE_DEFAULT_VOICE = 'Kore';

/** The Live API's name for a stored (lower-cased) voice; an unknown one plays the default. */
export function geminiLiveVoiceName(stored: string | null | undefined): string {
  const lower = stored?.toLowerCase();
  return (
    GEMINI_LIVE_VOICES.find((voice) => voice.toLowerCase() === lower) ?? GEMINI_LIVE_DEFAULT_VOICE
  );
}

export type GeminiLiveToken = {
  token: string;
  model: string;
  /** RFC 3339; resuming with the token works until then. */
  expireTime: string;
};

/** The parts of a browser `WebSocket` the call uses. */
export type GeminiLiveSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
};

export type GeminiLiveCallHandlers = {
  /** Dictation: everything the user said so far, the words still being heard included. */
  onUserTranscript?: (text: string) => void;
  /** A finished utterance of either side (conversation). */
  onTranscript?: (line: { role: 'user' | 'assistant'; text: string }) => void;
  /** Each transcribed piece as it arrives, for a running caption. */
  onTranscriptPiece?: (piece: { role: 'user' | 'assistant'; text: string }) => void;
  /** The voice handed a request to the agent; answer it with `reply(text, [callId])`. */
  onRequest?: (text: string, callId: string) => void;
  /** The server withdrew a hand-off because the user talked over it; drop it if unsent. */
  onRequestCancelled?: (callId: string) => void;
  /** 24 kHz (or the stated rate) mono PCM16 to play after what is already queued. */
  onAudio?: (pcm: Int16Array, sampleRate: number) => void;
  /** The user talked over the voice: drop everything still queued to play. */
  onInterrupted?: () => void;
  /** Token counts the server reported, one report per model turn. */
  onUsage?: (usage: Record<string, unknown>) => void;
  /** The call ended by itself; `reason` is null when nothing went wrong. */
  onClosed?: (reason: string | null) => void;
};

export type GeminiLiveCallOptions = {
  mode: MachineVoiceMode;
  /** The first token; later ones come from `issueToken`. */
  token: GeminiLiveToken;
  issueToken: () => Promise<GeminiLiveToken>;
  openSocket: (url: string) => GeminiLiveSocket;
  now: () => number;
  instructions?: string;
  /** Background the voice starts from; sent once, not again on a resumed connection. */
  context?: string;
  /** A stored voice name (conversation only). */
  voice?: string | null;
  handlers: GeminiLiveCallHandlers;
};

type ServerMessage = {
  setupComplete?: unknown;
  serverContent?: {
    modelTurn?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] };
    turnComplete?: boolean;
    generationComplete?: boolean;
    interrupted?: boolean;
    inputTranscription?: { text?: string; finished?: boolean };
    interimInputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
  };
  toolCall?: { functionCalls?: { id?: string; name?: string; args?: { request?: unknown } }[] };
  toolCallCancellation?: { ids?: string[] };
  goAway?: unknown;
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
  usageMetadata?: Record<string, unknown>;
};

const HAND_OFF_DECLARATION = {
  name: GEMINI_HAND_OFF_FUNCTION,
  description:
    "Give the user's request to the background agent, which does the thinking and the work in this session. Its answer arrives later as this function's result.",
  behavior: 'NON_BLOCKING',
  parameters: {
    type: 'OBJECT',
    properties: {
      request: {
        type: 'STRING',
        description:
          "The request, close to the user's own words, with what the conversation made clear.",
      },
    },
    required: ['request'],
  },
};

export class GeminiLiveCall {
  private socket: GeminiLiveSocket | null = null;
  private token: GeminiLiveToken;
  private ready = false;
  private stopped = false;
  private resumeHandle: string | null = null;
  /** Whether the server's latest word is that the session can be resumed from here. */
  private resumable = false;
  /** Hand-offs made after the latest handle; a session resumed from it never saw them. */
  private readonly callsSinceHandle = new Set<string>();
  /** A GoAway arrived while not resumable: move once the server reports a resumable point. */
  private leaving = false;
  private reconnecting = false;
  /** Hand-offs the voice made that no reply has answered or the server cancelled. */
  private readonly pendingCalls = new Set<string>();
  private userText = '';
  private assistantText = '';
  /** Dictation: finished speech turns so far. */
  private dictated = '';
  /** Fails a connection still being set up when the call is stopped. */
  private abandonConnect: (() => void) | null = null;
  /** Replies and turns written while no connection is ready, sent once one is. */
  private outbox: unknown[] = [];
  /** Server frames handled in arrival order, though a binary frame decodes asynchronously. */
  private inbox: Promise<void> = Promise.resolve();

  constructor(private readonly options: GeminiLiveCallOptions) {
    this.token = options.token;
  }

  /** Resolves once the server accepted the setup; rejects when the first connection fails. */
  async start(): Promise<void> {
    try {
      await this.connect();
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  /** One chunk of 16 kHz mono PCM16 from the microphone; dropped while reconnecting. */
  sendAudio(pcm: Int16Array): void {
    if (!this.ready || this.stopped) return;
    this.send({
      realtimeInput: { audio: { data: encodeBase64(pcm), mimeType: 'audio/pcm;rate=16000' } },
    });
  }

  /**
   * Hands a finished reply of the agent to the voice: as the result of the
   * hand-offs it answers when any is still open, so the voice tells it once
   * it is free; otherwise as a new turn, e.g. for a reply the user typed.
   */
  reply(text: string, callIds: readonly string[] = []): void {
    if (this.stopped) return;
    const open = callIds.filter((id) => this.pendingCalls.has(id));
    for (const id of open) this.pendingCalls.delete(id);
    if (open.length === 0) {
      this.sendTurn({
        clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true },
      });
      return;
    }
    // The docs show `scheduling` inside `response`; the generated API type has it
    // beside `response`. Both are sent so either reading schedules the answer.
    this.sendTurn({
      toolResponse: {
        functionResponses: open.map((id, index) => {
          const scheduling = index === 0 ? 'WHEN_IDLE' : 'SILENT';
          const result = index === 0 ? text : 'Answered together with the first of these requests.';
          return {
            id,
            name: GEMINI_HAND_OFF_FUNCTION,
            response: { result, scheduling },
            scheduling,
          };
        }),
      },
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.ready = false;
    this.socket?.close(1000, 'stopped');
    this.socket = null;
    this.abandonConnect?.();
  }

  private send(message: unknown): void {
    this.socket?.send(JSON.stringify(message));
  }

  /** A message the conversation must not lose: held while the call reconnects. */
  private sendTurn(message: unknown): void {
    if (this.ready) this.send(message);
    else this.outbox.push(message);
  }

  private connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const resuming = this.resumeHandle !== null;
      const socket = this.options.openSocket(
        `${LIVE_URL}?access_token=${encodeURIComponent(this.token.token)}`
      );
      this.socket = socket;
      let accepted = false;
      this.abandonConnect = () => reject(new Error('The voice call was stopped.'));
      socket.onopen = () => {
        if (this.socket === socket) this.send({ setup: this.setup() });
      };
      socket.onmessage = (event) => {
        this.inbox = this.inbox.then(async () => {
          if (this.socket !== socket || this.stopped) return;
          const message = await decodeFrame(event.data);
          if (!message) return;
          if (message.setupComplete !== undefined && !accepted) {
            accepted = true;
            this.ready = true;
            this.reconnecting = false;
            if (!resuming && this.options.context) {
              this.send({
                clientContent: {
                  turns: [{ role: 'user', parts: [{ text: this.options.context }] }],
                  turnComplete: false,
                },
              });
            }
            const held = this.outbox;
            this.outbox = [];
            for (const entry of held) this.send(entry);
            this.abandonConnect = null;
            resolve();
          }
          this.handle(message);
        });
      };
      socket.onclose = (event) => {
        void this.inbox.then(() => {
          if (this.socket !== socket || this.stopped) return;
          this.ready = false;
          this.socket = null;
          const reason = event.reason || `connection closed (${event.code})`;
          if (!accepted) {
            reject(new Error(`Gemini Live refused the call: ${reason}`));
            return;
          }
          this.reconnect(reason);
        });
      };
    });
  }

  private setup(): Record<string, unknown> {
    const { mode } = this.options;
    const model = `models/${this.token.model}`;
    if (mode === 'dictation') {
      return {
        model,
        generationConfig: { responseModalities: ['TEXT'] },
        inputAudioTranscription: { languageCodes: [] },
      };
    }
    return {
      model,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: geminiLiveVoiceName(this.options.voice) },
          },
        },
      },
      ...(this.options.instructions
        ? { systemInstruction: { parts: [{ text: this.options.instructions }] } }
        : {}),
      tools: [{ functionDeclarations: [HAND_OFF_DECLARATION] }],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
      contextWindowCompression: { slidingWindow: {} },
    };
  }

  /**
   * Opens a new connection that resumes the call where the server left it,
   * on the current token while it lasts and on a fresh one after.
   */
  private reconnect(reason: string): void {
    if (this.stopped || this.reconnecting) return;
    if (!this.resumeHandle) {
      this.finish(`Gemini Live ended the call: ${reason}`);
      return;
    }
    this.reconnecting = true;
    this.ready = false;
    this.leaving = false;
    // The resumed session knows nothing of these; their answers become plain turns.
    for (const id of this.callsSinceHandle) this.pendingCalls.delete(id);
    this.callsSinceHandle.clear();
    const previous = this.socket;
    this.socket = null;
    previous?.close(1000, 'reconnecting');
    void (async () => {
      try {
        if (this.options.now() >= Date.parse(this.token.expireTime) - TOKEN_RENEW_MARGIN_MS) {
          this.token = await this.options.issueToken();
        }
        if (this.stopped) return;
        await this.connect();
      } catch (error) {
        this.finish(error instanceof Error ? error.message : String(error));
      }
    })();
  }

  private finish(reason: string | null): void {
    if (this.stopped) return;
    this.stop();
    this.options.handlers.onClosed?.(reason);
  }

  private flushUser(): void {
    const text = this.userText.trim();
    this.userText = '';
    if (text) this.options.handlers.onTranscript?.({ role: 'user', text });
  }

  private flushAssistant(): void {
    const text = this.assistantText.trim();
    this.assistantText = '';
    if (text) this.options.handlers.onTranscript?.({ role: 'assistant', text });
  }

  private handle(message: ServerMessage): void {
    const { handlers } = this.options;
    const resumption = message.sessionResumptionUpdate;
    if (resumption) {
      this.resumable = resumption.resumable === true && Boolean(resumption.newHandle);
      if (this.resumable && resumption.newHandle) {
        this.resumeHandle = resumption.newHandle;
        this.callsSinceHandle.clear();
      }
    }
    if (message.usageMetadata) handlers.onUsage?.(message.usageMetadata);
    const content = message.serverContent;
    if (content) {
      if (this.options.mode === 'dictation') {
        if (content.inputTranscription?.text) this.dictated += content.inputTranscription.text;
        const hearing = content.inputTranscription
          ? ''
          : (content.interimInputTranscription?.text ?? '');
        if (content.inputTranscription?.text || content.interimInputTranscription?.text) {
          handlers.onUserTranscript?.(this.dictated + hearing);
        }
      } else {
        const heard = content.inputTranscription?.text;
        if (heard) {
          this.userText += heard;
          handlers.onTranscriptPiece?.({ role: 'user', text: heard });
          if (content.inputTranscription?.finished) this.flushUser();
        }
        const said = content.outputTranscription?.text;
        if (said) {
          // The voice speaking means the user's turn has ended.
          this.flushUser();
          this.assistantText += said;
          handlers.onTranscriptPiece?.({ role: 'assistant', text: said });
        }
        for (const part of content.modelTurn?.parts ?? []) {
          const data = part.inlineData?.data;
          if (!data) continue;
          this.flushUser();
          handlers.onAudio?.(decodeBase64Pcm(data), sampleRateOf(part.inlineData?.mimeType));
        }
        if (content.interrupted) handlers.onInterrupted?.();
        if (content.generationComplete || content.interrupted || content.turnComplete) {
          this.flushAssistant();
        }
        if (content.turnComplete) this.flushUser();
      }
    }
    for (const call of message.toolCall?.functionCalls ?? []) {
      if (call.name !== GEMINI_HAND_OFF_FUNCTION || !call.id) continue;
      const request = typeof call.args?.request === 'string' ? call.args.request.trim() : '';
      if (!request) continue;
      // What the user said comes before the request it led to.
      this.flushUser();
      this.pendingCalls.add(call.id);
      this.callsSinceHandle.add(call.id);
      handlers.onRequest?.(request, call.id);
    }
    for (const id of message.toolCallCancellation?.ids ?? []) {
      this.pendingCalls.delete(id);
      this.callsSinceHandle.delete(id);
      handlers.onRequestCancelled?.(id);
    }
    // The server ends this connection soon. Move while it still answers, but only
    // from a point the server can resume; until then (a hand-off or a reply in
    // progress) wait for one, or for the connection to close.
    if (message.goAway !== undefined) this.leaving = true;
    if (this.leaving && this.resumable) this.reconnect('the server is closing the connection');
  }
}

async function decodeFrame(data: unknown): Promise<ServerMessage | null> {
  let text: string;
  if (typeof data === 'string') text = data;
  else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
  else if (typeof Blob !== 'undefined' && data instanceof Blob) text = await data.text();
  else return null;
  try {
    return JSON.parse(text) as ServerMessage;
  } catch {
    return null;
  }
}

function sampleRateOf(mimeType: string | undefined): number {
  const match = mimeType?.match(/rate=(\d+)/);
  return match ? Number(match[1]) : 24_000;
}

function encodeBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64Pcm(data: string): Int16Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length & ~1);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

/** A browser WebSocket seen through the narrow interface the call drives. */
export function openBrowserGeminiSocket(url: string): GeminiLiveSocket {
  const ws = new WebSocket(url);
  const socket: GeminiLiveSocket = {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    onopen: null,
    onmessage: null,
    onclose: null,
  };
  ws.onopen = () => socket.onopen?.();
  ws.onmessage = (event) => socket.onmessage?.({ data: event.data });
  ws.onclose = (event) => socket.onclose?.({ code: event.code, reason: event.reason });
  return socket;
}
