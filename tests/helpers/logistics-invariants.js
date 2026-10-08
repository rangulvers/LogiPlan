// Test helper for the logistics layer: a small world harness and the invariants every state of a Logistics must satisfy.
//
//   const w = createWorld(layoutFromAscii([...], opts), { dt: 0.25, check: true });   // graph + StubTraffic + Logistics
//   w.run(600);                                     // 600 s, one logistics.step + traffic.step per tick
//   w.lg.completed; w.events.filter((e) => e.name === 'loadCompleted')
//
// With `check: true` the harness runs assertInvariants after every tick. The invariants (checkInvariants returns the
// list of violations, empty when all hold):
//   Conservation   created(sources) + created(process outputs) === liveLoads + completed + consumed(inputs of finished cycles)
//                  and liveLoads === loads physically present (yards, queues, storage, held outputs, vehicles) + inputs of
//                  running cycles; no load object exists twice.
//   Capacities     outQ per flow <= outCap (source / workstation); inQ per flow + inbound <= inCap; storage held + inbound <=
//                  capacity; inbound reservations >= 0 and equal to the quantities of the active orders heading there.
//   Claims         the claimed loads of a queue are exactly its first `claimed` entries; every claimed load belongs to exactly
//                  one active order and every load of an active order is claimed; a picked-up order's loads ride with its vehicle.
//   Vehicles       load only while toDrop/unloading (or broken/dead in those states) and then exactly the order's loads;
//                  an order belongs to exactly one vehicle; a dead vehicle holds no order; battery in 0..1; on the road exactly when
//                  not parked/charging; a leg to a waiting cell (spot) exists only in state toPark, without a station as target;
//                  loaded + empty + depot driving add up to the odometer (within one tick of driving).
//   Depots         parked + charging + reserved slots <= slots; charging + reserved chargers <= chargers; reservations equal
//                  the vehicles driving there; list membership matches vehicle state.
//   Machines       blocked <=> holding outputs; idle holds nothing; busy has a positive cycle time.

import { buildGraph } from '../../js/sim/graph.js';
import { createRng } from '../../js/util/rng.js';
import { Logistics } from '../../js/sim/logistics.js';
import { StubTraffic } from './stub-traffic.js';

/**
 * Build graph, StubTraffic and Logistics for a layout and drive them tick by tick.
 * @param {object} layout complete layout
 * @param {{ seed?: number, dt?: number, check?: boolean, runtime?: object }} [opts]
 */
export function createWorld(layout, { seed = layout.settings.seed, dt = 0.1, check = false, runtime = null } = {}) {
  const graph = buildGraph(layout);
  const traffic = new StubTraffic(graph);
  const events = [];
  const world = {
    layout, graph, traffic, dt, tick: 0, events, lg: null,
    /** Time at the start of the next tick. */
    get t() { return this.tick * dt; },
    step(n = 1) {
      for (let i = 0; i < n; i++) {
        world.lg.step(dt, world.tick * dt);
        traffic.step(dt);
        world.tick++;
        if (check) assertInvariants(world.lg, `tick ${world.tick}`);
      }
    },
    run(seconds) { world.step(Math.round(seconds / dt)); },
    /** Step until `pred(world)` is true; false if `maxSeconds` pass first. */
    runUntil(pred, maxSeconds) {
      const end = world.tick + Math.round(maxSeconds / dt);
      while (world.tick < end) {
        if (pred(world)) return true;
        world.step();
      }
      return pred(world);
    },
    named(name) { return events.filter((e) => e.name === name).map((e) => e.payload); },
  };
  world.lg = new Logistics({ layout, graph, traffic, rng: createRng(seed), emit: (name, payload) => events.push({ name, payload, tick: world.tick }) });
  if (runtime) world.lg.setRuntime(runtime);
  return world;
}

/**
 * Put `count` loads straight into a queue of a flow, bypassing transport: the origin's output queue (`side` 'out') or the
 * destination workstation's input queue ('in'). The loads are counted as created (origin = the flow's origin station), so
 * the ledger stays consistent.
 * @returns {object[]} the new loads
 */
export function injectLoads(lg, flowId, count, { side = 'out', createdAt = lg.now, readyAt = createdAt } = {}) {
  const flow = lg.flowById.get(flowId);
  const queue = side === 'out' ? flow.outLink.queue : flow.inLink.queue;
  const made = [];
  for (let i = 0; i < count; i++) {
    const load = lg.createLoad(flow.from, createdAt, readyAt, 'source');
    queue.push(load);
    made.push(load);
  }
  lg.markDirty();
  return made;
}

