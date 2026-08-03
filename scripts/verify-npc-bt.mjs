import {
  Status,
  createBlackboard,
  resetTree,
  tick,
} from '../src/npc-behavior-tree.js';
import {
  CORE_ROLE_IDS,
  STREAMED_ACTIVITY_IDS,
  createStreamedTreeForActivity,
  createTreeForRole,
  treeStructureForActivity,
  treeStructureForRole,
} from '../src/npc-trees.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function tickUntil(tree, bb, seconds, step = 0.05) {
  let elapsed = 0;
  let last = Status.RUNNING;
  while (elapsed < seconds) {
    last = tick(tree, bb, step);
    elapsed += step;
  }
  return last;
}

function mockBlackboard(overrides = {}) {
  return createBlackboard({
    roleId: 'commuter',
    atCrossing: false,
    signalClear: false,
    atDestination: false,
    preferWork: false,
    handoffReady: false,
    ...overrides,
  });
}

console.log('verify-npc-bt: core role factories');
for (const roleId of CORE_ROLE_IDS) {
  const tree = createTreeForRole(roleId);
  assert(tree && typeof tree.tick === 'function', `Missing tree for ${roleId}`);
  const bb = mockBlackboard({ roleId });
  const status = tick(tree, bb, 0.016);
  assert(status === Status.RUNNING || status === Status.SUCCESS, `${roleId} initial tick failed`);
  assert(bb.intent === 'walk', `${roleId} should default to walk intent, got ${bb.intent}`);
  assert(typeof bb.urgency === 'number', `${roleId} urgency not set`);
}

console.log('verify-npc-bt: crossing branch');
{
  const tree = createTreeForRole('commuter');
  const waiting = mockBlackboard({ atCrossing: true, signalClear: false });
  tick(tree, waiting, 0.016);
  assert(waiting.intent === 'cross', 'Commuter should enter cross-wait at curb');
  assert(waiting.animCue === 'curb-wait', 'Commuter curb wait cue missing');

  const crossing = mockBlackboard({ atCrossing: true, signalClear: true });
  tick(tree, crossing, 0.016);
  assert(crossing.intent === 'cross', 'Commuter should cross when signal clear');
  assert(crossing.animCue === 'office-cross', 'Commuter cross anim cue missing');
}

console.log('verify-npc-bt: arrive / work branches');
{
  const tree = createTreeForRole('courier');
  const bb = mockBlackboard({ atDestination: true, handoffReady: true });
  tick(tree, bb, 0.016);
  assert(bb.intent === 'work', 'Courier handoff should set work intent');
  assert(bb.animCue === 'handoff-gesture', 'Courier handoff cue missing');

  const barista = mockBlackboard({ atDestination: true, preferWork: true });
  tick(createTreeForRole('barista'), barista, 0.016);
  assert(barista.intent === 'work' && barista.animCue === 'pour-serve', 'Barista station work failed');

  const tourist = mockBlackboard({ atDestination: true, preferWork: true });
  tick(createTreeForRole('tourist'), tourist, 0.016);
  assert(tourist.animCue === 'photo-gesture', 'Tourist photo gesture failed');

  const phone = mockBlackboard({ atDestination: true, preferWork: true });
  tick(createTreeForRole('phone'), phone, 0.016);
  assert(phone.intent === 'idle' && phone.animCue === 'phone-idle', 'Phone idle failed');
}

console.log('verify-npc-bt: wait nodes complete');
{
  const tree = createTreeForRole('worker');
  const bb = mockBlackboard({ atDestination: true, preferWork: true });
  tick(tree, bb, 0.016);
  assert(bb.intent === 'work', 'Worker tool work not started');
  const status = tickUntil(tree, bb, 6.0);
  assert(status === Status.SUCCESS || status === Status.RUNNING, 'Worker wait should finish or loop');
}

console.log('verify-npc-bt: streamed activities');
for (const activity of STREAMED_ACTIVITY_IDS) {
  const tree = createStreamedTreeForActivity(activity);
  const bb = mockBlackboard({ activity });
  tick(tree, bb, 0.016);
  assert(bb.intent != null, `Streamed ${activity} produced no intent`);
}

{
  const resting = mockBlackboard({ activity: 'resting', atDestination: true });
  tick(createStreamedTreeForActivity('resting'), resting, 0.016);
  assert(resting.intent === 'idle', 'Resting should idle');
  assert(resting.animCue === 'rest-idle', 'Resting cue missing');
}

{
  const unknown = createStreamedTreeForActivity('unknown-activity');
  const bb = mockBlackboard();
  tick(unknown, bb, 0.016);
  assert(bb.intent === 'walk', 'Unknown activity should fall back to walk');
}

console.log('verify-npc-bt: blackboard reset');
{
  const tree = createTreeForRole('cleaner');
  const bb = mockBlackboard({ atDestination: true, preferWork: true });
  tick(tree, bb, 0.016);
  resetTree(bb, tree);
  assert(bb._nodeState.size === 0, 'resetTree should clear node state');
}

console.log('verify-npc-bt: tree structures (sample)');
console.log(treeStructureForRole('commuter'));
console.log('---');
console.log(treeStructureForActivity('commuting'));

console.log('verify-npc-bt: PASS');
