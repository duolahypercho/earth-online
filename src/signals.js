// Compact urban timing: long enough to discharge a short queue, with a
// credible yellow and all-red clearance interval at SF street scale.
export const SIGNAL_GREEN = 9.6;
export const SIGNAL_YELLOW = 2.7;
export const SIGNAL_ALL_RED = 0.9;
export const SIGNAL_HALF = SIGNAL_GREEN + SIGNAL_YELLOW + SIGNAL_ALL_RED;
export const SIGNAL_PERIOD = SIGNAL_HALF * 2;

export function signalOffsetForPosition(x, z) {
  // Coordinate nearby lights into a loose progression instead of assigning
  // visually random phases. The non-equal axes avoid synchronizing the whole
  // grid while still producing strings of greens along a corridor.
  const raw = x * 0.041 + z * 0.027;
  return ((raw % SIGNAL_PERIOD) + SIGNAL_PERIOD) % SIGNAL_PERIOD;
}

export function signalPhaseAt(group, time, offset = 0) {
  const cycle = ((time + offset) % SIGNAL_PERIOD + SIGNAL_PERIOD) % SIGNAL_PERIOD;
  const activeGroup = cycle < SIGNAL_HALF ? 0 : 1;
  const local = activeGroup === 0 ? cycle : cycle - SIGNAL_HALF;
  if (group !== activeGroup) return 'red';
  if (local < SIGNAL_GREEN) return 'green';
  if (local < SIGNAL_GREEN + SIGNAL_YELLOW) return 'yellow';
  return 'red';
}

// Seconds until the queried group's phase next changes. Pedestrian logic uses
// this to decide whether the remaining walk interval can fit a crossing.
signalPhaseAt.remaining = (group, time, offset = 0) => {
  const cycle = ((time + offset) % SIGNAL_PERIOD + SIGNAL_PERIOD) % SIGNAL_PERIOD;
  const activeGroup = cycle < SIGNAL_HALF ? 0 : 1;
  const local = activeGroup === 0 ? cycle : cycle - SIGNAL_HALF;
  if (group !== activeGroup) return SIGNAL_HALF - local;
  if (local < SIGNAL_GREEN) return SIGNAL_GREEN - local;
  if (local < SIGNAL_GREEN + SIGNAL_YELLOW) return SIGNAL_GREEN + SIGNAL_YELLOW - local;
  return SIGNAL_HALF - local;
};
