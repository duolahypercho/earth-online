/**
 * Procedural engine bed for the player car. Two detuned oscillators through a
 * low-pass filter give a restrained lowpoly vehicle voice without loading an
 * audio asset or fighting the city ambience.
 */
export function createEngineAudio(audioContext) {
  if (!audioContext || typeof audioContext.createOscillator !== 'function') return null;

  const master = audioContext.createGain();
  master.gain.value = 0;
  master.connect(audioContext.destination);

  const filter = audioContext.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 420;
  filter.Q.value = 0.9;
  filter.connect(master);

  const voiceA = audioContext.createOscillator();
  voiceA.type = 'sawtooth';
  voiceA.frequency.value = 52;
  const voiceAGain = audioContext.createGain();
  voiceAGain.gain.value = 0.5;
  voiceA.connect(voiceAGain);
  voiceAGain.connect(filter);

  const voiceB = audioContext.createOscillator();
  voiceB.type = 'triangle';
  voiceB.frequency.value = 26;
  const voiceBGain = audioContext.createGain();
  voiceBGain.gain.value = 0.7;
  voiceB.connect(voiceBGain);
  voiceBGain.connect(filter);

  const voiceC = audioContext.createOscillator();
  voiceC.type = 'sine';
  voiceC.frequency.value = 13;
  const voiceCGain = audioContext.createGain();
  voiceCGain.gain.value = 0.35;
  voiceC.connect(voiceCGain);
  voiceCGain.connect(filter);

  const startAt = audioContext.currentTime + 0.03;
  voiceA.start(startAt);
  voiceB.start(startAt);
  voiceC.start(startAt);

  let active = true;
  let speed = 0;

  function update(nextSpeed = 0, throttle = 0) {
    if (!active) return;
    speed = Math.max(0, Number(nextSpeed) || 0);
    const t = audioContext.currentTime;
    const base = 46 + Math.min(26, speed * 3.2);
    voiceA.frequency.setTargetAtTime(base * 1.012, t, 0.06);
    voiceB.frequency.setTargetAtTime(base * 0.5, t, 0.06);
    voiceC.frequency.setTargetAtTime(base * 0.28, t, 0.06);
    filter.frequency.setTargetAtTime(240 + speed * 34 + throttle * 260, t, 0.07);
    const target = Math.min(0.16, 0.035 + speed * 0.012 + throttle * 0.04);
    master.gain.setTargetAtTime(target, t, 0.14);
  }

  function stop() {
    if (!active) return;
    active = false;
    const t = audioContext.currentTime;
    master.gain.setTargetAtTime(0, t, 0.12);
    const later = t + 0.5;
    voiceA.stop(later);
    voiceB.stop(later);
    voiceC.stop(later);
    window.setTimeout(() => {
      try {
        voiceA.disconnect();
        voiceB.disconnect();
        voiceC.disconnect();
        filter.disconnect();
        master.disconnect();
      } catch {
        // Nodes may already be detached.
      }
    }, 600);
  }

  update(0, 0);
  return { update, stop, get speed() { return speed; } };
}

export function createWindAudio(audioContext) {
  if (!audioContext || typeof audioContext.createBufferSource !== 'function') return null;
  const buffer = audioContext.createBuffer(1, audioContext.sampleRate * 1.2, audioContext.sampleRate);
  const data = buffer.getChannelData(0);
  let phase = 0;
  for (let i = 0; i < data.length; i += 1) {
    phase += 0.05 + Math.random() * 0.12;
    data[i] = Math.sin(phase) * 0.28 + (Math.random() - 0.5) * 0.16;
  }
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  const filter = audioContext.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 520;
  filter.Q.value = 0.6;
  const gain = audioContext.createGain();
  gain.gain.value = 0;
  source.connect(filter);
  filter.connect(gain);
  gain.connect(audioContext.destination);
  source.start();

  let active = true;
  function update(speedRatio = 0) {
    if (!active) return;
    const t = audioContext.currentTime;
    const target = Math.min(0.05, speedRatio * speedRatio * 0.045);
    gain.gain.setTargetAtTime(target, t, 0.25);
    filter.frequency.setTargetAtTime(420 + speedRatio * 720, t, 0.25);
  }
  function stop() {
    if (!active) return;
    active = false;
    const t = audioContext.currentTime;
    gain.gain.setTargetAtTime(0, t, 0.16);
    source.stop(t + 0.4);
  }
  update(0);
  return { update, stop };
}

/**
 * Small procedural feedback voices for the HUD. Every cue is synthesized in
 * place so the game keeps shipping without audio assets while still landing
 * mission and life-sim beats with a distinct, premium-feeling sound.
 */
