import * as THREE from 'three';

// Match the streamed city's schedule clock so the life clock, pedestrian
// schedules, and streamed sector population all agree on the same day hour.
const SIM_HOURS_PER_SECOND = 0.033;
const NEED_KEYS = Object.freeze(['energy', 'hunger', 'social', 'fun']);
const NEED_LABELS = Object.freeze({
  energy: 'ENERGY',
  hunger: 'HUNGER',
  social: 'SOCIAL',
  fun: 'FUN',
});
const MEDKIT_COST = 28;
const MEDKIT_CAPACITY = 3;
const MEDKIT_HEAL = 45;
const AMMO_BOX_COST = 32;
const AMMO_BOX_ROUNDS = 24;
const MARKET_SHIFT_DURATION = 5.5;
const MARKET_SHIFT_COOLDOWN = 8;
const MARKET_SHIFT_WAGE = 26;
const TAXI_FARE = 14;
const MUNI_FARE = 3;
const RESIDENT_FAVOR_DURATION = 45;
const RESIDENT_FAVOR_REWARD = 24;
const RESIDENT_FAVOR_SOCIAL = 14;
const RESIDENT_FAVOR_FUN = 9;
const RESIDENT_TALK_COOLDOWN = 4;
const DELIVERY_RUN_DURATION = 60;
const DELIVERY_RUN_COOLDOWN = 8;
const DELIVERY_RUN_REWARD = 32;

function clampNeed(value) {
  return THREE.MathUtils.clamp(value, 0, 100);
}

