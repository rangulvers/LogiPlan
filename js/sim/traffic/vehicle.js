// The traffic engine's vehicle record (TV). Public fields are the contract of docs/ARCHITECTURE.md §5.2;
// fields starting with an underscore are engine internals (also read by tests/helpers/traffic-invariants.js).

const num = (v, fallback, min = 0) => (Number.isFinite(v) && v > min ? v : fallback);

export class TV {
  /**
   * @param {object} spec { id, owner, length, width, speed, accel, decel } (invalid numbers fall back to defaults)
   * @param {number} cellSize metres per cell, used for the default vehicle width
   */
  constructor(spec, cellSize) {
    this.id = spec.id;
    this.owner = spec.owner ?? null;
    this.length = num(spec.length, 1.2);
    this.width = num(spec.width, Math.min(1, Math.max(0.2, 0.36 * cellSize)));
    this.vmax = num(spec.speed, 1.5);
    this.accel = num(spec.accel, 0.6);
    this.decel = num(spec.decel, 1.0);

    this.onRoad = true;
    this.node = -1; // >= 0 while parked exactly on a node centre (not driving)
    this.edge = -1; // edge the centre is on while driving
    this.s = 0; // metres from the tail of `edge`
    this.lastEdge = -1; // last edge driven (sets the parked lane offset); -1 = fresh vehicle on the centre
    this.v = 0;
    this.x = 0;
    this.y = 0;
    this.heading = 0;
    this.prevX = 0;
    this.prevY = 0;
    this.prevHeading = 0;
    this.driving = false;
    this.moving = false;
    this.waiting = false;
    this.waitReason = null;
    this.blockedBy = null;
    this.disabled = false;
    this.odometer = 0;
    this.waitTime = 0; // seconds of the current uninterrupted wait
    this.teleports = 0; // incremented by addVehicle/attach/relocate (pose discontinuities are legal there)

    // ---- engine internals ----
    this._route = null; // edge ids of the current route (null = none)
    this._nodes = null; // node ids of the current route
    this._ext = []; // straight-line continuation beyond the route end (edges), for overhang of long vehicles
    this._ri = 0; // index into _route of the edge the centre is on
    this._prev = -1; // edge driven before the current one (-1: the route started from the centre line)
    this._lane = -1; // edge whose lane list holds this vehicle (-1: in a fresh list or off road)
    this._ls = 0; // position within that lane (= s while driving, cellSize while parked at the head of lastEdge)
    this._turn = -1; // progress 0..1 of an in-place manoeuvre (U-turn or easing into the lane), -1 when none
    this._x0 = 0; // standstill pose the easing manoeuvre starts from
    this._y0 = 0;
    this._h0 = 0;
    this._held = []; // nodes whose lock this vehicle holds
    this._heldQ = []; // route coordinate at which each held cell is cleared (its exit); recomputed by drive()
    this._req = -1; // node whose lock this vehicle has asked for (-1: no pending request)
    this._chainN = []; // nodes to lock together with the requested one
    this._chainQ = [];
    this._elig = false; // can fully clear the requested cell (room beyond the exit)
    this._gate = null; // vehicle that currently prevents the grant
    this._ldQ = Infinity; // route coordinate of the nearest obstacle rear ahead
    this._ldTv = null;
    this._ldV = 0;
    this._ldDec = 1;
    this._nv = 0; // planned speed at the end of the tick
    this._adv = 0; // planned advance
    this._blk = 0; // 0 none, 1 vehicle ahead, 2 junction
    this._blkTv = null;
    this._blkNode = -1;
    this._vFree = 0; // speed it could drive without anybody in the way (this tick)
    this._seq = 0; // creation order (deterministic tie-break)
  }
}
