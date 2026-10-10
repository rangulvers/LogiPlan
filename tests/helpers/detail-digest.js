// Test helper: a digest of everything a detail collector (js/sim/detail.js) has recorded, to prove that two runs recorded the same bit for bit (slices, repeats,
// queries in between). It reads the internal columns, so it is a test of the recorder, not part of the query API.
import { createHash } from 'node:crypto';

const COLUMNS = (d) => {
  const L = d.legs;
  return [L.veh, L.kind, L.from, L.to, L.flow, L.path, L.t0, L.dur, L.wait, L.dockWait, L.qty, L.flags, d.split, d.hot.keys, d.hot.secs, d.hot.other, d.hotStray.keys, d.hotStray.secs, d.hotQ.keys, d.hotQ.secs,
    d.idleHot.keys, d.idleHot.secs, d.vRing, d.sRing, d.ringT, d.ringN, d.sInt, d.sEv, d.starvedBy, d.depotSecs, d.legsLoaded, d.batMin, d.bktMin, d.curNode, d.curSecs, d.curIdle, d.curIdleSecs, d.base, d.qty, d.credit,
    d.open, d.oKind, d.oFrom, d.oTo, d.oFlow, d.oPath, d.oT0, d.oWait, d.oDockWait, d.oFlags, d.oPaused, d.pauseAt, d.charges.veh, d.charges.t0, d.charges.dur, d.charges.b0, d.charges.b1];
};

/** Hex digest (16 characters) of the recorded state of `d`. Typed arrays are hashed by their live part; the summaries of the histograms by value. */
export function detailDigest(d) {
  const h = createHash('sha1');
  for (const col of COLUMNS(d)) h.update(Buffer.from(col.buffer, col.byteOffset, col.byteLength));
  h.update(JSON.stringify([d.legs.count, d.bCount, d.pool.size, d.pool.overflow, d.whatIf, d.notices, d.windowStart, d.charges.count, d.sSecs, d.balanceFiled]));
  for (let i = 0; i < d.pool.size; i++) h.update(d.pool.dirs[i]);
  const hist = (m) => [...m].sort((a, b) => a[0] - b[0]).map(([k, v]) => [k, v.n ?? v.count, v.sum, v.max]);
  h.update(JSON.stringify([hist(d.pickWait), hist(d.yardWait), hist(d.sinkLead)]));
  return h.digest('hex').slice(0, 16);
}

/** Call every query of the collector for everything it has (the digest must not move). */
export function callEveryQuery(d) {
  for (let i = 0; i < d.nV; i++) {
    for (const w of [d.windowOf('start'), d.windowOf('last30')]) {
      d.timeSplit(i, w); d.counts(i, w); d.routesOf(i, w, [0, 1, 2, 3]); d.roundOf(i, w); d.queuesOf(i, w); d.batteryOf(i, w);
    }
    d.hotspots(i, 8); d.idleSpots(i, 3); d.workingSeries(i); d.metresToGo(i);
  }
  for (let k = 0; k < d.nS; k++) { d.stationWindow(k, d.windowOf('last30')); d.stationWindow(k, d.windowOf('start')); d.queueNow(k); d.visitsTo(k, d.windowOf('start')); }
  d.busiestRoutes(d.windowOf('start')); d.busiestRoutes(d.windowOf('last30')); d.cellUse([5, 6, 7]); d.loadedRoutes({}); d.legCoverage();
  for (const m of [d.pickWait, d.yardWait]) for (const hist of m.values()) hist.percentile(0.9);
  for (const set of d.sinkLead.values()) set.percentile(0.9);
}