function formatClock(clock) {
  const safe = Math.max(0, Math.min(23.99, clock));
  const hours = Math.floor(safe);
  const minutes = Math.floor((safe - hours) * 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function timePhase(clock) {
  if (clock < 6) return 'NIGHT';
  if (clock < 9) return 'MORNING';
  if (clock < 15) return 'DAY';
  if (clock < 18.5) return 'GOLDEN';
  if (clock < 21) return 'DUSK';
  return 'NIGHT';
}

/**
 * A small life-sim overlay: needs, cash, a day clock, and lightweight
 * interactions that reuse the city's existing residents and portals. It
 * deliberately does not add content; it makes the player's choices matter.
 */
export function createLifeSim({
  hud,
  city,
  traffic,
  pedestrians,
  onMessage = () => {},
  getRestContext = () => null,
  getMarketInteractionContext = () => null,
} = {}) {
  const state = {
    day: 1,
    clock: 7.0,
    needs: {
      energy: 92,
      hunger: 76,
      social: 48,
      fun: 52,
    },
    cash: 140,
    legalDebt: 0,
    inventory: {
      medkits: 0,
    },
    lastActivity: null,
    lastActivityAt: 0,
    lastTransaction: null,
    workShift: {
      active: false,
      elapsed: 0,
      cooldownRemaining: 0,
      locationLabel: null,
    },
    residentFavor: null,
    residentTalkCooldownRemaining: 0,
    deliveryRun: null,
    deliveryCooldownRemaining: 0,
  };
  let lastHudAt = -Infinity;

  function getNearestPortalLabel(position) {
    const portal = city?.getNearestPortal?.(position, 16);
    return portal?.label ? String(portal.label).toLowerCase() : null;
  }

  function isAtMarket(position) {
    const label = getNearestPortalLabel(position);
    return Boolean(label && (label.includes('ferry') || label.includes('market') || label.includes('cafe')));
  }

  function marketInteractionAvailable() {
    const context = getMarketInteractionContext?.();
    return Boolean(
      context?.onFoot
      && context?.outdoor
      && context?.stationary
      && context?.recovered
      && context?.clearOfPursuit
      && !context?.activeContract
      && isAtMarket(context?.position)
      && !state.workShift.active
      && !state.residentFavor
      && !state.deliveryRun,
    );
  }

  function canEat() {
    return marketInteractionAvailable();
  }

  function canWork(position) {
    const label = getNearestPortalLabel(position);
    return Boolean(
      label
      && (label.includes('ferry') || label.includes('market') || label.includes('cafe'))
      && state.needs.energy >= 18
      && !state.workShift.active
      && state.workShift.cooldownRemaining <= 0
      && !state.residentFavor
      && !state.deliveryRun
    );
  }

  function getMood() {
    const { energy, hunger, social, fun } = state.needs;
    const average = (energy + hunger + social + fun) / 4;
    if (average >= 82) return 'thriving';
    if (average >= 62) return 'good';
    if (average >= 42) return 'neutral';
    return 'rough';
  }

  function getState() {
    const summary = needsSummary();
    return {
      day: state.day,
      clock: state.clock,
      clockLabel: formatClock(state.clock),
      phase: timePhase(state.clock),
      needs: { ...state.needs },
      needLabels: { ...NEED_LABELS },
      cash: Math.round(state.cash),
      legalDebt: Math.round(state.legalDebt),
      inventory: {
        medkit: {
          count: state.inventory.medkits,
          capacity: MEDKIT_CAPACITY,
          cost: MEDKIT_COST,
          heal: MEDKIT_HEAL,
        },
        ammunition: {
          cost: AMMO_BOX_COST,
          rounds: AMMO_BOX_ROUNDS,
        },
        taxi: {
          fare: TAXI_FARE,
        },
        muni: {
          fare: MUNI_FARE,
        },
      },
      lastTransaction: state.lastTransaction ? { ...state.lastTransaction } : null,
      workShift: {
        active: state.workShift.active,
        status: state.workShift.active
          ? 'working'
          : state.workShift.cooldownRemaining > 0 ? 'cooldown' : 'ready',
        duration: MARKET_SHIFT_DURATION,
        elapsed: state.workShift.elapsed,
        remaining: state.workShift.active
          ? Math.max(0, MARKET_SHIFT_DURATION - state.workShift.elapsed)
          : 0,
        cooldownRemaining: state.workShift.cooldownRemaining,
        wage: MARKET_SHIFT_WAGE,
        locationLabel: state.workShift.locationLabel,
      },
      residentFavor: state.residentFavor
        ? {
          active: true,
          residentId: state.residentFavor.residentId,
          residentLabel: state.residentFavor.residentLabel,
          residentRole: state.residentFavor.residentRole,
          target: { ...state.residentFavor.target },
          duration: RESIDENT_FAVOR_DURATION,
          elapsed: state.residentFavor.elapsed,
          remaining: Math.max(0, RESIDENT_FAVOR_DURATION - state.residentFavor.elapsed),
          reward: RESIDENT_FAVOR_REWARD,
        }
        : null,
      residentTalkCooldownRemaining: state.residentTalkCooldownRemaining,
      deliveryRun: state.deliveryRun
        ? {
          active: true,
          service: { ...state.deliveryRun.service },
          target: { ...state.deliveryRun.target },
          duration: DELIVERY_RUN_DURATION,
          elapsed: state.deliveryRun.elapsed,
          remaining: Math.max(0, DELIVERY_RUN_DURATION - state.deliveryRun.elapsed),
          reward: DELIVERY_RUN_REWARD,
        }
        : null,
      deliveryCooldownRemaining: state.deliveryCooldownRemaining,
      activity: state.lastActivity,
      mood: getMood(),
      lowNeeds: summary ? summary.labels.split(', ').filter(Boolean) : [],
      needHint: summary?.hint || null,
    };
  }

  function setClock(hour) {
    const safe = Number(hour);
    if (!Number.isFinite(safe)) return false;
    state.clock = THREE.MathUtils.clamp(safe, 0, 23.99);
    return true;
  }

  function exportState() {
    return {
      day: state.day,
      clock: state.clock,
      needs: { ...state.needs },
      cash: state.cash,
      legalDebt: state.legalDebt,
      inventory: { medkits: state.inventory.medkits },
      lastActivity: state.lastActivity,
      lastActivityAt: state.lastActivityAt,
      lastTransaction: state.lastTransaction ? { ...state.lastTransaction } : null,
      workShift: {
        cooldownRemaining: state.workShift.cooldownRemaining,
      },
      residentFavor: state.residentFavor
        ? {
          residentId: state.residentFavor.residentId,
          residentLabel: state.residentFavor.residentLabel,
          residentRole: state.residentFavor.residentRole,
          target: { ...state.residentFavor.target },
          elapsed: state.residentFavor.elapsed,
        }
        : null,
      residentTalkCooldownRemaining: state.residentTalkCooldownRemaining,
      deliveryRun: state.deliveryRun
        ? {
          service: { ...state.deliveryRun.service },
          target: { ...state.deliveryRun.target },
          elapsed: state.deliveryRun.elapsed,
        }
        : null,
      deliveryCooldownRemaining: state.deliveryCooldownRemaining,
    };
  }

  function importState(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    const day = Number(snapshot.day);
    const clock = Number(snapshot.clock);
    const cash = Number(snapshot.cash);
    const legalDebt = snapshot.legalDebt === undefined ? 0 : Number(snapshot.legalDebt);
    if (!Number.isFinite(day)
      || !Number.isFinite(clock)
      || !Number.isFinite(cash)
      || !Number.isFinite(legalDebt)
      || legalDebt < 0) return false;
    state.day = THREE.MathUtils.clamp(Math.round(day), 1, 9999);
    state.clock = THREE.MathUtils.clamp(clock, 0, 23.99);
    state.cash = THREE.MathUtils.clamp(cash, 0, 999999);
    state.legalDebt = THREE.MathUtils.clamp(Math.round(legalDebt), 0, 999999);
    NEED_KEYS.forEach((key) => {
      const value = Number(snapshot.needs?.[key]);
      if (Number.isFinite(value)) state.needs[key] = clampNeed(value);
    });
    state.inventory.medkits = THREE.MathUtils.clamp(
      Math.round(Number(snapshot.inventory?.medkits) || 0),
      0,
      MEDKIT_CAPACITY,
    );
    state.lastActivity = typeof snapshot.lastActivity === 'string'
      ? snapshot.lastActivity.slice(0, 80)
      : null;
    state.lastActivityAt = Number.isFinite(Number(snapshot.lastActivityAt))
      ? Math.max(0, Number(snapshot.lastActivityAt))
      : 0;
    const transaction = snapshot.lastTransaction;
    state.lastTransaction = transaction
      && typeof transaction === 'object'
      && typeof transaction.kind === 'string'
      && Number.isFinite(Number(transaction.amount))
      && Number.isFinite(Number(transaction.cashAfter))
      ? {
        kind: transaction.kind.slice(0, 48),
        label: String(transaction.label || '').slice(0, 80),
        amount: Math.round(Number(transaction.amount)),
        cashAfter: Math.round(Number(transaction.cashAfter)),
        at: Number.isFinite(Number(transaction.at)) ? Math.max(0, Number(transaction.at)) : 0,
        ...(Number.isFinite(Number(transaction.due))
          ? { due: Math.max(0, Math.round(Number(transaction.due))) }
          : {}),
        ...(Number.isFinite(Number(transaction.charged))
          ? { charged: Math.max(0, Math.round(Number(transaction.charged))) }
          : {}),
        ...(Number.isFinite(Number(transaction.unpaid))
          ? { unpaid: Math.max(0, Math.round(Number(transaction.unpaid))) }
          : {}),
        ...(Number.isFinite(Number(transaction.debtBefore))
          ? { debtBefore: Math.max(0, Math.round(Number(transaction.debtBefore))) }
          : {}),
        ...(Number.isFinite(Number(transaction.debtAfter))
          ? { debtAfter: Math.max(0, Math.round(Number(transaction.debtAfter))) }
          : {}),
      }
      : null;
    state.workShift.active = false;
    state.workShift.elapsed = 0;
    state.workShift.cooldownRemaining = THREE.MathUtils.clamp(
      Number(snapshot.workShift?.cooldownRemaining) || 0,
      0,
      300,
    );
    state.workShift.locationLabel = null;
    const favor = snapshot.residentFavor;
    const favorTarget = favor?.target;
    const favorElapsed = Number(favor?.elapsed);
    state.residentFavor = favor
      && typeof favor === 'object'
      && typeof favor.residentId === 'string'
      && typeof favorTarget?.id === 'string'
      && typeof favorTarget?.label === 'string'
      && Number.isFinite(Number(favorTarget.x))
      && Number.isFinite(Number(favorTarget.z))
      && Number.isFinite(favorElapsed)
      && favorElapsed >= 0
      && favorElapsed < RESIDENT_FAVOR_DURATION
      ? {
        residentId: favor.residentId.slice(0, 64),
        residentLabel: String(favor.residentLabel || 'Resident').slice(0, 80),
        residentRole: String(favor.residentRole || 'resident').slice(0, 48),
        target: {
          id: favorTarget.id.slice(0, 96),
          label: favorTarget.label.slice(0, 96),
          x: Number(favorTarget.x),
          z: Number(favorTarget.z),
        },
        elapsed: THREE.MathUtils.clamp(favorElapsed, 0, RESIDENT_FAVOR_DURATION),
      }
      : null;
    state.residentTalkCooldownRemaining = THREE.MathUtils.clamp(
      Number(snapshot.residentTalkCooldownRemaining) || 0,
      0,
      RESIDENT_TALK_COOLDOWN,
    );
    state.deliveryCooldownRemaining = THREE.MathUtils.clamp(
      Number(snapshot.deliveryCooldownRemaining) || 0,
      0,
      300,
    );
    const delivery = snapshot.deliveryRun;
    const deliveryService = delivery?.service;
    const deliveryTarget = delivery?.target;
    const deliveryElapsed = Number(delivery?.elapsed);
    state.deliveryRun = delivery
      && typeof delivery === 'object'
      && Number.isInteger(Number(deliveryService?.vehicleId))
      && typeof deliveryService?.identity === 'string'
      && typeof deliveryService?.label === 'string'
      && typeof deliveryTarget?.id === 'string'
      && typeof deliveryTarget?.label === 'string'
      && Number.isFinite(Number(deliveryTarget?.x))
      && Number.isFinite(Number(deliveryTarget?.z))
      && Number.isFinite(deliveryElapsed)
      && deliveryElapsed >= 0
      && deliveryElapsed < DELIVERY_RUN_DURATION
      ? {
        service: {
          vehicleId: Number(deliveryService.vehicleId),
          identity: deliveryService.identity.slice(0, 64),
          label: deliveryService.label.slice(0, 80),
        },
        target: {
          id: deliveryTarget.id.slice(0, 96),
          label: deliveryTarget.label.slice(0, 96),
          x: Number(deliveryTarget.x),
          z: Number(deliveryTarget.z),
        },
        elapsed: THREE.MathUtils.clamp(deliveryElapsed, 0, DELIVERY_RUN_DURATION),
      }
      : null;
    hud?.setLifeState?.(getState());
    return true;
  }

  function startResidentFavor(resident, target) {
    if (state.residentFavor) {
      onMessage(`FAVOR ACTIVE · deliver to ${state.residentFavor.target.label}.`);
      return false;
    }
    if (state.workShift.active) {
      onMessage('Finish the market shift before taking a resident favor.');
      return false;
    }
    if (state.deliveryRun) {
      onMessage(`Finish the Bay Parcel run at ${state.deliveryRun.target.label} first.`);
      return false;
    }
    if (typeof resident?.id !== 'string'
      || typeof target?.id !== 'string'
      || typeof target?.label !== 'string'
      || !Number.isFinite(Number(target.x))
      || !Number.isFinite(Number(target.z))) return false;
    state.residentFavor = {
      residentId: resident.id.slice(0, 64),
      residentLabel: String(resident.label || 'Resident').slice(0, 80),
      residentRole: String(resident.role || resident.job?.id || 'resident').slice(0, 48),
      target: {
        id: target.id.slice(0, 96),
        label: target.label.slice(0, 96),
        x: Number(target.x),
        z: Number(target.z),
      },
      elapsed: 0,
    };
    state.lastActivity = `favor:${state.residentFavor.residentId}:active`;
    state.lastActivityAt = performance.now();
    onMessage(
      `${state.residentFavor.residentLabel} needs a delivery at ${state.residentFavor.target.label} · $${RESIDENT_FAVOR_REWARD}.`,
    );
    hud?.setLifeState?.(getState());
    return getState().residentFavor;
  }

  function completeResidentFavor(targetId) {
    if (!state.residentFavor || String(targetId || '') !== state.residentFavor.target.id) return null;
    const completed = state.residentFavor;
    state.residentFavor = null;
    state.cash += RESIDENT_FAVOR_REWARD;
    state.needs.social = clampNeed(state.needs.social + RESIDENT_FAVOR_SOCIAL);
    state.needs.fun = clampNeed(state.needs.fun + RESIDENT_FAVOR_FUN);
    state.lastActivity = `favor:${completed.residentId}:complete`;
    state.lastActivityAt = performance.now();
    state.lastTransaction = {
      kind: 'resident-favor',
      label: `${completed.residentLabel} / ${completed.target.label}`.slice(0, 80),
      amount: RESIDENT_FAVOR_REWARD,
      cashAfter: Math.round(state.cash),
      at: state.lastActivityAt,
    };
    const message = `FAVOR COMPLETE · ${completed.residentLabel} paid $${RESIDENT_FAVOR_REWARD}.`;
    onMessage(message);
    hud?.setLifeState?.(getState());
    return {
      kind: 'favor-complete',
      message,
      reward: RESIDENT_FAVOR_REWARD,
      residentId: completed.residentId,
      targetId: completed.target.id,
      transaction: { ...state.lastTransaction },
    };
  }

  function cancelResidentFavor(message = 'FAVOR EXPIRED · the resident found another courier.') {
    if (!state.residentFavor) return null;
    const expired = state.residentFavor;
    state.residentFavor = null;
    state.lastActivity = `favor:${expired.residentId}:expired`;
    state.lastActivityAt = performance.now();
    onMessage(message);
    hud?.setLifeState?.(getState());
    return {
      kind: 'favor-timeout',
      message,
      residentId: expired.residentId,
      targetId: expired.target.id,
    };
  }

  function startDeliveryRun(service, target) {
    if (state.deliveryRun) {
      onMessage(`BAY PARCEL ACTIVE · deliver to ${state.deliveryRun.target.label}.`);
      return false;
    }
    if (state.workShift.active || state.residentFavor) {
      onMessage('Finish the active job before taking a Bay Parcel run.');
      return false;
    }
    if (state.deliveryCooldownRemaining > 0) {
      onMessage(`Bay Parcel cooldown · ${Math.ceil(state.deliveryCooldownRemaining)}s remaining.`);
      return false;
    }
    if (!Number.isInteger(Number(service?.vehicleId))
      || typeof service?.identity !== 'string'
      || typeof target?.id !== 'string'
      || typeof target?.label !== 'string'
      || !Number.isFinite(Number(target?.x))
      || !Number.isFinite(Number(target?.z))) return false;
    state.deliveryRun = {
      service: {
        vehicleId: Number(service.vehicleId),
        identity: service.identity.slice(0, 64),
        label: String(service.label || 'Bay Parcel').slice(0, 80),
      },
      target: {
        id: target.id.slice(0, 96),
        label: target.label.slice(0, 96),
        x: Number(target.x),
        z: Number(target.z),
      },
      elapsed: 0,
    };
    state.lastActivity = `delivery:${state.deliveryRun.service.vehicleId}:active`;
    state.lastActivityAt = performance.now();
    onMessage(`BAY PARCEL · deliver to ${state.deliveryRun.target.label} · $${DELIVERY_RUN_REWARD}.`);
    hud?.setLifeState?.(getState());
    return getState().deliveryRun;
  }

  function completeDeliveryRun(targetId) {
    if (!state.deliveryRun || String(targetId || '') !== state.deliveryRun.target.id) return null;
    const completed = state.deliveryRun;
    state.deliveryRun = null;
    state.deliveryCooldownRemaining = DELIVERY_RUN_COOLDOWN;
    state.cash += DELIVERY_RUN_REWARD;
    state.lastActivity = `delivery:${completed.service.vehicleId}:complete`;
    state.lastActivityAt = performance.now();
    state.lastTransaction = {
      kind: 'delivery-reward',
      label: `Bay Parcel / ${completed.target.label}`.slice(0, 80),
      amount: DELIVERY_RUN_REWARD,
      cashAfter: Math.round(state.cash),
      at: state.lastActivityAt,
    };
    const message = `BAY PARCEL COMPLETE · $${DELIVERY_RUN_REWARD} earned.`;
    onMessage(message);
    hud?.setLifeState?.(getState());
    return {
      kind: 'delivery-complete',
      message,
      reward: DELIVERY_RUN_REWARD,
      targetId: completed.target.id,
      transaction: { ...state.lastTransaction },
    };
  }

  function cancelDeliveryRun(message = 'BAY PARCEL EXPIRED · dispatch reassigned the run.') {
    if (!state.deliveryRun) return null;
    const expired = state.deliveryRun;
    state.deliveryRun = null;
    state.deliveryCooldownRemaining = DELIVERY_RUN_COOLDOWN;
    state.lastActivity = `delivery:${expired.service.vehicleId}:expired`;
    state.lastActivityAt = performance.now();
    onMessage(message);
    hud?.setLifeState?.(getState());
    return {
      kind: 'delivery-timeout',
      message,
      targetId: expired.target.id,
    };
  }

  function cancelWorkShift(message = 'Market shift cancelled · stay near the counter and keep still.') {
    if (!state.workShift.active) return false;
    state.workShift.active = false;
    state.workShift.elapsed = 0;
    state.workShift.locationLabel = null;
    state.lastActivity = 'work:market-cancelled';
    state.lastActivityAt = performance.now();
    onMessage(message);
    hud?.setLifeState?.(getState());
    return {
      kind: 'work-cancelled',
      message,
    };
  }

  function completeWorkShift() {
    if (!state.workShift.active) return null;
    state.workShift.active = false;
    state.workShift.elapsed = 0;
    state.workShift.cooldownRemaining = MARKET_SHIFT_COOLDOWN;
    state.workShift.locationLabel = null;
    state.cash += MARKET_SHIFT_WAGE;
    state.needs.energy = clampNeed(state.needs.energy - 16);
    state.needs.hunger = clampNeed(state.needs.hunger + 9);
    state.needs.fun = clampNeed(state.needs.fun - 4);
    state.lastActivity = 'work:market-complete';
    state.lastActivityAt = performance.now();
    state.lastTransaction = {
      kind: 'work-wage',
      label: 'Market work shift',
      amount: MARKET_SHIFT_WAGE,
      cashAfter: Math.round(state.cash),
      at: state.lastActivityAt,
    };
    const message = `MARKET SHIFT COMPLETE · $${MARKET_SHIFT_WAGE} earned.`;
    onMessage(message);
    hud?.setLifeState?.(getState());
    return {
      kind: 'work-complete',
      message,
      wage: MARKET_SHIFT_WAGE,
      transaction: { ...state.lastTransaction },
    };
  }

  function update(dt = 0, playerState = {}) {
    if (!Number.isFinite(dt) || dt <= 0) return null;
    state.workShift.cooldownRemaining = Math.max(
      0,
      state.workShift.cooldownRemaining - dt,
    );
    state.residentTalkCooldownRemaining = Math.max(
      0,
      state.residentTalkCooldownRemaining - dt,
    );
    state.deliveryCooldownRemaining = Math.max(0, state.deliveryCooldownRemaining - dt);
    if (state.deliveryRun) {
      state.deliveryRun.elapsed = Math.min(
        DELIVERY_RUN_DURATION,
        state.deliveryRun.elapsed + dt,
      );
      if (state.deliveryRun.elapsed >= DELIVERY_RUN_DURATION) return cancelDeliveryRun();
      const now = performance.now() / 1000;
      if (now - lastHudAt >= 0.45) {
        lastHudAt = now;
        hud?.setLifeState?.(getState());
      }
    }
    if (state.residentFavor) {
      state.residentFavor.elapsed = Math.min(
        RESIDENT_FAVOR_DURATION,
        state.residentFavor.elapsed + dt,
      );
      if (state.residentFavor.elapsed >= RESIDENT_FAVOR_DURATION) {
        return cancelResidentFavor();
      }
      const now = performance.now() / 1000;
      if (now - lastHudAt >= 0.45) {
        lastHudAt = now;
        hud?.setLifeState?.(getState());
      }
    }
    if (state.workShift.active) {
      const label = getNearestPortalLabel(playerState.position);
      const validLocation = Boolean(
        label && (label.includes('ferry') || label.includes('market') || label.includes('cafe')),
      );
      if (playerState.driving === true
        || playerState.moving === true
        || playerState.interior === true
        || playerState.downed === true
        || playerState.pursuitActive === true
        || playerState.available === false
        || !validLocation) {
        return cancelWorkShift(playerState.pursuitActive === true
          ? 'MARKET SHIFT CANCELLED · lose the StreetHeat tail before working.'
          : undefined);
      }
      state.workShift.elapsed = Math.min(
        MARKET_SHIFT_DURATION,
        state.workShift.elapsed + dt,
      );
      if (state.workShift.elapsed >= MARKET_SHIFT_DURATION) return completeWorkShift();
      const now = performance.now() / 1000;
      if (now - lastHudAt >= 0.45) {
        lastHudAt = now;
        hud?.setLifeState?.(getState());
      }
      return {
        kind: 'work-progress',
        remaining: MARKET_SHIFT_DURATION - state.workShift.elapsed,
      };
    }
    const deltaHours = dt * SIM_HOURS_PER_SECOND;
    state.clock += deltaHours;
    if (state.clock >= 24) {
      state.clock -= 24;
      state.day += 1;
      state.needs.energy = clampNeed(state.needs.energy + 62);
      state.needs.hunger = clampNeed(state.needs.hunger + 58);
      state.needs.social = clampNeed(state.needs.social + 34);
    }

    const driving = playerState?.driving === true;
    const moving = playerState?.moving === true;
    const resting = !moving && !driving;

    state.needs.energy = clampNeed(state.needs.energy - 3.1 * deltaHours);
    state.needs.hunger = clampNeed(state.needs.hunger + 2.4 * deltaHours);
    state.needs.social = clampNeed(state.needs.social - 1.5 * deltaHours);
    state.needs.fun = clampNeed(state.needs.fun - 1.7 * deltaHours);

    if (resting) {
      state.needs.energy = clampNeed(state.needs.energy + 11 * deltaHours);
    }
    if (driving) {
      state.needs.fun = clampNeed(state.needs.fun + 22 * deltaHours);
      state.needs.energy = clampNeed(state.needs.energy - 9 * deltaHours);
    }

    const now = performance.now() / 1000;
    if (now - lastHudAt >= 0.45) {
      lastHudAt = now;
      hud?.setLifeState?.(getState());
    }
    return null;
  }

  function addCash(amount) {
    state.cash = Math.max(0, state.cash + Number(amount) || 0);
  }

  function spendCash(amount) {
    if (state.cash < amount) return false;
    state.cash -= amount;
    return true;
  }

  function canAffordVehicleRepair(cost = 0) {
    const amount = Math.max(0, Math.round(Number(cost) || 0));
    return amount > 0 && state.cash >= amount;
  }

  function payVehicleRepair(cost = 0, vehicleClass = 'vehicle') {
    const amount = Math.max(0, Math.round(Number(cost) || 0));
    if (amount <= 0) return false;
    if (!spendCash(amount)) {
      onMessage(`Roadside repair costs $${amount}. You need more cash.`);
      return false;
    }
    state.lastActivity = `repair:${String(vehicleClass || 'vehicle')}`;
    state.lastActivityAt = performance.now();
    state.lastTransaction = {
      kind: 'vehicle-repair',
      label: 'Roadside repair',
      amount: -amount,
      cashAfter: Math.round(state.cash),
      at: state.lastActivityAt,
    };
    return true;
  }

  function payWantedFine(amount = 0, label = 'StreetHeat booking') {
    const due = THREE.MathUtils.clamp(Math.round(Number(amount) || 0), 20, 120);
    const charged = Math.min(due, Math.max(0, Math.floor(state.cash)));
    const unpaid = due - charged;
    state.cash = Math.max(0, state.cash - charged);
    state.legalDebt = THREE.MathUtils.clamp(state.legalDebt + unpaid, 0, 999999);
    state.lastActivity = 'wanted:booking';
    state.lastActivityAt = performance.now();
    state.lastTransaction = {
      kind: 'wanted-fine',
      label: String(label || 'StreetHeat booking').slice(0, 80),
      amount: -charged,
      cashAfter: Math.round(state.cash),
      due,
      charged,
      unpaid,
      debtAfter: Math.round(state.legalDebt),
      at: state.lastActivityAt,
    };
    return { ...state.lastTransaction };
  }

  function payTrafficCitation(amount = 18, label = 'Red-light citation') {
    const due = THREE.MathUtils.clamp(Math.round(Number(amount) || 0), 12, 60);
    const charged = Math.min(due, Math.max(0, Math.floor(state.cash)));
    const unpaid = due - charged;
    state.cash = Math.max(0, state.cash - charged);
    state.legalDebt = THREE.MathUtils.clamp(state.legalDebt + unpaid, 0, 999999);
    state.lastActivity = 'traffic:red-light';
    state.lastActivityAt = performance.now();
    state.lastTransaction = {
      kind: 'traffic-citation',
      label: String(label || 'Traffic citation').slice(0, 80),
      amount: -charged,
      cashAfter: Math.round(state.cash),
      due,
      charged,
      unpaid,
      debtAfter: Math.round(state.legalDebt),
      at: state.lastActivityAt,
    };
    return { ...state.lastTransaction };
  }

  function canAffordLegalDebt() {
    const debt = Math.max(0, Math.round(state.legalDebt));
    return debt > 0 && state.cash >= debt;
  }

  function payLegalDebt(label = 'Ferry legal debt settlement') {
    const debt = Math.max(0, Math.round(state.legalDebt));
    if (debt <= 0) {
      onMessage('No legal debt outstanding.');
      return null;
    }
    if (!canAffordLegalDebt()) {
      onMessage(`Legal debt is $${debt}. You need more cash.`);
      return false;
    }
    state.cash -= debt;
    state.legalDebt = 0;
    state.lastActivity = 'legal:debt-payment';
    state.lastActivityAt = performance.now();
    state.lastTransaction = {
      kind: 'legal-debt-payment',
      label: String(label || 'Ferry legal debt settlement').slice(0, 80),
      amount: -debt,
      cashAfter: Math.round(state.cash),
      debtBefore: debt,
      debtAfter: 0,
      at: state.lastActivityAt,
    };
    return { ...state.lastTransaction };
  }

  function canAffordImpoundFee(amount = 0) {
    const fee = Math.max(0, Math.round(Number(amount) || 0));
    return fee > 0 && state.cash >= fee;
  }

  function payImpoundFee(amount = 0, label = 'Ferry vehicle release') {
    const fee = THREE.MathUtils.clamp(Math.round(Number(amount) || 0), 20, 120);
    if (!canAffordImpoundFee(fee)) {
      onMessage(`Vehicle release costs $${fee}. You need more cash.`);
      return false;
    }
    state.cash -= fee;
    state.lastActivity = 'vehicle:impound-release';
    state.lastActivityAt = performance.now();
    state.lastTransaction = {
      kind: 'vehicle-impound',
      label: String(label || 'Ferry vehicle release').slice(0, 80),
      amount: -fee,
      cashAfter: Math.round(state.cash),
      at: state.lastActivityAt,
    };
    return { ...state.lastTransaction };
  }

  function canAffordVehicleRegistration(amount = 60) {
    const fee = Math.max(0, Math.round(Number(amount) || 0));
    return fee > 0 && state.cash >= fee;
  }

  function payVehicleRegistration(amount = 60, label = 'Ferry vehicle registration') {
    const fee = Math.max(0, Math.round(Number(amount) || 0));
    if (!canAffordVehicleRegistration(fee)) {
      onMessage(`Vehicle registration costs $${fee}. You need more cash.`);
      return false;
    }
    state.cash -= fee;
    state.lastActivity = 'vehicle:registration';
    state.lastActivityAt = performance.now();
    state.lastTransaction = {
      kind: 'vehicle-registration',
      label: String(label || 'Ferry vehicle registration').slice(0, 80),
      amount: -fee,
      cashAfter: Math.round(state.cash),
      at: state.lastActivityAt,
    };
    return { ...state.lastTransaction };
  }

  function canAffordTaxiFare(amount = TAXI_FARE) {
    const fare = Math.max(0, Math.round(Number(amount) || 0));
    return fare > 0 && state.cash >= fare;
  }

  function payTaxiFare(amount = TAXI_FARE, label = 'Taxi to Ferry Building') {
    const fare = THREE.MathUtils.clamp(Math.round(Number(amount) || 0), 1, 120);
    if (!canAffordTaxiFare(fare)) {
      onMessage(`Taxi fare is $${fare}. You need more cash.`);
      return false;
    }
    state.cash -= fare;
    state.lastActivity = 'travel:taxi';
    state.lastActivityAt = performance.now();
    state.lastTransaction = {
      kind: 'taxi-fare',
      label: String(label || 'Taxi ride').slice(0, 80),
      amount: -fare,
      cashAfter: Math.round(state.cash),
      at: state.lastActivityAt,
    };
    return { ...state.lastTransaction };
  }

  function canAffordMuniFare(amount = MUNI_FARE) {
    const fare = Math.max(0, Math.round(Number(amount) || 0));
    return fare > 0 && state.cash >= fare;
  }

  function payMuniFare(amount = MUNI_FARE, label = 'Muni one-stop ride') {
    const fare = THREE.MathUtils.clamp(Math.round(Number(amount) || 0), 1, 12);
    if (!canAffordMuniFare(fare)) {
      onMessage(`Muni fare is $${fare}. You need more cash.`);
      return false;
    }
    state.cash -= fare;
    state.lastActivity = 'travel:muni';
    state.lastActivityAt = performance.now();
    state.lastTransaction = {
      kind: 'muni-fare',
      label: String(label || 'Muni ride').slice(0, 80),
      amount: -fare,
      cashAfter: Math.round(state.cash),
      at: state.lastActivityAt,
    };
    return { ...state.lastTransaction };
  }

  function creditMissionReward(amount = 0, label = 'Waterfront Loop') {
    const reward = Math.max(0, Math.round(Number(amount) || 0));
    if (reward <= 0) return false;
    state.cash += reward;
    state.lastActivity = 'mission:complete';
    state.lastActivityAt = performance.now();
    state.lastTransaction = {
      kind: 'mission-reward',
      label: String(label || 'Mission reward'),
      amount: reward,
      cashAfter: Math.round(state.cash),
      at: state.lastActivityAt,
    };
    return true;
  }

  function buyMedkitAtMarket() {
    if (!marketInteractionAvailable()) {
      onMessage('Market counter unavailable · be on foot, still, recovered, and clear of pursuit.');
      return false;
    }
    if (state.inventory.medkits >= MEDKIT_CAPACITY) {
      onMessage(`Medkit inventory full · ${MEDKIT_CAPACITY}/${MEDKIT_CAPACITY}.`);
      return false;
    }
    if (!spendCash(MEDKIT_COST)) {
      onMessage(`A medkit costs $${MEDKIT_COST}. You need more cash.`);
      return false;
    }
    state.inventory.medkits += 1;
    state.lastActivity = 'buy:medkit';
    state.lastActivityAt = performance.now();
    state.lastTransaction = {
      kind: 'inventory-purchase',
      label: 'Market medkit',
      amount: -MEDKIT_COST,
      cashAfter: Math.round(state.cash),
      at: state.lastActivityAt,
    };
    onMessage(`Medkit purchased · ${state.inventory.medkits}/${MEDKIT_CAPACITY} carried.`);
    return true;
  }

  function consumeMedkit() {
    if (state.inventory.medkits <= 0) {
      onMessage(`No medkits carried · buy one for $${MEDKIT_COST} at a market.`);
      return null;
    }
    state.inventory.medkits -= 1;
    state.lastActivity = 'use:medkit';
    state.lastActivityAt = performance.now();
    return {
      heal: MEDKIT_HEAL,
      remaining: state.inventory.medkits,
    };
  }

  function buyAmmoAtMarket(position, currentReserve = 0, reserveCapacity = 0) {
    const label = getNearestPortalLabel(position);
    if (!label || !(label.includes('ferry') || label.includes('market') || label.includes('cafe'))) {
      onMessage('Find a market or cafe counter to buy ammunition.');
      return null;
    }
    const current = Math.max(0, Math.round(Number(currentReserve) || 0));
    const capacity = Math.max(0, Math.round(Number(reserveCapacity) || 0));
    if (capacity <= 0 || current + AMMO_BOX_ROUNDS > capacity) {
      onMessage(`Ammunition reserve full · use rounds before buying a ${AMMO_BOX_ROUNDS}-round box.`);
      return null;
    }
    if (!spendCash(AMMO_BOX_COST)) {
      onMessage(`Ammunition costs $${AMMO_BOX_COST}. You need more cash.`);
      return null;
    }
    state.lastActivity = 'buy:ammunition';
    state.lastActivityAt = performance.now();
    state.lastTransaction = {
      kind: 'ammo-purchase',
      label: 'Market ammunition',
      amount: -AMMO_BOX_COST,
      cashAfter: Math.round(state.cash),
      at: state.lastActivityAt,
    };
    return {
      rounds: AMMO_BOX_ROUNDS,
      cost: AMMO_BOX_COST,
      cashAfter: Math.round(state.cash),
    };
  }

  function talkToNearestResident(position, expectedResidentId = null) {
    if (state.workShift.active || state.residentFavor || state.deliveryRun) {
      onMessage('Finish the active job before stopping to chat.');
      return null;
    }
    if (state.residentTalkCooldownRemaining > 0) {
      onMessage(`Resident chat cooldown · ${Math.ceil(state.residentTalkCooldownRemaining)}s.`);
      return null;
    }
    const person = pedestrians?.getNearestPerson?.(position, 4.6);
    if (!person?.mesh || (expectedResidentId && person.id !== expectedResidentId)) {
      onMessage('No one is close enough to talk to.');
      return null;
    }
    const before = { ...state.needs };
    state.needs.social = clampNeed(state.needs.social + 20);
    state.needs.fun = clampNeed(state.needs.fun + 7);
    state.needs.energy = clampNeed(state.needs.energy - 2);
    const jobLabel = person.job?.label || 'resident';
    state.residentTalkCooldownRemaining = RESIDENT_TALK_COOLDOWN;
    state.lastActivity = `talk:${person.id}`;
    state.lastActivityAt = performance.now();
    const message = `You chatted with a ${jobLabel} about the fog and the ferry line.`;
    onMessage(message);
    hud?.setLifeState?.(getState());
    return {
      kind: 'resident-talk',
      residentId: person.id,
      residentLabel: person.label || jobLabel,
      message,
      deltas: {
        social: state.needs.social - before.social,
        fun: state.needs.fun - before.fun,
        energy: state.needs.energy - before.energy,
      },
    };
  }

  function eatAtMarket() {
    if (!marketInteractionAvailable()) {
      onMessage('Market counter unavailable · be on foot, still, recovered, and clear of pursuit.');
      return false;
    }
    if (!spendCash(9)) {
      onMessage('You do not have enough cash for a meal.');
      return false;
    }
    state.needs.hunger = clampNeed(state.needs.hunger - 42);
    state.needs.fun = clampNeed(state.needs.fun + 6);
    state.lastActivity = 'eat:market';
    state.lastActivityAt = performance.now();
    onMessage('You grabbed a warm bite at the market hall. Hunger is easing.');
    return true;
  }

  function canAffordMeal() {
    return state.cash >= 9;
  }

  function workShift() {
    const context = getMarketInteractionContext?.();
    const label = getNearestPortalLabel(context?.position);
    const available = context?.onFoot === true
      && context?.outdoor === true
      && context?.stationary === true
      && context?.recovered === true
      && context?.clearOfPursuit === true
      && !context?.activeContract
      && Boolean(label && (label.includes('ferry') || label.includes('market') || label.includes('cafe')));
    if (!available) {
      onMessage('Market shift unavailable · be on foot, still, recovered, and clear of pursuit.');
      return false;
    }
    if (state.needs.energy < 18) {
      onMessage('You are too tired to work. Find a public bench and press X first.');
      return false;
    }
    if (state.residentFavor) {
      onMessage(`Finish the favor at ${state.residentFavor.target.label} before starting a shift.`);
      return false;
    }
    if (state.deliveryRun) {
      onMessage(`Finish the Bay Parcel run at ${state.deliveryRun.target.label} before starting a shift.`);
      return false;
    }
    if (state.workShift.active) {
      onMessage('MARKET SHIFT already in progress · stay near the counter.');
      return false;
    }
    if (state.workShift.cooldownRemaining > 0) {
      onMessage(`Market shift cooldown · ${Math.ceil(state.workShift.cooldownRemaining)}s remaining.`);
      return false;
    }
    state.workShift.active = true;
    state.workShift.elapsed = 0;
    state.workShift.locationLabel = label;
    state.lastActivity = 'work:market-active';
    state.lastActivityAt = performance.now();
    onMessage(`MARKET SHIFT · stay near the counter for ${MARKET_SHIFT_DURATION.toFixed(1)}s.`);
    hud?.setLifeState?.(getState());
    return true;
  }

  function rest() {
    const context = getRestContext?.();
    const allowed = context?.onFoot === true
      && context?.outdoor === true
      && context?.stationary === true
      && context?.recovered === true
      && context?.clearOfPursuit === true
      && context?.atRestAnchor === true
      && !state.workShift.active
      && !state.residentFavor
      && !state.deliveryRun;
    if (!allowed) {
      onMessage('Rest is available on foot at a public bench.');
      return false;
    }
    if (state.needs.energy >= 96) {
      onMessage('You are already well rested.');
      return false;
    }
    state.needs.energy = clampNeed(state.needs.energy + 26);
    state.needs.hunger = clampNeed(state.needs.hunger + 5);
    state.needs.social = clampNeed(state.needs.social - 3);
    state.needs.fun = clampNeed(state.needs.fun - 4);
    state.clock = ((state.clock + 0.5) % 24);
    state.lastActivity = 'rest:bench';
    state.lastActivityAt = performance.now();
    onMessage('You rested on a bench and closed your eyes for a moment. Energy is recovering.');
    return true;
  }

  function noteDriving(dt = 0) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    state.needs.fun = clampNeed(state.needs.fun + 16 * dt);
    state.needs.energy = clampNeed(state.needs.energy - 6 * dt);
  }

  function needsSummary() {
    const low = NEED_KEYS.filter((key) => state.needs[key] < 30);
    if (!low.length) return null;
    const labels = low.map((key) => NEED_LABELS[key]).join(', ');
    const hint = low.includes('hunger')
      ? 'Grab a bite at the Ferry Building market hall.'
      : low.includes('social')
        ? 'Talk to residents along the avenue.'
        : low.includes('fun')
          ? 'Take a car out for a spin.'
          : 'Find a public bench and press X to recover energy.';
    return { labels, hint };
  }

  return {
    update,
    getState,
    exportState,
    importState,
    setClock,
    addCash,
    talkToNearestResident,
    startResidentFavor,
    completeResidentFavor,
    cancelResidentFavor,
    startDeliveryRun,
    completeDeliveryRun,
    cancelDeliveryRun,
    eatAtMarket,
    canEat,
    isAtMarket,
    canAffordMeal,
    canWork,
    workShift,
    cancelWorkShift,
    canAffordVehicleRepair,
    payVehicleRepair,
    payWantedFine,
    payTrafficCitation,
    canAffordLegalDebt,
    payLegalDebt,
    canAffordImpoundFee,
    payImpoundFee,
    canAffordVehicleRegistration,
    payVehicleRegistration,
    canAffordTaxiFare,
    payTaxiFare,
    canAffordMuniFare,
    payMuniFare,
    creditMissionReward,
    buyMedkitAtMarket,
    consumeMedkit,
    buyAmmoAtMarket,
    rest,
    noteDriving,
    needsSummary,
  };
}
