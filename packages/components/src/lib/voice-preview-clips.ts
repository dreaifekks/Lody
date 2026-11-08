import arbor from '@/assets/voice-previews/arbor.webm';
import breeze from '@/assets/voice-previews/breeze.webm';
import cove from '@/assets/voice-previews/cove.webm';
import ember from '@/assets/voice-previews/ember.webm';
import juniper from '@/assets/voice-previews/juniper.webm';
import maple from '@/assets/voice-previews/maple.webm';
import sol from '@/assets/voice-previews/sol.webm';
import spruce from '@/assets/voice-previews/spruce.webm';
import vale from '@/assets/voice-previews/vale.webm';

/**
 * A short sample of each realtime v3 voice, recorded from real calls by
 * `scripts/generate-voice-previews.mjs`. A voice Codex adds later has none
 * until the script is run again and the file is added here.
 */
const CLIPS: Readonly<Record<string, string>> = {
  arbor,
  breeze,
  cove,
  ember,
  juniper,
  maple,
  sol,
  spruce,
  vale,
};

/**
 * The Gemini Live voices' samples, recorded from Live calls by
 * `scripts/generate-gemini-voice-previews.mjs`, keyed `gemini-<voice>`.
 */
const GEMINI_CLIPS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>('../assets/voice-previews/gemini-*.webm', {
      eager: true,
      import: 'default',
      query: '?url',
    })
  ).map(([file, url]) => [file.replace(/^.*\/(gemini-[a-z]+)\.webm$/, '$1'), url])
);

/** The sample's URL, or null when this build bundles none for the voice. */
export function voicePreviewClip(voice: string): string | null {
  if (Object.hasOwn(GEMINI_CLIPS, voice)) return GEMINI_CLIPS[voice] ?? null;
  return Object.hasOwn(CLIPS, voice) ? (CLIPS[voice] ?? null) : null;
}

/** The key `voicePreviewClip` knows a Gemini voice (stored lower-cased) by. */
export const geminiVoicePreviewKey = (voice: string) => `gemini-${voice}`;
