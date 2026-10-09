// The KPI section of the warehouse module: `report.ops` (docs/WAREHOUSE-DESIGN.md 6.8), created through the extension seam of Stats
// (docs/ARCHITECTURE.md 3.1): `Logistics.ext.stats(stats)` returns { reset, sample(dt), onEvent(name, payload), report(report) }, which Stats calls at
// its five hook sites. The object exists only for a layout that uses a feature, so a legacy report has no `ops` key and no byte changes.
//
// STATE (milestone M1): `report.ops.trucks[stationId]`, one entry per Goods in / Goods out that has trucks:
//
//   { name, role: 'in' | 'out', doors,
//     trucks: { arrived, docked, departed, short, noShow, turnedAway },       // counts in the window (events); `short`: Goods out trucks that left without a full load
//     gateWait:   { mean, p90, max },                                         // s from the arrival to taking a door, per truck that docked in the window (null fields: none did)
//     doorTime:   { mean, p90 },                                              // s from taking a door to the door being free again (check-in and check-out included), per truck that departed
//     turnaround: { mean, p90 },                                              // s from the arrival to the door being free again
//     doorUtilization,                                                        // 0..1: door-seconds held / (doors x window)
//     gateQueue:  { mean, max, now },                                         // trucks waiting at the gate: time-weighted mean, largest, right now
//     doorsBusyNow,                                                           // trucks at a door right now
//     fillRate,                                                               // Goods out: pallets loaded / pallets planned over the trucks that departed; null on a Goods in or before any truck left
//     gateQueueSeries: [] }                                                   // the mean gate queue per interval of report.series (same interval and the same length)
//
// Numbers are finite or null, never NaN. Counters come from the events of logistics/trucks.js (truckArrived, truckDocked, truckDeparted,
// truckNoShow, truckTurnedAway); the integrals (door-seconds, gate queue) are sampled once per tick from the truck desks. Nothing here allocates
// per tick: typed arrays are made once when Stats builds, the sample sets and series grow only when a truck docks or an interval closes.

import { SERIES_INTERVAL, SERIES_MAX_POINTS, SampleSet } from './stats.js';

const EPS = 1e-9;
/** Finite, non-negative number or 0 (NaN, Infinity, negatives and missing values all become 0). */
const nn = (x) => (x > 0 && x < Infinity ? x : 0);
const meanOf = (sum, n) => (n > 0 ? sum / n : null);

/**
 * @param {object} stats the Stats this extension belongs to
 * @param {object} lg the Logistics (its stations with `trucks`)
 * @returns {{ reset: () => void, sample: (dt: number) => void, onEvent: (name: string, payload: object) => void, report: (report: object) => void }}
 */
