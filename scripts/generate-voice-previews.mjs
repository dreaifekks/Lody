#!/usr/bin/env node
// Records the voice samples Settings > Experimental > Voice plays, one per
// realtime voice, from the same realtime v3 calls Lody makes: a Codex
// app-server negotiates a WebRTC call, headless Chrome holds the peer and
// records what the voice says, ffmpeg trims the silence and writes Opus.
//
//   node scripts/generate-voice-previews.mjs --codex <codex binary> [--voices cove,sol]
//
// Needs a Codex signed in to ChatGPT (its usual CODEX_HOME), Chrome and ffmpeg.
// The Codex config's MCP servers are switched off for the run; nothing is
// written to CODEX_HOME. Each clip is checked against the voice's own
// transcript and recorded again when it said anything else.
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SENTENCE = '你好，我是这个声音，听起来怎么样？';
const ATTEMPTS = 3;

const args = parseArgs(process.argv.slice(2));
const codexBin = args.codex ?? 'codex';
const chromeBin = args.chrome ?? process.env.CHROME_BIN ?? defaultChrome();
const outDir = path.resolve(
  args.out ?? path.join(root, 'packages/components/src/assets/voice-previews')
);
const sentence = args.sentence ?? DEFAULT_SENTENCE;

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, '');
    const value = argv[index + 1];
    if (!key || value === undefined) throw new Error(`Missing value for ${argv[index]}`);
    parsed[key] = value;
  }
  return parsed;
}

function defaultChrome() {
  return process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome';
}

/** Punctuation and width differ between the transcript and the text asked for. */
const normalize = (text) =>
  text
    .normalize('NFKC')
    .replace(/[\s\p{P}]/gu, '')
    .toLowerCase();

function lineRpc(writer, reader, separator, onNotification) {
  let sequence = 0;
  let buffer = '';
  const pending = new Map();
  reader.setEncoding('utf8');
  reader.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf(separator)) >= 0) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + separator.length);
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        continue;
      }
      if (message.id != null && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
        else entry.resolve(message.result);
      } else if (message.method) {
        onNotification?.(message);
      }
    }
  });
  return {
    call(method, params = {}, { sessionId, timeoutMs = 45_000 } = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`No answer to ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        writer.write(
          JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + separator
        );
      });
    },
    notify(method, params = {}) {
      writer.write(JSON.stringify({ method, params }) + separator);
    },
  };
}

function mcpServersOff() {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const configPath = path.join(home, 'config.toml');
  if (!fs.existsSync(configPath)) return [];
  const names = new Set(
    [...fs.readFileSync(configPath, 'utf8').matchAll(/^\[mcp_servers\.([^\].]+)/gm)].map(
      (match) => match[1]
    )
  );
  return [...names].flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`]);
}

const prompt = (text) =>
  [
    'You are a voice sample. Your whole job is to read one line aloud.',
    `When the developer says "Read it now", say exactly this line, in its own language, with nothing before or after it, no acknowledgement, then stay silent: "${text}"`,
  ].join(' ');

// Runs in the page. The peer sends a silent track: realtime v3 only speaks
// while microphone audio flows, even when nobody says anything.
const OPEN_PEER = `(async () => {
  window.peer?.close();
  window.player?.pause();
  window.audioContext ??= new AudioContext();
  await audioContext.resume();
  const destination = audioContext.createMediaStreamDestination();
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  gain.gain.value = 0;
  oscillator.connect(gain).connect(destination);
  oscillator.start();
  window.peer = new RTCPeerConnection();
  peer.addTrack(destination.stream.getAudioTracks()[0], destination.stream);
  window.transcript = [];
  window.remoteStream = null;
  // Chrome only measures inbound audio energy for a stream that is played out.
  peer.ontrack = (event) => {
    window.remoteStream = new MediaStream([event.track]);
    window.player = new Audio();
    player.srcObject = remoteStream;
    player.play().catch(() => {});
  };
  window.events = peer.createDataChannel('oai-events');
  events.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'output_transcript.added' && typeof data.item?.text === 'string') transcript.push(data.item.text);
    } catch {}
  };
  await peer.setLocalDescription(await peer.createOffer());
  if (peer.iceGatheringState !== 'complete') {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 4000);
      peer.addEventListener('icegatheringstatechange', () => {
        if (peer.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); }
      });
    });
  }
  return peer.localDescription.sdp;
})()`;

const WAIT_CONNECTED = `new Promise((resolve, reject) => {
  const check = () => {
    if (peer.connectionState === 'connected' && events.readyState === 'open' && remoteStream) {
      clearTimeout(timer); resolve(true);
    }
  };
  const timer = setTimeout(() => reject(new Error('The call did not connect: ' + peer.connectionState)), 20000);
  peer.addEventListener('connectionstatechange', check);
  events.addEventListener('open', check);
  peer.addEventListener('track', () => setTimeout(check));
  check();
})`;

const START_RECORDING = `(() => {
  window.chunks = [];
  window.recorder = new MediaRecorder(remoteStream, { mimeType: 'audio/webm;codecs=opus' });
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
  recorder.start(100);
  return true;
})()`;

// Stops 1.5 s after the voice falls silent, or after 25 s without speech.
const RECORD_UNTIL_SILENT = `new Promise((resolve) => {
  let heard = false, quietTicks = 0, lastEnergy = 0;
  const started = Date.now();
  const tick = setInterval(async () => {
    const stats = await peer.getStats();
    let inbound;
    stats.forEach((entry) => { if (entry.type === 'inbound-rtp' && entry.kind === 'audio') inbound = entry; });
    const energy = inbound?.totalAudioEnergy ?? 0;
    const audible = energy - lastEnergy > 0.0005;
    lastEnergy = energy;
    if (audible) { heard = true; quietTicks = 0; } else if (heard) quietTicks += 1;
    if ((heard && quietTicks >= 6) || Date.now() - started > 25000) {
      clearInterval(tick);
      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        const base64 = await new Promise((done) => {
          const reader = new FileReader();
          reader.onload = () => done(String(reader.result).split(',')[1] ?? '');
          reader.readAsDataURL(blob);
        });
        resolve({ heard, base64, transcript: transcript.join('') });
      };
      recorder.stop();
    }
  }, 250);
})`;