/** Simulate a pickup that makes `count` unclaimed loads vanish from a flow's output queue (they count as completed). */
export function drainOut(lg, flowId, count) {
  const flow = lg.flowById.get(flowId);
  const queue = flow.outLink.queue;
  for (let i = 0; i < count; i++) lg.completeLoad(queue.splice(flow.outLink.claimed, 1)[0], flow.from, lg.now);
  lg.markDirty();
}

/** A compact, comparable digest of an event log (names, times and ids only). */
export function eventDigest(events) {
  const part = (p) => [p.t, p.stationId, p.vehicleId, p.order && p.order.id, p.load && p.load.id, p.leadTime, p.machine]
    .map((v) => (v === undefined ? '' : typeof v === 'number' ? v.toFixed(6) : v)).join(',');
  let h = 2166136261;
  const text = events.map((e) => `${e.name}:${part(e.payload)}`).join('|');
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return `${events.length}:${(h >>> 0).toString(16)}`;
}

/** All loads that physically exist, with where they are. */
export function physicalLoads(lg) {
  const found = [];
  const add = (where, list) => { for (const load of list) found.push({ load, where }); };
  for (const st of lg.stations) {
    if (st.yardQ) add(`${st.id}.yard`, st.yardQ);
    if (st.pool) add(`${st.id}.pool`, st.pool);
    for (const link of st.outLinks) add(`${st.id}.out.${link.flow.id}`, link.queue);
    for (const link of st.inLinks) add(`${st.id}.in.${link.flow.id}`, link.queue);
    for (const m of st.machines || []) add(`${st.id}.holding`, m.holding);
  }
  for (const vr of lg.vehicles) add(`${vr.id}.load`, vr.load);
  return found;
}

const ON_ROAD_FREE = new Set(['idle', 'toPickup', 'loading', 'toDrop', 'unloading', 'toCharger', 'toPark', 'broken', 'dead']);

/** Every violated invariant, as human-readable strings (empty = all hold). */
export function checkInvariants(lg) {
  const bad = [];
  const fail = (msg) => bad.push(msg);
  checkConservation(lg, fail);
  checkStations(lg, fail);
  checkOrders(lg, fail);
  checkVehicles(lg, fail);
  checkDepots(lg, fail);
  return bad;
}

export function assertInvariants(lg, label = '') {
  const bad = checkInvariants(lg);
  if (bad.length > 0) throw new Error(`logistics invariants violated${label ? ` (${label})` : ''}:\n  ${bad.slice(0, 8).join('\n  ')}`);
}

function checkConservation(lg, fail) {
  const found = physicalLoads(lg);
  const ids = new Set();
  for (const { load, where } of found) {
    if (ids.has(load.id)) fail(`load ${load.id} exists twice (second time in ${where})`);
    ids.add(load.id);
  }
  let inProcess = 0;
  for (const st of lg.stations) for (const m of st.machines || []) inProcess += m.inputs;
  if (lg.liveLoads !== found.length + inProcess) fail(`liveLoads ${lg.liveLoads} != physical ${found.length} + in process ${inProcess}`);
  const created = lg.createdBySources + lg.createdByProcesses;
  if (created !== lg.liveLoads + lg.completed + lg.loadsConsumed) {
    fail(`created ${created} != live ${lg.liveLoads} + completed ${lg.completed} + consumed ${lg.loadsConsumed}`);
  }
  if (lg.liveLoads < 0 || lg.completed < 0) fail('negative load counters');
}

