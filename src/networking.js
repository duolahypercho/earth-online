import * as THREE from 'three';
import {
  createPlayerAvatar,
  animatePlayerAvatar,
  createNameTagSprite,
  createRemoteCar,
  updateRemoteCar,
} from './player.js';

const DEFAULT_PORT = 8787;
const STATE_INTERVAL = 1 / 14;
const PEER_TIMEOUT = 6000;
const PEER_GAMEPLAY_EVENT_LIFETIME = 6000;
const REMOTE_CAR_FALLBACK = '__fallback__';
const GAMEPLAY_ACTIVITIES = new Set([
  'idle', 'walking', 'driving', 'aiming', 'wanted', 'pursuit', 'working', 'downed',
]);
const GAMEPLAY_HEALTH_BANDS = new Set(['healthy', 'injured', 'critical', 'downed']);
const MISSION_STATUSES = new Set(['running', 'complete', 'failed']);
const GAMEPLAY_EVENT_KINDS = new Set([
  'arrested',
  'critical',
  'escaped',
  'high-heat',
  'near-miss',
  'pedestrian-impact',
  'pursuit-start',
  'responder-contact',
  'traffic-violation',
  'vehicle-theft',
  'witness-dispatch',
  'witness-report',
  'reckless-collision',
]);

function boundedInteger(value, min, max, fallback = min) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function sanitizeGameplayEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const id = String(event.id || '').trim().slice(0, 48);
  const kind = String(event.kind || '').trim();
  if (!id || !GAMEPLAY_EVENT_KINDS.has(kind)) return null;
  return {
    id,
    kind,
    message: String(event.message || '').trim().slice(0, 96),
    heat: boundedInteger(event.heat, 0, 100),
    wantedLevel: boundedInteger(event.wantedLevel, 0, 3),
  };
}

function sanitizeGameplayStatus(gameplay) {
  if (!gameplay || typeof gameplay !== 'object') return null;
  const activity = GAMEPLAY_ACTIVITIES.has(gameplay.activity) ? gameplay.activity : 'idle';
  const healthBand = GAMEPLAY_HEALTH_BANDS.has(gameplay.healthBand)
    ? gameplay.healthBand
    : 'healthy';
  const pursuitActive = gameplay.pursuitActive === true;
  const event = sanitizeGameplayEvent(gameplay.event);
  const eventId = String(gameplay.eventId || event?.id || '').trim().slice(0, 48) || null;
  return {
    heat: boundedInteger(gameplay.heat, 0, 100),
    wantedLevel: pursuitActive
      ? Math.max(1, boundedInteger(gameplay.wantedLevel, 0, 3))
      : 0,
    pursuitActive,
    healthBand,
    activity,
    eventId,
    event,
  };
}

function sanitizeMissionPresence(mission) {
  if (!mission || typeof mission !== 'object' || Array.isArray(mission)) return null;
  const revision = Number(mission.revision);
  const completedSteps = Number(mission.completedSteps);
  const totalSteps = Number(mission.totalSteps);
  if (!Number.isInteger(revision)
    || revision < 1
    || revision > 1000000000
    || !MISSION_STATUSES.has(mission.status)
    || !Number.isInteger(completedSteps)
    || !Number.isInteger(totalSteps)
    || totalSteps < 1
    || totalSteps > 24
    || completedSteps < 0
    || completedSteps > totalSteps) return null;
  return {
    revision,
    status: mission.status,
    completedSteps,
    totalSteps,
    objective: String(mission.objective || '').trim().slice(0, 72),
  };
}

function endpointFromLocation() {
  const query = new URLSearchParams(window.location.search);
  if (query.get('net')) return query.get('net');
  const host = window.location.hostname || 'localhost';
  return `ws://${host}:${DEFAULT_PORT}`;
}