export function createOpsStats(stats, lg) {
  const stations = lg.stations.filter((st) => st.trucks !== null);
  const n = stations.length;
  const index = new Map(stations.map((st, i) => [st.id, i]));
  const f64 = (k) => new Float64Array(k);
  // window counters, one slot per truck station
  const arrived = f64(n); const docked = f64(n); const departed = f64(n); const short = f64(n); const noShow = f64(n); const turnedAway = f64(n);
  const planned = f64(n); const loaded = f64(n);
  const gateInt = f64(n); const doorInt = f64(n); const gateMax = f64(n);
  const serInt = f64(n); // gate-queue integral of the series interval that is open
  const counters = [arrived, docked, departed, short, noShow, turnedAway, planned, loaded, gateInt, doorInt, gateMax, serInt];
  const gateWait = stations.map(() => new SampleSet());
  const doorTime = stations.map(() => new SampleSet());
  const turnaround = stations.map(() => new SampleSet());
  let duration = 0;
  let serK = 0;
  let serSince = 0;
  let stride = 1;
  let series = stations.map(() => []);

  function reset() {
    for (const a of counters) a.fill(0);
    for (let i = 0; i < n; i++) {
      gateWait[i].clear();
      doorTime[i].clear();
      turnaround[i].clear();
    }
    duration = 0;
    serK = 0;
    serSince = 0;
    stride = 1;
    series = stations.map(() => []);
  }

  /** A series boundary was reached: every `stride` boundaries one point per station (the mean gate queue since the last point), as Stats does for report.series. */
  function closeInterval(k) {
    const previous = serK;
    serK = k;
    if (Math.floor(k / stride) <= Math.floor(previous / stride)) return;
    const span = duration - serSince;
    for (let i = 0; i < n; i++) {
      series[i].push(span > 0 ? serInt[i] / span : 0);
      serInt[i] = 0;
    }
    serSince = duration;
    if (n > 0 && series[0].length >= SERIES_MAX_POINTS) {
      for (const s of series) {
        for (let i = 0; i < s.length >> 1; i++) s[i] = (s[2 * i] + s[2 * i + 1]) / 2;
        s.length >>= 1;
      }
      stride *= 2;
    }
  }

  function sample(dt) {
    duration += dt;
    for (let i = 0; i < n; i++) {
      const desk = stations[i].trucks;
      const queue = desk.gate.length;
      gateInt[i] += queue * dt;
      serInt[i] += queue * dt;
      doorInt[i] += desk.docked.length * dt;
      if (queue > gateMax[i]) gateMax[i] = queue;
    }
    const k = Math.floor((duration + EPS) / SERIES_INTERVAL);
    if (k > serK) closeInterval(k);
  }

  function onEvent(name, payload) {
    if (typeof name !== 'string' || !name.startsWith('truck') || !payload) return;
    const i = index.get(payload.stationId);
    if (i === undefined) return;
    switch (name) {
      case 'truckArrived': arrived[i]++; break;
      case 'truckTurnedAway': turnedAway[i]++; break;
      case 'truckNoShow': noShow[i]++; break;
      case 'truckDocked':
        docked[i]++;
        gateWait[i].add(nn(payload.wait));
        break;
      case 'truckDeparted':
        departed[i]++;
        doorTime[i].add(nn(payload.doorTime));
        turnaround[i].add(nn(payload.turnaround));
        if (stations[i].trucks.role === 'out') {
          planned[i] += nn(payload.truck && payload.truck.plan);
          loaded[i] += nn(payload.truck && payload.truck.loaded);
          if (payload.short) short[i]++;
        }
        break;
      default: break;
    }
  }

  function report(out) {
    const trucks = {};
    for (let i = 0; i < n; i++) {
      const st = stations[i];
      const desk = st.trucks;
      const wait = gateWait[i];
      const door = doorTime[i];
      const turn = turnaround[i];
      const queueNow = desk.gate.length;
      trucks[st.id] = {
        name: (st.def && st.def.name) || st.id,
        role: desk.role,
        doors: desk.doors,
        trucks: {
          arrived: arrived[i], docked: docked[i], departed: departed[i], short: short[i], noShow: noShow[i], turnedAway: turnedAway[i],
        },
        gateWait: { mean: meanOf(wait.sum, wait.count), p90: wait.percentile(0.9), max: wait.count > 0 ? wait.max : null },
        doorTime: { mean: meanOf(door.sum, door.count), p90: door.percentile(0.9) },
        turnaround: { mean: meanOf(turn.sum, turn.count), p90: turn.percentile(0.9) },
        doorUtilization: duration > 0 && desk.doors > 0 ? Math.min(1, doorInt[i] / (desk.doors * duration)) : 0,
        gateQueue: { mean: duration > 0 ? gateInt[i] / duration : 0, max: Math.max(gateMax[i], queueNow), now: queueNow },
        doorsBusyNow: desk.docked.length,
        fillRate: desk.role === 'out' && planned[i] > 0 ? Math.min(1, loaded[i] / planned[i]) : null,
        gateQueueSeries: series[i].slice(),
      };
    }
    out.ops = { ...(out.ops || {}), trucks };
  }

  reset();
  return { reset, sample, onEvent, report };
}
