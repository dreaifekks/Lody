/**
 * The prebuilt voices of Gemini's native audio and TTS models, each with the
 * one-word character the speech generation page gives it, in its order
 * (https://aistudio.google.com/docs/speech-generation). Settings stores the
 * names lower-cased. Plain data, so `scripts/generate-gemini-voice-previews.mjs`
 * reads the same list.
 */
export const GEMINI_LIVE_VOICES = [
  { name: 'Zephyr', trait: 'Bright' },
  { name: 'Puck', trait: 'Upbeat' },
  { name: 'Charon', trait: 'Informative' },
  { name: 'Kore', trait: 'Firm' },
  { name: 'Fenrir', trait: 'Excitable' },
  { name: 'Leda', trait: 'Youthful' },
  { name: 'Orus', trait: 'Firm' },
  { name: 'Aoede', trait: 'Breezy' },
  { name: 'Callirrhoe', trait: 'Easy-going' },
  { name: 'Autonoe', trait: 'Bright' },
  { name: 'Enceladus', trait: 'Breathy' },
  { name: 'Iapetus', trait: 'Clear' },
  { name: 'Umbriel', trait: 'Easy-going' },
  { name: 'Algieba', trait: 'Smooth' },
  { name: 'Despina', trait: 'Smooth' },
  { name: 'Erinome', trait: 'Clear' },
  { name: 'Algenib', trait: 'Gravelly' },
  { name: 'Rasalgethi', trait: 'Informative' },
  { name: 'Laomedeia', trait: 'Upbeat' },
  { name: 'Achernar', trait: 'Soft' },
  { name: 'Alnilam', trait: 'Firm' },
  { name: 'Schedar', trait: 'Even' },
  { name: 'Gacrux', trait: 'Mature' },
  { name: 'Pulcherrima', trait: 'Forward' },
  { name: 'Achird', trait: 'Friendly' },
  { name: 'Zubenelgenubi', trait: 'Casual' },
  { name: 'Vindemiatrix', trait: 'Gentle' },
  { name: 'Sadachbia', trait: 'Lively' },
  { name: 'Sadaltager', trait: 'Knowledgeable' },
  { name: 'Sulafat', trait: 'Warm' },
] as const;

/** Kore, the voice of the official Live examples, used until one is chosen. */
export const GEMINI_LIVE_DEFAULT_VOICE = GEMINI_LIVE_VOICES[3];

/** The voice a stored (lower-cased) name stands for; an unknown one is the default. */
export function geminiLiveVoice(stored: string | null | undefined) {
  const lower = stored?.toLowerCase();
  return (
    GEMINI_LIVE_VOICES.find((voice) => voice.name.toLowerCase() === lower) ??
    GEMINI_LIVE_DEFAULT_VOICE
  );
}

/** The Settings label: name, then its character in the doc's own words, e.g. `Kore · Firm`. */
export const geminiLiveVoiceLabel = (voice: { name: string; trait: string }) =>
  `${voice.name} · ${voice.trait}`;