function peerColor(peerId) {
  let hash = 0;
  for (let i = 0; i < peerId.length; i += 1) {
    hash = (hash * 31 + peerId.charCodeAt(i)) >>> 0;
  }
  return hash % 6;
}

export function createNetworking({
  scene,
  camera,
  traffic,
  hud,
  audioContext,
  getLocalState,
  onChatMessage,
  onPeerGameplayEvent,
  onPeerGameplayEventClear,
  onConnectionChange,
} = {}) {
  if (typeof WebSocket === 'undefined' || typeof document === 'undefined') return null;

  const peers = new Map();
  const state = {
    connected: false,
    id: null,
    name: 'Traveler',
    color: 0,
    voiceOn: false,
    talking: false,
    micAvailable: false,
    error: null,
  };
  let ws = null;
  let stateTimer = 0;
  let mapUpdateTimer = 0;
  let reconnectTimer = null;
  let disposed = false;
  let localStream = null;
  let voiceAnalyser = null;
  let voiceSource = null;
  let voiceSampleTimer = 0;
  let voiceTimeData = new Uint8Array(0);

  const room = new THREE.Group();
  room.name = 'Remote online players';
  room.visible = true;
  scene.add(room);

  function broadcastSnapshot() {
    hud?.setOnlineState?.({
      connected: state.connected,
      playerName: state.name,
      voiceOn: state.voiceOn,
      talking: state.talking,
      micAvailable: state.micAvailable,
      error: state.error,
      peers: [...peers.values()].map((peer) => ({
        id: peer.id,
        name: peer.name,
        talking: peer.talking,
        driving: peer.state?.mode === 'drive',
        connected: peer.connected,
        x: peer.targetPosition?.x ?? null,
        z: peer.targetPosition?.z ?? null,
        gameplay: peer.gameplay ? { ...peer.gameplay, event: null } : null,
        mission: peer.mission ? { ...peer.mission } : null,
        gameplayEventCount: peer.gameplayEventCount,
        lastGameplayEvent: peer.lastGameplayEvent ? { ...peer.lastGameplayEvent } : null,
      })),
    });
  }

  function peerMapSnapshot() {
    return [...peers.values()].map((peer) => ({
      id: peer.id,
      name: peer.name,
      talking: peer.talking,
      driving: peer.state?.mode === 'drive',
      x: peer.targetPosition?.x ?? null,
      z: peer.targetPosition?.z ?? null,
      gameplay: peer.gameplay ? { ...peer.gameplay, event: null } : null,
      mission: peer.mission ? { ...peer.mission } : null,
    }));
  }

  function send(payload) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  function scheduleReconnect() {
    if (disposed || reconnectTimer) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 4000);
  }

  function connect() {
    if (disposed) return;
    try {
      ws = new WebSocket(endpointFromLocation());
    } catch (error) {
      state.error = String(error?.message || error);
      broadcastSnapshot();
      scheduleReconnect();
      return;
    }
    ws.addEventListener('open', () => {
      state.error = null;
      state.connected = true;
      send({
        type: 'join',
        name: state.name,
        color: state.color,
      });
      broadcastSnapshot();
    });
    ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      handleMessage(message);
    });
    ws.addEventListener('close', () => {
      state.connected = false;
      state.voiceOn = false;
      state.talking = false;
      cleanupAllPeers();
      broadcastSnapshot();
      scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      state.error = 'Multiplayer relay unreachable. Running solo.';
      broadcastSnapshot();
    });
  }

  function handleMessage(message) {
    if (message?.type === 'welcome') {
      state.id = message.id;
      // The boot flow already owns the local alias. The server welcome only
      // carries its default, so never let it overwrite a chosen name.
      if (!state.name || state.name === 'Traveler') {
        state.name = message.name || state.name;
      }
      for (const peer of message.peers || []) {
        addPeer(peer);
      }
      broadcastSnapshot();
    } else if (message?.type === 'peer:join') {
      addPeer(message.peer);
      broadcastSnapshot();
    } else if (message?.type === 'peer:leave') {
      removePeer(message.id);
      broadcastSnapshot();
    } else if (message?.type === 'state') {
      const peer = peers.get(message.from);
      if (!peer) return;
    peer.lastSeen = performance.now();
    peer.name = message.name || peer.name;
    if (peer.name !== peer.displayName) {
      refreshPeerNameTag(peer);
    }
    if (applyPeerState(peer, message)) broadcastSnapshot();
    } else if (message?.type === 'chat') {
      onChatMessage?.({
        id: message.from,
        name: message.name,
        text: message.text,
        local: message.from === state.id,
      });
    } else if (message?.type === 'rtc') {
      handleRtc(message.from, message.data);
    } else if (message?.type === 'roster') {
      for (const peer of message.peers || []) {
        if (peer.id === state.id) continue;
        if (peers.has(peer.id)) continue;
        addPeer(peer);
      }
      for (const [id, peer] of peers) {
        const alive = (message.peers || []).some((candidate) => candidate.id === id);
        if (!alive) removePeer(id);
      }
      broadcastSnapshot();
    }
  }

  function addPeer(peerInfo) {
    if (!peerInfo?.id || peers.has(peerInfo.id)) return;
    const peer = {
      id: peerInfo.id,
      name: peerInfo.name || 'Player',
      displayName: peerInfo.name || 'Player',
      color: Number.isFinite(peerInfo.color) ? peerInfo.color : peerColor(peerInfo.id),
      avatar: null,
      nameTag: null,
      car: null,
      carOwner: false,
      state: null,
      targetPosition: new THREE.Vector3(24, 0, 48),
      targetYaw: Math.PI,
      yaw: Math.PI,
      headingSm: Math.PI,
      moving: false,
      talking: false,
      gameplay: null,
      mission: null,
      missionRevision: 0,
      gameplayEventCount: 0,
      lastGameplayEvent: null,
      lastGameplayEventId: null,
      lastGameplayEventAt: 0,
      connected: true,
      lastSeen: performance.now(),
      panner: null,
      streamSource: null,
      pc: null,
      pendingIce: [],
    };
    peer.avatar = createPlayerAvatar({ name: peer.name, paletteIndex: peer.color, scale: 0.94 });
    peer.displayName = peer.name;
    peer.avatar.visible = false;
    room.add(peer.avatar);
    peers.set(peer.id, peer);
  }

  function refreshPeerNameTag(peer) {
    if (!peer.avatar) return;
    const previous = peer.avatar.userData?.nameTag;
    if (previous) {
      peer.avatar.remove(previous);
      previous.material?.map?.dispose?.();
      previous.material?.dispose?.();
    }
    const sprite = createNameTagSprite(peer.name);
    sprite.position.set(0, 2.18, 0);
    peer.avatar.add(sprite);
    if (peer.avatar.userData) peer.avatar.userData.nameTag = sprite;
    peer.displayName = peer.name;
  }

  function removePeer(id) {
    const peer = peers.get(id);
    if (!peer) return;
    clearRemoteCar(peer);
    closePeerConnection(peer);
    if (peer.avatar) {
      room.remove(peer.avatar);
      disposeAvatar(peer.avatar);
    }
    if (peer.car?.fallbackMesh) {
      room.remove(peer.car.fallbackMesh);
      disposeAvatar(peer.car.fallbackMesh);
    }
    onPeerGameplayEventClear?.({ peerId: peer.id, peerName: peer.name });
    peers.delete(id);
  }

  function cleanupAllPeers() {
    for (const peer of peers.values()) {
      clearRemoteCar(peer);
      closePeerConnection(peer);
      if (peer.avatar) {
        room.remove(peer.avatar);
        disposeAvatar(peer.avatar);
      }
      if (peer.car?.fallbackMesh) {
        room.remove(peer.car.fallbackMesh);
        disposeAvatar(peer.car.fallbackMesh);
      }
      onPeerGameplayEventClear?.({ peerId: peer.id, peerName: peer.name });
    }
    peers.clear();
  }

  function disposeAvatar(object) {
    if (object?.userData?.playerRig === true) return;
    object?.traverse?.((child) => {
      if (child.isMesh) {
        child.geometry?.dispose?.();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((material) => material?.dispose?.());
      }
    });
  }

  function applyPeerState(peer, incoming) {
    const hadDrive = peer.state?.mode === 'drive';
    const hasDrive = incoming.mode === 'drive';
    const previousGameplay = peer.gameplay;
    const previousMission = peer.mission;
    const gameplay = sanitizeGameplayStatus(incoming.gameplay);
    const incomingMission = sanitizeMissionPresence(incoming.mission);
    let receivedGameplayEvent = false;
    if (gameplay?.event && gameplay.event.id !== peer.lastGameplayEventId) {
      peer.lastGameplayEventId = gameplay.event.id;
      peer.lastGameplayEvent = gameplay.event;
      peer.gameplayEventCount += 1;
      peer.lastGameplayEventAt = performance.now();
      receivedGameplayEvent = true;
      onPeerGameplayEvent?.({
        peerId: peer.id,
        peerName: peer.name,
        event: { ...gameplay.event },
      });
    }
    const clearedGameplayEvent = gameplay?.eventId == null && peer.lastGameplayEvent != null;
    if (clearedGameplayEvent) {
      peer.lastGameplayEvent = null;
      peer.lastGameplayEventAt = 0;
      peer.gameplayEventCount = 0;
      onPeerGameplayEventClear?.({ peerId: peer.id, peerName: peer.name });
    }
    peer.gameplay = gameplay ? { ...gameplay, event: null } : null;
    if (incoming.mission == null) {
      peer.mission = null;
    } else if (incomingMission && incomingMission.revision > peer.missionRevision) {
      peer.mission = incomingMission;
      peer.missionRevision = incomingMission.revision;
    }
    peer.state = {
      mode: incoming.mode || 'walk',
      vehicleId: incoming.vehicleId ?? null,
      vehicleClass: incoming.vehicleClass || 'sedan',
      vehicleColor: incoming.vehicleColor ?? 0x3f6f8f,
    };
    peer.moving = incoming.moving === true;
    peer.talking = incoming.talking === true;
    peer.targetPosition.set(
      Number.isFinite(incoming.x) ? incoming.x : peer.targetPosition.x,
      Number.isFinite(incoming.y) ? incoming.y : peer.targetPosition.y,
      Number.isFinite(incoming.z) ? incoming.z : peer.targetPosition.z,
    );
    peer.targetYaw = Number.isFinite(incoming.yaw) ? incoming.yaw : peer.targetYaw;

    if (hasDrive && !hadDrive) {
      clearRemoteCar(peer);
      const car = attachTrafficCar(peer, incoming);
      if (!car) attachFallbackCar(peer, incoming);
    } else if (!hasDrive && hadDrive) {
      clearRemoteCar(peer);
    } else if (hasDrive) {
      const pose = {
        x: peer.targetPosition.x,
        y: peer.targetPosition.y,
        z: peer.targetPosition.z,
        yaw: peer.targetYaw,
      };
      const ok = traffic?.setRemotePose?.(incoming.vehicleId, pose);
      if (!ok && !peer.car?.fallbackMesh) {
        clearRemoteCar(peer);
        attachFallbackCar(peer, incoming);
      }
    }

    if (peer.avatar) {
      peer.avatar.visible = !hasDrive;
      if (!hasDrive) {
        peer.avatar.position.lerp(peer.targetPosition, 1 - Math.exp(-10 * 0.016));
      }
    }
    return receivedGameplayEvent || clearedGameplayEvent
      || previousGameplay?.heat !== peer.gameplay?.heat
      || previousGameplay?.wantedLevel !== peer.gameplay?.wantedLevel
      || previousGameplay?.pursuitActive !== peer.gameplay?.pursuitActive
      || previousGameplay?.healthBand !== peer.gameplay?.healthBand
      || previousGameplay?.activity !== peer.gameplay?.activity
      || previousMission?.revision !== peer.mission?.revision
      || previousMission?.status !== peer.mission?.status
      || previousMission?.completedSteps !== peer.mission?.completedSteps;
  }

  function attachTrafficCar(peer, incoming) {
    const pose = {
      x: peer.targetPosition.x,
      y: peer.targetPosition.y,
      z: peer.targetPosition.z,
      yaw: peer.targetYaw,
    };
    const ok = traffic?.setRemotePose?.(incoming.vehicleId, pose);
    if (!ok) return null;
    peer.car = { type: 'traffic', id: incoming.vehicleId };
    peer.carOwner = true;
    return peer.car;
  }

  function attachFallbackCar(peer, incoming) {
    const mesh = createRemoteCar({
      className: incoming.vehicleClass || 'sedan',
      color: incoming.vehicleColor ?? 0x3f6f8f,
      taxi: incoming.vehicleClass === 'taxi',
    });
    mesh.position.copy(peer.targetPosition);
    mesh.rotation.y = peer.targetYaw;
    room.add(mesh);
    peer.car = { type: 'fallback', id: REMOTE_CAR_FALLBACK, fallbackMesh: mesh };
  }

  function clearRemoteCar(peer) {
    if (peer.car?.type === 'traffic' && peer.carOwner) {
      traffic?.clearRemotePose?.(peer.car.id);
    }
    if (peer.car?.fallbackMesh) {
      room.remove(peer.car.fallbackMesh);
      disposeAvatar(peer.car.fallbackMesh);
    }
    peer.car = null;
    peer.carOwner = false;
  }

  function update(dt = 0.016, elapsed = 0) {
    if (!state.connected) return;
    voiceSampleTimer += dt;
    if (voiceAnalyser && state.voiceOn && voiceSampleTimer >= 0.12) {
      voiceSampleTimer = 0;
      voiceAnalyser.getByteTimeDomainData(voiceTimeData);
      let sum = 0;
      for (let i = 0; i < voiceTimeData.length; i += 1) {
        const centered = (voiceTimeData[i] - 128) / 128;
        sum += centered * centered;
      }
      const rms = Math.sqrt(sum / Math.max(1, voiceTimeData.length));
      const nextTalking = rms > 0.012;
      if (nextTalking !== state.talking) {
        state.talking = nextTalking;
        broadcastSnapshot();
      }
    }
    stateTimer += dt;
    mapUpdateTimer += dt;
    if (mapUpdateTimer >= 0.3) {
      mapUpdateTimer = 0;
      hud?.setMapRemoteState?.(peerMapSnapshot());
    }
    if (stateTimer >= STATE_INTERVAL) {
      stateTimer = 0;
      const local = getLocalState?.() || {};
      send({
        type: 'state',
        name: state.name,
        color: state.color,
        x: local.x,
        y: local.y,
        z: local.z,
        yaw: local.yaw,
        mode: local.mode || 'walk',
        moving: Boolean(local.moving),
        talking: state.talking,
        vehicleId: local.vehicleId ?? null,
        vehicleClass: local.vehicleClass || null,
        vehicleColor: local.vehicleColor ?? null,
        gameplay: sanitizeGameplayStatus(local.gameplay),
        mission: sanitizeMissionPresence(local.mission),
      });
    }

    const now = performance.now();
    const lambda = 1 - Math.exp(-12 * dt);
    for (const peer of peers.values()) {
      if (now - peer.lastSeen > PEER_TIMEOUT) {
        removePeer(peer.id);
        broadcastSnapshot();
        continue;
      }
      if (!peer.connected) {
        peer.connected = true;
        broadcastSnapshot();
      }
      if (peer.lastGameplayEvent
        && now - peer.lastGameplayEventAt > PEER_GAMEPLAY_EVENT_LIFETIME) {
        peer.lastGameplayEvent = null;
        peer.lastGameplayEventAt = 0;
        peer.gameplayEventCount = 0;
        onPeerGameplayEventClear?.({ peerId: peer.id, peerName: peer.name });
        broadcastSnapshot();
      }
      peer.yaw = dampAngle(peer.yaw, peer.targetYaw, 10, dt);
      peer.headingSm = dampAngle(peer.headingSm, peer.yaw, 8, dt);
      if (peer.state?.mode === 'drive') {
        if (peer.car?.type === 'traffic') {
          traffic?.setRemotePose?.(peer.car.id, {
            x: peer.targetPosition.x,
            y: peer.targetPosition.y,
            z: peer.targetPosition.z,
            yaw: peer.targetYaw,
          });
        } else if (peer.car?.fallbackMesh) {
          peer.car.fallbackMesh.position.lerp(peer.targetPosition, lambda);
          peer.car.fallbackMesh.rotation.y = peer.yaw;
          updateRemoteCar(peer.car.fallbackMesh, {
            speed: peer.moving ? 11 : 0,
            delta: dt,
          });
        }
      } else if (peer.avatar) {
        peer.avatar.position.lerp(peer.targetPosition, lambda);
        peer.avatar.rotation.y = peer.headingSm;
        animatePlayerAvatar(peer.avatar, {
          moving: peer.moving,
          speedRatio: peer.moving ? 1 : 0,
          elapsed,
          delta: dt,
        });
      }
      if (peer.panner) {
        peer.panner.positionX.value = peer.targetPosition.x;
        peer.panner.positionY.value = peer.targetPosition.y + 1.55;
        peer.panner.positionZ.value = peer.targetPosition.z;
      }
    }

    if (audioContext && camera) {
      audioContext.listener.positionX.value = camera.position.x;
      audioContext.listener.positionY.value = camera.position.y;
      audioContext.listener.positionZ.value = camera.position.z;
      camera.getWorldDirection(tempForward);
      const up = tempUp.set(0, 1, 0);
      audioContext.listener.forwardX.value = tempForward.x;
      audioContext.listener.forwardY.value = tempForward.y;
      audioContext.listener.forwardZ.value = tempForward.z;
      audioContext.listener.upX.value = up.x;
      audioContext.listener.upY.value = up.y;
      audioContext.listener.upZ.value = up.z;
    }
  }

  /* ---- voice ---- */

  async function enableVoice() {
    if (!state.connected) {
      state.error = 'Join the multiplayer relay first, then enable voice.';
      broadcastSnapshot();
      return false;
    }
    if (state.voiceOn) {
      disableVoice();
      return true;
    }
    if (!audioContext) {
      state.error = 'Audio could not start. Refresh and enter the city again.';
      broadcastSnapshot();
      return false;
    }
    if (audioContext.state === 'suspended') {
      try {
        await audioContext.resume();
      } catch {
        // The gesture that enabled voice usually resumes the context.
      }
    }
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      state.error = 'Microphone permission was not granted.';
      state.micAvailable = false;
      broadcastSnapshot();
      return false;
    }
    if (audioContext) {
      try {
        voiceSource = audioContext.createMediaStreamSource(localStream);
        voiceAnalyser = audioContext.createAnalyser();
        voiceAnalyser.fftSize = 256;
        voiceAnalyser.smoothingTimeConstant = 0.42;
        const silentGain = audioContext.createGain();
        silentGain.gain.value = 0;
        voiceSource.connect(voiceAnalyser);
        voiceAnalyser.connect(silentGain);
        silentGain.connect(audioContext.destination);
        if (voiceTimeData.length !== voiceAnalyser.fftSize) {
          voiceTimeData = new Uint8Array(voiceAnalyser.fftSize);
        }
      } catch {
        voiceAnalyser = null;
        voiceSource = null;
      }
    }
    state.voiceOn = true;
    state.micAvailable = true;
    state.error = null;
    for (const peer of peers.values()) {
      if (!peer.pc) createPeerConnection(peer);
      let addedTracks = false;
      const hasLiveLocalSender = peer.pc.getSenders?.().some((sender) => (
        sender.track && localStream?.getTracks().some((track) => track.id === sender.track.id)
      ));
      if (localStream && !hasLiveLocalSender) {
        localStream.getTracks().forEach((track) => {
          peer.pc.addTrack(track, localStream);
        });
        addedTracks = true;
      }
      const canOffer = !peer.offered
        && !peer.pc.remoteDescription
        && state.id < peer.id;
      if (canOffer || (addedTracks && peer.pc.remoteDescription)) {
        sendOffer(peer);
      }
    }
    broadcastSnapshot();
    return true;
  }

  function disableVoice() {
    state.voiceOn = false;
    state.talking = false;
    if (voiceSource) {
      try {
        voiceSource.disconnect();
      } catch {
        // Already detached.
      }
      voiceSource = null;
    }
    if (voiceAnalyser) {
      try {
        voiceAnalyser.disconnect();
      } catch {
        // Already detached.
      }
      voiceAnalyser = null;
    }
    localStream?.getTracks().forEach((track) => track.stop());
    localStream = null;
    for (const peer of peers.values()) {
      closePeerConnection(peer);
    }
    broadcastSnapshot();
  }

  function createPeerConnection(peer) {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    });
    peer.pc = pc;
    if (localStream) {
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
    }
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        send({ type: 'rtc', to: peer.id, data: { kind: 'ice', candidate: event.candidate } });
      }
    };
    pc.ontrack = (event) => {
      if (!audioContext) return;
      const stream = event.streams?.[0]
        || (event.track ? new MediaStream([event.track]) : null);
      if (!stream) return;
      const panner = audioContext.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = 2.2;
      panner.maxDistance = 90;
      panner.rolloffFactor = 0.8;
      panner.connect(audioContext.destination);
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(panner);
      peer.panner = panner;
      peer.streamSource = source;
    };
    return pc;
  }

  function sendOffer(peer) {
    if (!peer.pc) createPeerConnection(peer);
    peer.offered = true;
    peer.pc.createOffer().then((offer) => {
      peer.pc.setLocalDescription(offer);
      send({ type: 'rtc', to: peer.id, data: { kind: 'offer', sdp: offer } });
    }).catch((error) => {
      peer.lastOfferError = String(error?.message || error);
    });
  }

  async function handleRtc(from, data) {
    const peer = peers.get(from);
    if (!peer) return;
    if (!peer.pc) createPeerConnection(peer);
    if (data.kind === 'offer') {
      try {
        await peer.pc.setRemoteDescription(data.sdp);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        peer.lastRtcError = null;
        send({ type: 'rtc', to: from, data: { kind: 'answer', sdp: answer } });
      } catch (error) {
        // Ignore transient negotiation races; the next offer recovers.
        peer.lastRtcError = String(error?.message || error);
      }
    } else if (data.kind === 'answer') {
      try {
        await peer.pc.setRemoteDescription(data.sdp);
        for (const candidate of peer.pendingIce) {
          await peer.pc.addIceCandidate(candidate);
        }
        peer.pendingIce = [];
        peer.lastRtcError = null;
      } catch (error) {
        // Ignore stale answers after a renegotiation.
        peer.lastRtcError = String(error?.message || error);
      }
    } else if (data.kind === 'ice') {
      try {
        if (peer.pc.remoteDescription) {
          await peer.pc.addIceCandidate(data.candidate);
        } else {
          peer.pendingIce.push(data.candidate);
        }
      } catch {
        // A late candidate can arrive after close; that is harmless.
      }
    }
  }

  function closePeerConnection(peer) {
    peer.offered = false;
    if (peer.pc) {
      peer.pc.onicecandidate = null;
      peer.pc.ontrack = null;
      peer.pc.close();
      peer.pc = null;
    }
    peer.pendingIce = [];
    if (peer.streamSource) {
      try {
        peer.streamSource.disconnect();
      } catch {
        // Already detached.
      }
      peer.streamSource = null;
    }
    if (peer.panner) {
      try {
        peer.panner.disconnect();
      } catch {
        // Already detached.
      }
      peer.panner = null;
    }
  }

  function setTalking(talking) {
    state.talking = Boolean(talking) && state.voiceOn && state.micAvailable;
    if (localStream) {
      localStream.getAudioTracks().forEach((track) => {
        track.enabled = state.talking;
      });
    }
    broadcastSnapshot();
  }

  function getVoiceDebug() {
    return [...peers.values()].map((peer) => ({
      id: peer.id,
      name: peer.name,
      connectionState: peer.pc?.connectionState ?? 'none',
      iceConnectionState: peer.pc?.iceConnectionState ?? 'none',
      hasRemoteAudio: Boolean(peer.panner && peer.streamSource),
      pendingIce: peer.pendingIce.length,
      lastRtcError: peer.lastRtcError ?? null,
      lastOfferError: peer.lastOfferError ?? null,
      senderCount: peer.pc?.getSenders?.().length ?? null,
      transceiverCount: peer.pc?.getTransceivers?.().length ?? null,
      transceiverDirections: peer.pc?.getTransceivers?.().map((transceiver) => transceiver.direction) ?? [],
      signalingState: peer.pc?.signalingState ?? null,
      localHasAudio: Boolean(peer.pc?.localDescription?.sdp?.includes('m=audio')),
      remoteHasAudio: Boolean(peer.pc?.remoteDescription?.sdp?.includes('m=audio')),
      localVoiceEnabled: state.voiceOn,
      talking: peer.talking,
    }));
  }

  function setName(name) {
    const next = String(name || '').trim().slice(0, 18) || 'Traveler';
    state.name = next;
    if (state.connected) send({ type: 'rename', name: next, color: state.color });
    broadcastSnapshot();
  }

  function sendChat(text) {
    const next = String(text || '').trim();
    if (!next) return;
    send({ type: 'chat', text: next.slice(0, 180) });
    onChatMessage?.({ id: state.id, name: state.name, text: next, local: true });
  }

  function dispose() {
    disposed = true;
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    disableVoice();
    cleanupAllPeers();
    ws?.close();
    room.remove();
  }

  const tempForward = new THREE.Vector3();
  const tempUp = new THREE.Vector3();
  function dampAngle(a, b, lambda, dt) {
    const delta = Math.atan2(Math.sin(b - a), Math.cos(b - a));
    return a + delta * (1 - Math.exp(-lambda * dt));
  }

  connect();
  return {
    update,
    setName,
    enableVoice,
    disableVoice,
    setTalking,
    getVoiceDebug,
    sendChat,
    getState: () => ({ ...state, peerCount: peers.size }),
    getPeers: () => [...peers.values()].map((peer) => ({
      id: peer.id,
      name: peer.name,
      talking: peer.talking,
      driving: peer.state?.mode === 'drive',
      x: peer.targetPosition?.x ?? null,
      z: peer.targetPosition?.z ?? null,
      gameplay: peer.gameplay ? { ...peer.gameplay } : null,
      mission: peer.mission ? { ...peer.mission } : null,
      gameplayEventCount: peer.gameplayEventCount,
      lastGameplayEvent: peer.lastGameplayEvent ? { ...peer.lastGameplayEvent } : null,
    })),
    dispose,
  };
}
