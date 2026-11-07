#!/usr/bin/env node
// Records the samples Settings > Experimental > Voice plays for the Gemini
// Live voices, from the same kind of call Lody makes: an ephemeral token
// signed with the key, a Live session in the voice, one line read aloud.
// Each clip is checked against the voice's own transcript and recorded again
// when it said anything else; ffmpeg trims the silence and writes mono Opus
// beside the Codex clips, prefixed `gemini-`.
//
//   node scripts/generate-gemini-voice-previews.mjs [--voices kore,puck]
//
// Live rather than the TTS models: it is the voice a call speaks in, and a
// free-tier key may send only 10 TTS requests a day per model.
//
// Needs ffmpeg and GEMINI_API_KEY: from the environment, else from this
// machine's copy of the LAN env table. The key only ever goes in a request
// header; errors are printed with it removed. Running it again rewrites the
// clips it is asked for.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GEMINI_LIVE_VOICES } from '../packages/components/src/lib/gemini-live-voices.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = 'gemini-3.8-live';
const LIVE_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
/** As long as the Codex sample sentence, and mixed: the way the user speaks to a call. */
const sentence = (name) => `你好，我是 ${name}，nice to meet you！`;
const ATTEMPTS = 3;

const args = parseArgs(process.argv.slice(2));
const outDir = path.resolve(
  args.out ?? path.join(root, 'packages/components/src/assets/voice-previews')
);
const wanted = args.voices?.split(',').map((voice) => voice.trim().toLowerCase());
const key = readKey();

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.replace(/^--/, '');
    const value = argv[index + 1];
    if (!name || value === undefined) throw new Error(`Missing value for ${argv[index]}`);
    parsed[name] = value;
  }
  return parsed;
}

function readKey() {
  if (process.env.GEMINI_API_KEY?.trim()) return process.env.GEMINI_API_KEY.trim();
  const dir = path.join(
    process.env.LODY_DATA_DIR ?? path.join(os.homedir(), '.lody-oss'),
    'lan-credentials'
  );
  for (const hub of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const file = path.join(dir, hub, 'env.json');
    if (!fs.existsSync(file)) continue;
    const value = JSON.parse(fs.readFileSync(file, 'utf8')).GEMINI_API_KEY;
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  throw new Error('GEMINI_API_KEY is neither in the environment nor in the LAN env table');
}

const redact = (text) => String(text).split(key).join('[GEMINI_API_KEY]');

/** Punctuation, spacing and width differ between the transcript and the line asked for. */
const normalize = (text) =>
  text
    .normalize('NFKC')
    .replace(/[\s\p{P}]/gu, '')
    .toLowerCase();

/** A single-use token, signed the way the voice host signs one. */
async function sign() {
  const now = Date.now();
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      uses: 1,
      expireTime: new Date(now + 5 * 60_000).toISOString(),
      newSessionExpireTime: new Date(now + 60_000).toISOString(),
      bidiGenerateContentSetup: {
        model: `models/${MODEL}`,
        generationConfig: { responseModalities: ['AUDIO'] },
      },
      fieldMask: 'model,generationConfig.responseModalities',
    }),
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(`HTTP ${response.status}: ${redact(body.error?.message ?? '')}`);
  return body.name;
}

/** The voice reads the line once; resolves with its 24 kHz PCM16 and what it said. */
async function record(voice, line) {
  const token = await sign();
  const ws = new WebSocket(`${LIVE_URL}?access_token=${encodeURIComponent(token)}`);
  const audio = [];
  let said = '';
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('No complete answer within 30 s'));
    }, 30_000);
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          setup: {
            model: `models/${MODEL}`,
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
            },
            systemInstruction: {
              parts: [
                {
                  text: `You are a voice sample. Your whole job is to read one line aloud. When the user says "Read it now", say exactly this line, in its own languages, with nothing before or after it, no acknowledgement: "${line}"`,
                },
              ],
            },
            outputAudioTranscription: {},
          },
        })
      );
    ws.onmessage = async (event) => {
      const text = typeof event.data === 'string' ? event.data : await event.data.text();
      const message = JSON.parse(text);
      if (message.setupComplete) {
        ws.send(
          JSON.stringify({
            clientContent: {
              turns: [{ role: 'user', parts: [{ text: 'Read it now' }] }],
              turnComplete: true,
            },
          })
        );
      }
      const content = message.serverContent;
      for (const part of content?.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) audio.push(Buffer.from(part.inlineData.data, 'base64'));
      }
      said += content?.outputTranscription?.text ?? '';
      // Audio can still follow `generationComplete`; the turn ends after it.
      if (content?.turnComplete) {
        clearTimeout(timer);
        ws.onclose = null;
        ws.close();
        resolve({ pcm: Buffer.concat(audio), said });
      }
    };
    ws.onclose = (event) => {
      clearTimeout(timer);
      reject(new Error(`Closed before the line ended: ${redact(event.reason || event.code)}`));
    };
  });
}

function encode(pcmPath, outPath) {
  // The Codex clips' trim and format: leading and trailing silence off, mono Opus.
  const trim =
    'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15,' +
    'areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.3,areverse';
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      's16le',
      '-ar',
      '24000',
      '-ac',
      '1',
      '-i',
      pcmPath,
      '-af',
      trim,
      '-c:a',
      'libopus',
      '-b:a',
      '16k',
      '-vn',
      outPath,
    ],
    { stdio: 'inherit' }
  );
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-gemini-voice-previews-'));
  const voices = GEMINI_LIVE_VOICES.filter(
    (voice) => !wanted || wanted.includes(voice.name.toLowerCase())
  );
  try {
    for (const voice of voices) {
      const line = sentence(voice.name);
      for (let attempt = 1; ; attempt += 1) {
        try {
          const { pcm, said } = await record(voice.name, line);
          if (normalize(said) !== normalize(line)) throw new Error(`said "${said}"`);
          // The line takes over two seconds; less audio than that lost part of it.
          if (pcm.length < 2 * 24_000 * 2)
            throw new Error(`only ${pcm.length / 48_000} s of audio`);
          const lower = voice.name.toLowerCase();
          const pcmPath = path.join(work, `${lower}.pcm`);
          fs.writeFileSync(pcmPath, pcm);
          const outPath = path.join(outDir, `gemini-${lower}.webm`);
          encode(pcmPath, outPath);
          console.log(`${voice.name}: ${fs.statSync(outPath).size} bytes`);
          break;
        } catch (error) {
          if (attempt >= ATTEMPTS) throw error;
          console.warn(`${voice.name}: ${redact(error.message)}; recording again`);
        }
      }
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

await main();
