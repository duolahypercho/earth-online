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
  filter.Q.value = 0.8;
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

  const startAt = audioContext.currentTime + 0.03;
  voiceA.start(startAt);
  voiceB.start(startAt);

  let active = true;
  let speed = 0;

  function update(nextSpeed = 0, throttle = 0) {
    if (!active) return;
    speed = Math.max(0, Number(nextSpeed) || 0);
    const t = audioContext.currentTime;
    const base = 46 + Math.min(26, speed * 3.2);
    voiceA.frequency.setTargetAtTime(base * 1.012, t, 0.05);
    voiceB.frequency.setTargetAtTime(base * 0.5, t, 0.05);
    filter.frequency.setTargetAtTime(240 + speed * 34 + throttle * 260, t, 0.08);
    const target = Math.min(0.16, 0.035 + speed * 0.012 + throttle * 0.04);
    master.gain.setTargetAtTime(target, t, 0.12);
  }

  function stop() {
    if (!active) return;
    active = false;
    const t = audioContext.currentTime;
    master.gain.setTargetAtTime(0, t, 0.12);
    const later = t + 0.5;
    voiceA.stop(later);
    voiceB.stop(later);
    window.setTimeout(() => {
      try {
        voiceA.disconnect();
        voiceB.disconnect();
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
    gain.gain.setTargetAtTime(target, t, 0.2);
    filter.frequency.setTargetAtTime(420 + speedRatio * 720, t, 0.2);
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

export function disposeAudioNodes(...nodes) {
  nodes.forEach((node) => {
    try {
      node?.disconnect?.();
    } catch {
      // Already detached.
    }
  });
}
