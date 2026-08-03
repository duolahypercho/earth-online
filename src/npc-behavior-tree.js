/**
 * Lightweight behavior-tree runtime for NPC intent orchestration.
 * Simulation owns position/heading; trees emit intent/animCue/urgency on blackboard.
 */

export const Status = Object.freeze({
  SUCCESS: 1,
  FAILURE: 2,
  RUNNING: 3,
});

export function createBlackboard(initial = {}) {
  return {
    intent: null,
    animCue: null,
    urgency: 0.5,
    _waitRemaining: 0,
    _nodeState: new Map(),
    ...initial,
  };
}

export function bbGet(bb, key, fallback = undefined) {
  return bb[key] !== undefined ? bb[key] : fallback;
}

export function bbSet(bb, key, value) {
  bb[key] = value;
  return value;
}

export function bbIntent(bb, intent, animCue = null, urgency = null) {
  bb.intent = intent;
  if (animCue != null) bb.animCue = animCue;
  if (urgency != null) bb.urgency = urgency;
}

function nodeKey(node, suffix = '') {
  return `${node.name || node.constructor.name}:${suffix}`;
}

function getNodeState(bb, node) {
  if (!bb._nodeState.has(node)) bb._nodeState.set(node, {});
  return bb._nodeState.get(node);
}

export class Sequence {
  constructor(children = [], name = 'Sequence') {
    this.children = children;
    this.name = name;
  }

  tick(bb, dt) {
    const state = getNodeState(bb, this);
    let index = state.index ?? 0;
    while (index < this.children.length) {
      const status = tick(this.children[index], bb, dt);
      if (status === Status.RUNNING) {
        state.index = index;
        return Status.RUNNING;
      }
      if (status === Status.FAILURE) {
        state.index = 0;
        return Status.FAILURE;
      }
      index += 1;
    }
    state.index =  0;
    return Status.SUCCESS;
  }
}

export class Selector {
  constructor(children = [], name = 'Selector') {
    this.children = children;
    this.name = name;
  }

  tick(bb, dt) {
    const state = getNodeState(bb, this);
    let index = state.index ?? 0;
    while (index < this.children.length) {
      const status = tick(this.children[index], bb, dt);
      if (status === Status.RUNNING) {
        state.index = index;
        return Status.RUNNING;
      }
      if (status === Status.SUCCESS) {
        state.index = 0;
        return Status.SUCCESS;
      }
      index += 1;
    }
    state.index = 0;
    return Status.FAILURE;
  }
}

export class Parallel {
  constructor(children = [], policy = 'requireOne', name = 'Parallel') {
    this.children = children;
    this.policy = policy;
    this.name = name;
  }

  tick(bb, dt) {
    let successes = 0;
    let failures = 0;
    let running = 0;
    for (const child of this.children) {
      const status = tick(child, bb, dt);
      if (status === Status.SUCCESS) successes += 1;
      else if (status === Status.FAILURE) failures += 1;
      else running += 1;
    }
    if (this.policy === 'requireAll') {
      if (failures > 0) return Status.FAILURE;
      if (running > 0) return Status.RUNNING;
      return Status.SUCCESS;
    }
    if (successes > 0) return Status.SUCCESS;
    if (running > 0) return Status.RUNNING;
    return Status.FAILURE;
  }
}

export class Condition {
  constructor(fn, name = 'Condition') {
    this.fn = fn;
    this.name = name;
  }

  tick(bb) {
    return this.fn(bb) ? Status.SUCCESS : Status.FAILURE;
  }
}

export class Action {
  constructor(fn, name = 'Action') {
    this.fn = fn;
    this.name = name;
  }

  tick(bb, dt) {
    return this.fn(bb, dt) ?? Status.SUCCESS;
  }
}

export class Wait {
  constructor(duration, name = 'Wait') {
    this.duration = duration;
    this.name = name;
  }

  tick(bb, dt) {
    const state = getNodeState(bb, this);
    if (state.remaining == null) state.remaining = this.duration;
    state.remaining -= dt;
    if (state.remaining > 0) return Status.RUNNING;
    state.remaining = null;
    return Status.SUCCESS;
  }
}

export class Inverter {
  constructor(child, name = 'Inverter') {
    this.child = child;
    this.name = name;
  }

  tick(bb, dt) {
    const status = tick(this.child, bb, dt);
    if (status === Status.SUCCESS) return Status.FAILURE;
    if (status === Status.FAILURE) return Status.SUCCESS;
    return Status.RUNNING;
  }
}

export class Succeeder {
  constructor(child, name = 'Succeeder') {
    this.child = child;
    this.name = name;
  }

  tick(bb, dt) {
    const status = tick(this.child, bb, dt);
    return status === Status.RUNNING ? Status.RUNNING : Status.SUCCESS;
  }
}

export function tick(tree, blackboard, dt = 0) {
  if (!tree || typeof tree.tick !== 'function') return Status.FAILURE;
  return tree.tick(blackboard, dt);
}

export function resetTree(bb, tree) {
  bb._nodeState.clear();
  bb._waitRemaining = 0;
  if (tree && typeof tree.reset === 'function') tree.reset(bb);
}
