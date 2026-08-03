/**
 * Per-role and streamed-activity behavior trees.
 * Trees set bb.intent / bb.animCue / bb.urgency only — no mesh mutation.
 */

import {
  Action,
  Condition,
  Inverter,
  Parallel,
  Selector,
  Sequence,
  Succeeder,
  Wait,
  bbIntent,
  bbSet,
} from './npc-behavior-tree.js';

const INTENTS = Object.freeze({
  WALK: 'walk',
  IDLE: 'idle',
  WORK: 'work',
  CROSS: 'cross',
  SOCIALIZE: 'socialize',
});

function setIntent(intent, animCue, urgency) {
  return new Action((bb) => {
    bbIntent(bb, intent, animCue, urgency);
    return undefined;
  }, `SetIntent:${intent}`);
}

function when(key, value = true) {
  return new Condition((bb) => {
    if (value === true) return Boolean(bb[key]);
    return bb[key] === value;
  }, `When:${key}=${value}`);
}

function whenAny(key, values) {
  return new Condition((bb) => values.includes(bb[key]), `WhenAny:${key}`);
}

function walkCue(cue, urgency = 0.55) {
  return setIntent(INTENTS.WALK, cue, urgency);
}

function idleCue(cue, urgency = 0.35) {
  return setIntent(INTENTS.IDLE, cue, urgency);
}

function workCue(cue, urgency = 0.45) {
  return setIntent(INTENTS.WORK, cue, urgency);
}

function crossCue(cue, urgency = 0.6) {
  return setIntent(INTENTS.CROSS, cue, urgency);
}

function waitIdle(seconds, cue = 'weight-shift') {
  return new Sequence([
    idleCue(cue, 0.3),
    new Wait(seconds, `WaitIdle:${seconds}`),
  ], `Pause:${seconds}`);
}

function crossingBranch(waitCue = 'curb-wait', crossAnim = 'cross-walk') {
  return new Sequence([
    when('atCrossing'),
    new Selector([
      new Sequence([
        when('signalClear', false),
        crossCue(waitCue, 0.5),
        new Wait(1.2, 'WaitSignal'),
      ], 'WaitForSignal'),
      new Sequence([
        when('signalClear'),
        crossCue(crossAnim, 0.65),
      ], 'CrossNow'),
    ], 'CrossDecision'),
  ], 'Crossing');
}

function arriveBranch(idleCueName, workCueName, idleSec = 1.4, workSec = 3.0) {
  return new Sequence([
    when('atDestination'),
    new Selector([
      new Sequence([
        when('preferWork'),
        workCue(workCueName, 0.5),
        new Wait(workSec, 'ArriveWork'),
      ], 'ArriveWork'),
      new Sequence([
        idleCue(idleCueName, 0.4),
        new Wait(idleSec, 'ArriveIdle'),
      ], 'ArriveIdle'),
    ], 'ArriveChoice'),
  ], 'Arrive');
}

function resumeWalk(cue = 'resume-walk', urgency = 0.55) {
  return new Sequence([
    walkCue(cue, urgency),
    new Action((bb) => {
      bbSet(bb, 'atDestination', false);
      bbSet(bb, 'atCrossing', false);
      return undefined;
    }, 'ClearArrival'),
  ], 'ResumeWalk');
}

function commuterTree() {
  return new Selector([
    crossingBranch('curb-wait', 'office-cross'),
    arriveBranch('office-pause', 'briefcase-check', 1.6, 2.8),
    new Sequence([
      walkCue('commute-stride', 0.58),
    ], 'NavigateSidewalk'),
    resumeWalk('commute-resume', 0.58),
  ], 'CommuterRoot');
}

function courierTree() {
  return new Selector([
    crossingBranch('delivery-curb', 'quick-cross'),
    new Sequence([
      when('atDestination'),
      new Selector([
        new Sequence([
          when('handoffReady'),
          workCue('handoff-gesture', 0.72),
          new Wait(2.2, 'Handoff'),
        ], 'Handoff'),
        new Sequence([
          walkCue('approach-door', 0.78),
          new Wait(1.0, 'ApproachDoor'),
        ], 'ApproachDoor'),
      ], 'DeliveryStop'),
    ], 'DeliverRoute'),
    walkCue('delivery-route', 0.75),
    resumeWalk('delivery-resume', 0.75),
  ], 'CourierRoot');
}

