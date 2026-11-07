import { z } from 'zod';

import { AgentConfigIdSchema } from './message-schemas';

/**
 * Experimental realtime voice hosted by a machine's Codex agent config. The
 * renderer owns the microphone and the WebRTC peer; the machine only
 * negotiates the call and reports spoken requests. Events are pulled with
 * `poll`, which waits briefly for the next one, because every RPC transport
 * answers a request exactly once.
 *
 * The Gemini Live backend uses the machine only to sign a short-lived token
 * with its `GEMINI_API_KEY` (`geminiToken`); the renderer then holds the
 * Live WebSocket itself, so its calls never use start, append, stop or poll.
 */
export const MACHINE_VOICE_POLL_MAX_WAIT_MS = 15_000;

/**
 * The renderer's answer, without asking, to a voice list or chosen voice for a
 * machine whose protocol predates them (`realtimeVoice` < 3).
 */
export const MACHINE_VOICE_SELECTION_UNSUPPORTED =
  'This machine cannot choose voices yet. Update Lody on it.';

/**
 * Lody builds lan.25 and lan.26 also sent a `preview` mode, a call that only
 * said a sample sentence. It never spoke (realtime v3 stays silent without
 * microphone audio) and is gone: Settings plays bundled clips instead, and a
 * host now rejects such a start like any malformed request.
 */
export const MachineVoiceModeSchema = z.enum(['conversation', 'dictation']);
export type MachineVoiceMode = z.infer<typeof MachineVoiceModeSchema>;

/** Which service speaks: a Codex agent's realtime voice, or Gemini Live. */
export const MachineVoiceProviderSchema = z.enum(['codex', 'gemini']);
export type MachineVoiceProvider = z.infer<typeof MachineVoiceProviderSchema>;

export const MachineVoiceNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_-]+$/);

export const MachineVoiceRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('start'),
      configId: AgentConfigIdSchema,
      mode: MachineVoiceModeSchema,
      sdp: z.string().min(1).max(64_000),
      instructions: z.string().max(4_000).optional(),
      /** Background the voice starts from, e.g. the session's recent turns (protocol v2). */
      context: z.string().max(16_000).optional(),
      /** A name from the `voices` action (protocol v3); an unknown one falls back to the default. */
      voice: MachineVoiceNameSchema.optional(),
    })
    .strict(),
  /** The voices the config's Codex offers for calls (protocol v3). */
  z.object({ action: z.literal('voices'), configId: AgentConfigIdSchema }).strict(),
  z
    .object({
      action: z.literal('append'),
      voiceSessionId: z.string().min(1).max(200),
      text: z.string().min(1).max(32_000),
    })
    .strict(),
  z.object({ action: z.literal('stop'), voiceSessionId: z.string().min(1).max(200) }).strict(),
  /** A single-use Gemini Live token for one call of `mode` (protocol v4). */
  z.object({ action: z.literal('geminiToken'), mode: MachineVoiceModeSchema }).strict(),
  z
    .object({
      action: z.literal('poll'),
      voiceSessionId: z.string().min(1).max(200),
      after: z.number().int().min(0),
      waitMs: z.number().int().min(0).max(MACHINE_VOICE_POLL_MAX_WAIT_MS).optional(),
    })
    .strict(),
]);
export type MachineVoiceRequest = z.infer<typeof MachineVoiceRequestSchema>;

export const MachineVoiceEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('transcript'),
      role: z.enum(['user', 'assistant']),
      text: z.string(),
    })
    .strict(),
  z.object({ type: z.literal('request'), requestId: z.string(), text: z.string() }).strict(),
  z.object({ type: z.literal('closed'), reason: z.string().nullable() }).strict(),
  z.object({ type: z.literal('error'), message: z.string() }).strict(),
]);
export type MachineVoiceEvent = z.infer<typeof MachineVoiceEventSchema>;

export const MachineVoiceResponseSchema = z.union([
  z
    .object({
      success: z.literal(true),
      action: z.literal('start'),
      voiceSessionId: z.string(),
      sdp: z.string(),
    })
    .strict(),
  z
    .object({
      success: z.literal(true),
      action: z.literal('poll'),
      events: z.array(z.object({ seq: z.number().int(), event: MachineVoiceEventSchema }).strict()),
      closed: z.boolean(),
    })
    .strict(),
  z
    .object({
      success: z.literal(true),
      action: z.literal('voices'),
      voices: z.array(MachineVoiceNameSchema).max(100),
      defaultVoice: MachineVoiceNameSchema,
    })
    .strict(),
  z
    .object({
      success: z.literal(true),
      action: z.literal('geminiToken'),
      /** The token's name (`auth_tokens/…`), the credential the Live WebSocket accepts. */
      token: z.string().min(1),
      /** The model the token is locked to, e.g. `gemini-3.8-live`. */
      model: z.string().min(1),
      /** RFC 3339; the token stops working, also for resuming the call. */
      expireTime: z.string(),
      /** RFC 3339; the call must have connected by then. */
      newSessionExpireTime: z.string(),
    })
    .strict(),
  z.object({ success: z.literal(true), action: z.enum(['append', 'stop']) }).strict(),
  z.object({ success: z.literal(false), error: z.string() }).strict(),
]);
export type MachineVoiceResponse = z.infer<typeof MachineVoiceResponseSchema>;