export function createUiAudio() {
  if (typeof window === 'undefined') return null;

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;

  let context = null;
  let master = null;
  let disposed = false;

  function ensureContext() {
    if (disposed) return null;
    if (context) return context;

    try {
      context = new AudioContextClass();
      master = context.createGain();
      master.gain.value = 0.5;
      const limiter = context.createDynamicsCompressor();
      limiter.threshold.value = -18;
      limiter.knee.value = 18;
      limiter.ratio.value = 8;
      limiter.attack.value = 0.004;
      limiter.release.value = 0.24;
      master.connect(limiter);
      limiter.connect(context.destination);
    } catch {
      context = null;
      master = null;
      return null;
    }

    return context;
  }

  function prime() {
    const ctx = ensureContext();
    if (!ctx || !master) return;
    if (ctx.state === 'suspended') ctx.resume?.().catch?.(() => {});
  }

  function tone({ frequency, at = 0, duration = 0.2, gain = 0.05, type = 'sine' } = {}) {
    const ctx = ensureContext();
    if (!ctx || !master || disposed) return;

    const t = ctx.currentTime + Math.max(0, at);
    const oscillator = ctx.createOscillator();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, t);

    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0.0001, t);
    envelope.gain.exponentialRampToValueAtTime(gain, t + 0.018);
    envelope.gain.setValueAtTime(gain, t + Math.max(0.01, duration * 0.45));
    envelope.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    oscillator.connect(envelope);
    envelope.connect(master);
    oscillator.start(t);
    oscillator.stop(t + duration + 0.06);
    oscillator.addEventListener('ended', () => {
      try {
        oscillator.disconnect();
        envelope.disconnect();
      } catch {
        // Nodes may already be detached.
      }
    });
  }

  function play(kind = 'info') {
    const ctx = ensureContext();
    if (!ctx || !master || disposed) return;
    if (ctx.state !== 'running') {
      prime();
      return;
    }

    switch (kind) {
      case 'objective': {
        tone({ frequency: 523.25, at: 0, duration: 0.26, gain: 0.06, type: 'triangle' });
        tone({ frequency: 659.25, at: 0.09, duration: 0.32, gain: 0.07, type: 'triangle' });
        break;
      }
      case 'complete': {
        tone({ frequency: 261.63, at: 0, duration: 0.5, gain: 0.055, type: 'sine' });
        tone({ frequency: 523.25, at: 0.06, duration: 0.36, gain: 0.06, type: 'triangle' });
        tone({ frequency: 659.25, at: 0.16, duration: 0.38, gain: 0.065, type: 'triangle' });
        tone({ frequency: 783.99, at: 0.26, duration: 0.52, gain: 0.055, type: 'sine' });
        break;
      }
      case 'low': {
        tone({ frequency: 392, at: 0, duration: 0.3, gain: 0.05, type: 'sine' });
        tone({ frequency: 329.63, at: 0.14, duration: 0.42, gain: 0.055, type: 'sine' });
        break;
      }
      default: {
        tone({ frequency: 740, at: 0, duration: 0.16, gain: 0.045, type: 'sine' });
      }
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    try {
      master?.disconnect();
    } catch {
      // Already detached.
    }
    if (context && context.state !== 'closed') {
      context.close?.().catch?.(() => {});
    }
    context = null;
    master = null;
  }

  return { prime, play, dispose };
}

/**
 * Bounded procedural combat cues. Semantic counters are recorded even when a
 * browser has not yet granted audio playback, which keeps combat state and QA
 * observable without bypassing the user-gesture policy.
 */