function baristaTree() {
  return new Selector([
    crossingBranch('cafe-curb', 'cafe-cross'),
    new Sequence([
      when('atDestination'),
      new Selector([
        new Sequence([
          when('preferWork'),
          workCue('pour-serve', 0.42),
          new Wait(4.5, 'StationWork'),
        ], 'StationWork'),
        waitIdle(2.0, 'counter-idle'),
      ], 'CounterLoop'),
    ], 'AtCounter'),
    walkCue('short-walk', 0.48),
    resumeWalk('barista-resume', 0.48),
  ], 'BaristaRoot');
}

function workerTree() {
  return new Selector([
    crossingBranch('jobsite-curb', 'jobsite-cross'),
    new Sequence([
      when('atDestination'),
      new Selector([
        new Sequence([
          when('preferWork'),
          workCue('tool-work', 0.55),
          new Wait(5.5, 'ToolWork'),
        ], 'ToolWork'),
        waitIdle(2.2, 'rest-weight-shift'),
      ], 'WorkRest'),
    ], 'AtJobsite'),
    walkCue('purposeful-walk', 0.52),
    resumeWalk('worker-resume', 0.52),
  ], 'WorkerRoot');
}

function touristTree() {
  return new Selector([
    crossingBranch('sightsee-curb', 'tourist-cross'),
    new Sequence([
      when('atDestination'),
      new Selector([
        new Sequence([
          when('preferWork'),
          workCue('photo-gesture', 0.38),
          new Wait(3.2, 'Photo'),
        ], 'Photo'),
        waitIdle(3.5, 'viewpoint-idle'),
        idleCue('sightsee-gaze', 0.32),
      ], 'Sightsee'),
    ], 'Viewpoint'),
    walkCue('wander-sightsee', 0.42),
    resumeWalk('tourist-resume', 0.42),
  ], 'TouristRoot');
}

function cleanerTree() {
  return new Selector([
    crossingBranch('cleanup-curb', 'cleanup-cross'),
    new Sequence([
      when('atDestination'),
      new Selector([
        new Sequence([
          when('preferWork'),
          workCue('sweep-work', 0.5),
          new Wait(5.0, 'SweepWork'),
        ], 'SweepWork'),
        new Sequence([
          walkCue('relocate', 0.55),
          new Wait(1.5, 'Relocate'),
        ], 'Relocate'),
      ], 'CleanLoop'),
    ], 'CleanupZone'),
    walkCue('careful-walk', 0.5),
    resumeWalk('cleaner-resume', 0.5),
  ], 'CleanerRoot');
}

function phoneTree() {
  return new Selector([
    crossingBranch('phone-curb', 'distracted-cross'),
    new Sequence([
      when('atDestination'),
      new Selector([
        new Sequence([
          when('preferWork'),
          idleCue('phone-idle', 0.28),
          new Wait(4.0, 'PhoneIdle'),
        ], 'PhoneIdle'),
        new Sequence([
          idleCue('glance-around', 0.3),
          new Wait(1.8, 'Glance'),
        ], 'GlanceAround'),
      ], 'PhonePause'),
    ], 'PhoneStop'),
    walkCue('slow-walk', 0.38),
    resumeWalk('phone-resume', 0.38),
  ], 'PhoneRoot');
}

const ROLE_TREE_FACTORIES = Object.freeze({
  commuter: commuterTree,
  courier: courierTree,
  barista: baristaTree,
  worker: workerTree,
  tourist: touristTree,
  cleaner: cleanerTree,
  phone: phoneTree,
});

export const CORE_ROLE_IDS = Object.freeze(Object.keys(ROLE_TREE_FACTORIES));

export function createTreeForRole(roleId) {
  const factory = ROLE_TREE_FACTORIES[roleId];
  if (!factory) throw new Error(`Unknown core NPC role: ${roleId}`);
  return factory();
}

function streamedCommuting() {
  return new Selector([
    crossingBranch('stream-curb', 'stream-cross'),
    walkCue('stream-commute', 0.6),
  ], 'StreamCommuting');
}

