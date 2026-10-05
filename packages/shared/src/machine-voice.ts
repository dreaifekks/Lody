import { z } from 'zod';

import { AgentConfigIdSchema } from './message-schemas';

/**
 * Experimental realtime voice hosted by a machine's Codex agent config. The
 * renderer owns the microphone and the WebRTC peer; the machine only
 * negotiates the call and reports spoken requests. Events are pulled with
 * `poll`, which waits briefly for the next one, because every RPC transport
 * answers a request exactly once.
 */
export const MACHINE_VOICE_POLL_MAX_WAIT_MS = 15_000;

export const MachineVoiceModeSchema = z.enum(['conversation', 'dictation']);
export type MachineVoiceMode = z.infer<typeof MachineVoiceModeSchema>;

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
    })
    .strict(),
  z
    .object({
      action: z.literal('append'),
      voiceSessionId: z.string().min(1).max(200),
      text: z.string().min(1).max(32_000),
    })
    .strict(),
  z.object({ action: z.literal('stop'), voiceSessionId: z.string().min(1).max(200) }).strict(),
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
  z.object({ success: z.literal(true), action: z.enum(['append', 'stop']) }).strict(),
  z.object({ success: z.literal(false), error: z.string() }).strict(),
]);
export type MachineVoiceResponse = z.infer<typeof MachineVoiceResponseSchema>;