function checkStations(lg, fail) {
  const reserved = new Map(); // flow id -> sum of quantities of active orders
  for (const o of lg.activeOrders.values()) reserved.set(o.flowId, (reserved.get(o.flowId) || 0) + o.qty);
  for (const st of lg.stations) {
    for (const link of st.outLinks) {
      const q = link.queue;
      if (st.type !== 'storage' && q.length > link.cap) fail(`${st.id} outQ ${link.flow.id} holds ${q.length} > outCap ${link.cap}`);
      const claimed = q.filter((l) => l.claimed).length;
      if (claimed !== link.claimed) fail(`${st.id} outQ ${link.flow.id}: claimed counter ${link.claimed} != ${claimed} claimed loads`);
      for (let i = 0; i < q.length; i++) if (q[i].claimed !== i < link.claimed) fail(`${st.id} outQ ${link.flow.id}: claimed loads are not a prefix`);
    }
    for (const link of st.inLinks) {
      const inb = st.inbound.get(link.flow.id);
      if (link.queue.length + inb > st.params.inCap) fail(`${st.id} inQ ${link.flow.id}: ${link.queue.length} + inbound ${inb} > inCap ${st.params.inCap}`);
    }
    if (st.type === 'storage' && st.outCount + st.inboundTotal > st.params.capacity) fail(`${st.id} storage holds ${st.outCount} + inbound ${st.inboundTotal} > capacity ${st.params.capacity}`);
    let total = 0;
    for (const [flowId, n] of st.inbound) {
      total += n;
      if (n < 0) fail(`${st.id} inbound ${flowId} is negative (${n})`);
      if (n !== (reserved.get(flowId) || 0)) fail(`${st.id} inbound ${flowId} = ${n} but active orders reserve ${reserved.get(flowId) || 0}`);
    }
    if (total !== st.inboundTotal) fail(`${st.id} inboundTotal ${st.inboundTotal} != sum ${total}`);
    for (const m of st.machines || []) checkMachine(st, m, fail);
  }
}

function checkMachine(st, m, fail) {
  const tag = `${st.id} machine`;
  if (m.state === 'blocked' && m.holding.length === 0) fail(`${tag} is blocked but holds nothing`);
  if (m.state === 'idle' && (m.holding.length > 0 || m.inputs !== 0)) fail(`${tag} is idle but holds loads or inputs`);
  if (m.state === 'busy' && !(m.cycleTime > 0)) fail(`${tag} is busy without a cycle time`);
  if (m.state === 'down' && !['idle', 'busy', 'blocked'].includes(m.downFrom)) fail(`${tag} is down from ${m.downFrom}`);
  if (m.progress < -1e-9 || m.progress > 1 + 1e-9 || Number.isNaN(m.progress)) fail(`${tag} progress ${m.progress}`);
}

function checkOrders(lg, fail) {
  const owner = new Map();
  for (const vr of lg.vehicles) if (vr.order) {
    if (owner.has(vr.order.id)) fail(`order ${vr.order.id} is held by two vehicles`);
    owner.set(vr.order.id, vr);
    if (!lg.activeOrders.has(vr.order.id)) fail(`${vr.id} holds closed order ${vr.order.id}`);
  }
  const claimedElsewhere = new Set();
  for (const o of lg.activeOrders.values()) {
    const vr = owner.get(o.id);
    if (!vr) { fail(`active order ${o.id} has no vehicle`); continue; }
    if (vr.id !== o.vehicleId) fail(`order ${o.id} names ${o.vehicleId} but ${vr.id} holds it`);
    if (o.qty !== o.loads.length || o.qty < 1) fail(`order ${o.id} qty ${o.qty} != ${o.loads.length} loads`);
    const link = o.flow.outLink;
    for (const load of o.loads) {
      if (claimedElsewhere.has(load)) fail(`load ${load.id} is promised to two orders`);
      claimedElsewhere.add(load);
      if (!load.claimed) fail(`load ${load.id} of order ${o.id} is not marked claimed`);
      const inQueue = link.queue.includes(load);
      const onVehicle = vr.load.includes(load);
      if (o.pickedAt === null && !inQueue) fail(`load ${load.id} of unpicked order ${o.id} is not at the origin`);
      if (o.pickedAt !== null && (inQueue || !onVehicle)) fail(`load ${load.id} of picked order ${o.id} is not (only) on ${vr.id}`);
    }
  }
  for (const { load, where } of physicalLoads(lg)) {
    if (load.claimed && !claimedElsewhere.has(load)) fail(`claimed load ${load.id} in ${where} belongs to no active order`);
  }
}

