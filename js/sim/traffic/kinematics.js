// Discrete-time braking helpers for the traffic engine. Pure functions.
//
// One tick moves a vehicle from speed v to vNew and advances it by the trapezoid (v + vNew) / 2 * dt.
// The limits below are the *implicit* (end-of-tick) form of "v^2 <= vTarget^2 + 2 * a * distance": following
// them with equality is exactly constant deceleration, so a braking vehicle stops at the target (no
// asymptotic creeping) for any dt.

/** Speed below which a vehicle counts as stationary (TV.moving = v > MOVING_SPEED). */
export const MOVING_SPEED = 0.05;

/**
 * Highest speed at the END of this tick that still lets the vehicle reach speed `vTarget` after covering the
 * remaining distance `d` (measured from the start of the tick) with deceleration `a`.
 * @returns {number} the limit (>= 0), or -1 when even braking as hard as possible cannot satisfy it
 *   (the caller then falls back to maximum deceleration plus the hard distance clamp).
 */
export function brakeLimit(v, d, vTarget, a, dt) {
  if (d <= 0) return vTarget;
  const b = a * dt;
  const c = b * v - 2 * a * d - vTarget * vTarget;
  const disc = b * b - 4 * c;
  if (disc < 0) return -1;
  const root = (Math.sqrt(disc) - b) / 2;
  return root > 0 ? root : 0;
}

/** Distance covered while braking from v to zero at constant deceleration a. */
export const stoppingDistance = (v, a) => (a > 0 ? (v * v) / (2 * a) : Infinity);

/** Distance covered in one tick of braking at full deceleration (stops inside the tick if it can). */
export function brakeAdvance(v, a, dt) {
  return v <= a * dt ? stoppingDistance(v, a) : v * dt - 0.5 * a * dt * dt;
}