function streamedWorking(cue = 'stream-work', urgency = 0.48) {
  return new Selector([
    new Sequence([
      when('atDestination'),
      workCue(cue, urgency),
      new Wait(3.0, 'StreamWork'),
    ], 'StreamWorkStop'),
    walkCue('stream-walk', 0.52),
  ], 'StreamWorking');
}

function streamedDwell(idleCueName = 'stream-idle', dwellWorkCue = 'stream-dwell-work') {
  return new Selector([
    new Sequence([
      when('atDestination'),
      new Selector([
        new Sequence([
          when('preferWork'),
          workCue(dwellWorkCue, 0.4),
          new Wait(4.0, 'StreamDwellWork'),
        ], 'DwellWork'),
        idleCue(idleCueName, 0.32),
      ], 'DwellChoice'),
    ], 'StreamDwell'),
    walkCue('stream-amble', 0.45),
  ], 'StreamDwellRoot');
}

function streamedResting() {
  return new Parallel([
    idleCue('rest-idle', 0.22),
    new Succeeder(new Wait(6.0, 'RestDuration')),
  ], 'requireOne', 'StreamResting');
}

function streamedTouring() {
  return new Selector([
    new Sequence([
      when('atDestination'),
      new Selector([
        workCue('stream-photo', 0.36),
        idleCue('stream-gaze', 0.3),
      ], 'TourStop'),
    ], 'TourPoint'),
    walkCue('stream-tour', 0.44),
  ], 'StreamTouring');
}

function streamedRunning() {
  return new Selector([
    crossingBranch('run-curb', 'run-cross'),
    walkCue('stream-run', 0.85),
  ], 'StreamRunning');
}

function streamedShift() {
  return new Selector([
    new Sequence([
      when('atDestination'),
      workCue('stream-shift', 0.62),
      new Wait(2.5, 'ShiftHandoff'),
    ], 'ShiftStop'),
    walkCue('stream-shift-walk', 0.68),
  ], 'StreamShift');
}

function streamedReturning() {
  return new Selector([
    new Sequence([
      when('atDestination'),
      idleCue('stream-return-idle', 0.35),
      new Wait(1.5, 'ReturnPause'),
    ], 'ReturnStop'),
    walkCue('stream-return', 0.55),
  ], 'StreamReturning');
}

function streamedService() {
  return streamedWorking('stream-service', 0.58);
}

function streamedLunch() {
  return streamedDwell('lunch-idle', 'lunch-eat');
}

const STREAMED_ACTIVITY_FACTORIES = Object.freeze({
  commuting: streamedCommuting,
  working: () => streamedWorking(),
  shopping: () => streamedDwell('shop-idle', 'shop-browse'),
  studying: () => streamedWorking('stream-study', 0.42),
  leisure: () => streamedDwell('leisure-idle', 'leisure-activity'),
  resting: streamedResting,
  lunch: streamedLunch,
  touring: streamedTouring,
  errands: () => streamedDwell('errand-idle', 'errand-task'),
  shift: streamedShift,
  returning: streamedReturning,
  service: streamedService,
  running: streamedRunning,
});

export const STREAMED_ACTIVITY_IDS = Object.freeze(Object.keys(STREAMED_ACTIVITY_FACTORIES));

export function createStreamedTreeForActivity(activity) {
  const factory = STREAMED_ACTIVITY_FACTORIES[activity];
  if (!factory) {
    return new Selector([
      walkCue('stream-fallback', 0.5),
    ], `StreamFallback:${activity}`);
  }
  return factory();
}

export function describeTree(node, depth = 0) {
  const indent = '  '.repeat(depth);
  const label = node.name || node.constructor.name;
  const lines = [`${indent}${label}`];
  if (node.children) {
    for (const child of node.children) lines.push(...describeTree(child, depth + 1));
  } else if (node.child) {
    lines.push(...describeTree(node.child, depth + 1));
  }
  return lines;
}

export function treeStructureForRole(roleId) {
  return describeTree(createTreeForRole(roleId)).join('\n');
}

export function treeStructureForActivity(activity) {
  return describeTree(createStreamedTreeForActivity(activity)).join('\n');
}