function checkVehicles(lg, fail) {
  const seen = new Set();
  for (const vr of lg.vehicles) {
    if (seen.has(vr.id)) fail(`duplicate vehicle ${vr.id}`);
    seen.add(vr.id);
    const carrying = vr.load.length > 0;
    const carryState = vr.state === 'toDrop' || vr.state === 'unloading'
      || ((vr.state === 'broken' || vr.state === 'dead') && (vr.resumeState === 'toDrop' || vr.resumeState === 'unloading'));
    if (carrying && !carryState) fail(`${vr.id} carries ${vr.load.length} loads in state ${vr.state}`);
    if (!carrying && vr.order && vr.order.pickedAt !== null) fail(`${vr.id} picked up order ${vr.order.id} but carries nothing`);
    if (vr.battery < 0 || vr.battery > 1 || Number.isNaN(vr.battery)) fail(`${vr.id} battery ${vr.battery}`);
    const inDepot = vr.state === 'parked' || vr.state === 'charging';
    if (inDepot === vr.tv.onRoad) fail(`${vr.id} state ${vr.state} but onRoad=${vr.tv.onRoad}`);
    if (vr.visible !== vr.tv.onRoad) fail(`${vr.id} visible=${vr.visible} but onRoad=${vr.tv.onRoad}`);
    if (!inDepot && !ON_ROAD_FREE.has(vr.state)) fail(`${vr.id} has unknown state ${vr.state}`);
    if (!Number.isFinite(vr.x) || !Number.isFinite(vr.y)) fail(`${vr.id} pose is not finite`);
    if (vr.state === 'dead' && !vr.tv.disabled) fail(`${vr.id} is dead but not disabled`);
    if (vr.state === 'dead' && vr.order) fail(`${vr.id} is dead but still holds order ${vr.order.id}`);
    if (vr.spot >= 0 && (vr.state !== 'toPark' && !(vr.state === 'broken' && vr.resumeState === 'toPark'))) fail(`${vr.id} has a waiting cell but is ${vr.state}`);
    if (vr.spot >= 0 && vr.targetId !== null) fail(`${vr.id} drives to a waiting cell and to ${vr.targetId}`);
    const unbooked = vr.tv.odometer - (vr.loadedDistance + vr.emptyDistance + vr.parkDistance);
    const lastTick = vr.cfg.body.speed * Math.max(1, lg.runtime.speedFactor) * (lg.now - lg.time);
    if (unbooked < -1e-6 || unbooked > lastTick + 1e-6) fail(`${vr.id}: odometer ${vr.tv.odometer} but only ${vr.loadedDistance + vr.emptyDistance + vr.parkDistance} m booked`);
    if (vr.state === 'broken' && !vr.tv.disabled) fail(`${vr.id} is broken but not disabled`);
  }
}

function checkDepots(lg, fail) {
  const driving = new Map(); // depot id -> { slots, chargers } promised to vehicles on their way
  for (const vr of lg.vehicles) {
    const trip = vr.state === 'broken' ? vr.resumeState : vr.state;
    if ((trip !== 'toPark' && trip !== 'toCharger') || vr.targetId === null) continue; // no station: a leg to a waiting cell
    const d = driving.get(vr.targetId) || { slots: 0, chargers: 0 };
    d.slots++;
    if (trip === 'toCharger') d.chargers++;
    driving.set(vr.targetId, d);
  }
  for (const d of lg.depots) {
    const want = driving.get(d.id) || { slots: 0, chargers: 0 };
    if (d.reservedSlots !== want.slots || d.reservedChargers !== want.chargers) {
      fail(`${d.id} reserves ${d.reservedSlots}/${d.reservedChargers} slots/chargers but ${want.slots}/${want.chargers} vehicles are on their way`);
    }
    if (d.parked.length + d.charging.length + d.reservedSlots > d.slots) fail(`${d.id} over-booked: ${d.parked.length} parked + ${d.charging.length} charging + ${d.reservedSlots} reserved > ${d.slots} slots`);
    if (d.charging.length + d.reservedChargers > d.chargers) fail(`${d.id} chargers over-booked: ${d.charging.length} + ${d.reservedChargers} > ${d.chargers}`);
    for (const vr of d.parked) if (vr.state !== 'parked' || vr.depot !== d) fail(`${vr.id} listed as parked in ${d.id} but is ${vr.state}`);
    for (const vr of d.charging) if (vr.state !== 'charging' || vr.depot !== d) fail(`${vr.id} listed as charging in ${d.id} but is ${vr.state}`);
  }
  for (const vr of lg.vehicles) {
    if (vr.state !== 'parked' && vr.state !== 'charging') continue;
    const list = vr.state === 'parked' ? vr.depot && vr.depot.parked : vr.depot && vr.depot.charging;
    if (!list || !list.includes(vr)) fail(`${vr.id} is ${vr.state} but not listed in its depot`);
  }
}