export function createCombatAudio() {
  if (typeof window === 'undefined') return null;

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const cueCounts = Object.create(null);
  const supportedCues = new Set([
    'shot',
    'impact',
    'defeat',
    'reload-start',
    'reload-complete',
    'damage',
    'downed',
    'revive',
  ]);
  const activeVoices = new Set();
  const maxVoices = 18;
  let context = null;
  let master = null;
  let limiter = null;
  let noiseBuffer = null;
  let disposed = false;
  let lastCue = null;
  let playCount = 0;

  function ensureContext() {
    if (disposed || !AudioContextClass) return null;
    if (context) return context;
    try {
      context = new AudioContextClass();
      master = context.createGain();
      master.gain.value = 0.58;
      limiter = context.createDynamicsCompressor();
      limiter.threshold.value = -16;
      limiter.knee.value = 12;
      limiter.ratio.value = 10;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.16;
      master.connect(limiter);
      limiter.connect(context.destination);
      noiseBuffer = context.createBuffer(1, Math.ceil(context.sampleRate * 0.5), context.sampleRate);
      const samples = noiseBuffer.getChannelData(0);
      let seed = 0x5f3759df;
      for (let index = 0; index < samples.length; index += 1) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        samples[index] = seed / 0xffffffff * 2 - 1;
      }
    } catch {
      context = null;
      master = null;
      limiter = null;
      noiseBuffer = null;
    }
    return context;
  }

  function registerVoice(source, ...nodes) {
    if (!source || activeVoices.size >= maxVoices) return false;
    const voice = { source, nodes };
    activeVoices.add(voice);
    source.addEventListener?.('ended', () => {
      activeVoices.delete(voice);
      [source, ...nodes].forEach((node) => {
        try {
          node?.disconnect?.();
        } catch {
          // The voice may already be detached during disposal.
        }
      });
    }, { once: true });
    return true;
  }

  function tone({ frequency, endFrequency = frequency, at = 0, duration = 0.12, gain = 0.08, type = 'triangle' }) {
    const ctx = ensureContext();
    if (!ctx || !master || ctx.state !== 'running' || activeVoices.size >= maxVoices) return;
    const start = ctx.currentTime + Math.max(0, at);
    const oscillator = ctx.createOscillator();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(Math.max(20, frequency), start);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), start + duration);
    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(gain, start + Math.min(0.012, duration * 0.2));
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(envelope);
    envelope.connect(master);
    if (!registerVoice(oscillator, envelope)) return;
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }

  function noise({ at = 0, duration = 0.08, gain = 0.08, frequency = 1100 } = {}) {
    const ctx = ensureContext();
    if (!ctx || !master || ctx.state !== 'running' || activeVoices.size >= maxVoices) return;
    if (!noiseBuffer) return;
    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = frequency;
    filter.Q.value = 0.72;
    const envelope = ctx.createGain();
    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(master);
    if (!registerVoice(source, filter, envelope)) return;
    const start = ctx.currentTime + Math.max(0, at);
    const maximumOffset = Math.max(0, noiseBuffer.duration - duration);
    const offset = maximumOffset > 0 ? (playCount * 0.037) % maximumOffset : 0;
    envelope.gain.setValueAtTime(gain, start);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    source.start(start, offset, duration);
    source.stop(start + duration + 0.02);
  }

  function play(kind = 'shot', details = {}) {
    if (disposed) return false;
    const cue = String(kind || 'shot');
    if (!supportedCues.has(cue)) return false;
    cueCounts[cue] = (cueCounts[cue] || 0) + 1;
    playCount += 1;
    lastCue = { kind: cue, targetKind: details.targetKind || null, playCount };
    const ctx = ensureContext();
    if (!ctx || !master) return false;
    if (ctx.state === 'suspended') ctx.resume?.().catch?.(() => {});

    switch (cue) {
      case 'shot':
        noise({ duration: 0.07, gain: 0.13, frequency: 1350 });
        tone({ frequency: 145, endFrequency: 72, duration: 0.1, gain: 0.11, type: 'square' });
        break;
      case 'impact':
        noise({ duration: 0.09, gain: 0.085, frequency: details.targetKind === 'traffic' ? 720 : 980 });
        tone({ frequency: 310, endFrequency: 185, duration: 0.13, gain: 0.07, type: 'triangle' });
        break;
      case 'defeat':
        tone({ frequency: 420, endFrequency: 210, duration: 0.22, gain: 0.075, type: 'sawtooth' });
        tone({ frequency: 190, endFrequency: 95, at: 0.08, duration: 0.28, gain: 0.07, type: 'triangle' });
        break;
      case 'reload-start':
        tone({ frequency: 760, endFrequency: 510, duration: 0.06, gain: 0.045, type: 'square' });
        tone({ frequency: 420, endFrequency: 620, at: 0.12, duration: 0.07, gain: 0.04, type: 'square' });
        break;
      case 'reload-complete':
        tone({ frequency: 610, endFrequency: 880, duration: 0.1, gain: 0.055, type: 'triangle' });
        break;
      case 'downed':
        tone({ frequency: 185, endFrequency: 48, duration: 0.65, gain: 0.09, type: 'sawtooth' });
        break;
      case 'revive':
        tone({ frequency: 220, endFrequency: 440, duration: 0.22, gain: 0.055, type: 'triangle' });
        tone({ frequency: 440, endFrequency: 660, at: 0.16, duration: 0.28, gain: 0.06, type: 'sine' });
        break;
      case 'damage':
        noise({ duration: 0.1, gain: 0.07, frequency: 460 });
        break;
      default:
        break;
    }
    return true;
  }

  function getState() {
    return {
      playCount,
      cueCounts: { ...cueCounts },
      lastCue: lastCue ? { ...lastCue } : null,
      activeVoices: activeVoices.size,
      maxVoices,
      contextState: context?.state || (AudioContextClass ? 'idle' : 'unavailable'),
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    activeVoices.forEach(({ source, nodes }) => {
      try {
        source?.stop?.();
      } catch {
        // A one-shot voice may have already ended.
      }
      [source, ...nodes].forEach((node) => {
        try {
          node?.disconnect?.();
        } catch {
          // Already detached.
        }
      });
    });
    activeVoices.clear();
    try {
      master?.disconnect?.();
      limiter?.disconnect?.();
    } catch {
      // Already detached.
    }
    if (context && context.state !== 'closed') context.close?.().catch?.(() => {});
    context = null;
    master = null;
    limiter = null;
    noiseBuffer = null;
  }

  return { play, getState, dispose };
}

export function disposeAudioNodes(...nodes) {
  nodes.forEach((node) => {
    try {
      node?.disconnect?.();
    } catch {
      // Already detached.
    }
  });
}