function encode(rawPath, outPath) {
  // Trim leading and trailing silence, keep a short margin, mono Opus.
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
      '-i',
      rawPath,
      '-af',
      trim,
      '-ac',
      '1',
      '-c:a',
      'libopus',
      '-b:a',
      '32k',
      '-vn',
      outPath,
    ],
    { stdio: 'inherit' }
  );
}

function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-voice-previews-'));
  const notifications = new EventEmitter();
  const codex = spawn(codexBin, ['app-server', '--stdio', ...mcpServersOff()], {
    cwd: work,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const rpc = lineRpc(codex.stdin, codex.stdout, '\n', (message) =>
    notifications.emit('message', message)
  );
  let chrome;
  try {
    await rpc.call('initialize', {
      clientInfo: { name: 'lody_voice_previews', version: '1' },
      capabilities: { experimentalApi: true },
    });
    rpc.notify('initialized');
    const account = await rpc.call('account/read', { refreshToken: false });
    if (account.account?.type !== 'chatgpt') throw new Error('Codex is not signed in to ChatGPT');
    const listed = await rpc.call('thread/realtime/listVoices', {});
    // Realtime v3 calls take the list Codex keeps as `v1`, as Lody's adapter does.
    const voices = args.voices ? args.voices.split(',') : listed.voices.v1;

    chrome = spawn(
      chromeBin,
      [
        '--headless=new',
        // A Linux user without unprivileged namespaces cannot start the sandbox; the page is blank.
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-dev-shm-usage',
        '--autoplay-policy=no-user-gesture-required',
        `--user-data-dir=${path.join(work, 'chrome')}`,
        '--remote-debugging-pipe',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] }
    );
    const cdp = lineRpc(chrome.stdio[3], chrome.stdio[4], '\0');
    const { targetInfos } = await cdp.call('Target.getTargets');
    const page = targetInfos.find((target) => target.type === 'page');
    const { sessionId } = await cdp.call('Target.attachToTarget', {
      targetId: page.targetId,
      flatten: true,
    });
    const evaluate = async (expression, timeoutMs = 40_000) => {
      const result = await cdp.call(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        { sessionId, timeoutMs }
      );
      if (result.exceptionDetails)
        throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 600));
      return result.result.value;
    };

    for (const voice of voices) {
      let saved = false;
      for (let attempt = 1; attempt <= ATTEMPTS && !saved; attempt += 1) {
        const thread = await rpc.call('thread/start', {
          cwd: work,
          ephemeral: true,
          approvalPolicy: 'never',
          sandbox: 'read-only',
        });
        const threadId = thread.thread.id;
        const onMessage = (message) => {
          // The sample never delegates; a turn would only run Codex for nothing.
          if (message.method === 'turn/started' && message.params?.threadId === threadId) {
            rpc
              .call('turn/interrupt', { threadId, turnId: message.params.turn.id })
              .catch(() => {});
          }
        };
        notifications.on('message', onMessage);
        try {
          const offer = await evaluate(OPEN_PEER);
          const answer = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Codex sent no SDP answer')), 30_000);
            const listener = (message) => {
              if (message.params?.threadId !== threadId) return;
              if (message.method === 'thread/realtime/sdp') resolve(message.params.sdp);
              else if (message.method === 'thread/realtime/error')
                reject(new Error(message.params.message));
              else return;
              clearTimeout(timer);
              notifications.off('message', listener);
            };
            notifications.on('message', listener);
          });
          await rpc.call('thread/realtime/start', {
            threadId,
            version: 'v3',
            outputModality: 'audio',
            includeStartupContext: false,
            clientManagedHandoffs: true,
            delegationAckFiller: false,
            prompt: prompt(sentence),
            voice,
            transport: { type: 'webrtc', sdp: offer },
          });
          const sdp = await answer;
          await evaluate(
            `peer.setRemoteDescription(${JSON.stringify({ type: 'answer', sdp })}).then(() => true)`
          );
          await evaluate(WAIT_CONNECTED);
          await evaluate(START_RECORDING);
          await rpc.call('thread/realtime/appendText', {
            threadId,
            role: 'developer',
            text: 'Read it now',
          });
          const take = await evaluate(RECORD_UNTIL_SILENT);
          if (!take.heard || normalize(take.transcript) !== normalize(sentence)) {
            console.warn(`${voice}: attempt ${attempt} said "${take.transcript}"; recording again`);
            continue;
          }
          const rawPath = path.join(work, `${voice}.raw.webm`);
          fs.writeFileSync(rawPath, Buffer.from(take.base64, 'base64'));
          const outPath = path.join(outDir, `${voice}.webm`);
          encode(rawPath, outPath);
          console.log(
            `${voice}: ${fs.statSync(outPath).size} bytes -> ${path.relative(root, outPath)}`
          );
          saved = true;
        } finally {
          notifications.off('message', onMessage);
          await rpc
            .call('thread/realtime/stop', { threadId }, { timeoutMs: 5_000 })
            .catch(() => {});
        }
      }
      if (!saved) throw new Error(`${voice}: no clean take in ${ATTEMPTS} attempts`);
    }
  } finally {
    await Promise.all([stopProcess(chrome), stopProcess(codex)]);
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5 });
  }
}

await main();
