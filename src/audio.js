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

export function disposeAudioNodes(...nodes) {
  nodes.forEach((node) => {
    try {
      node?.disconnect?.();
    } catch {
      // Already detached.
    }
  });
}
