// Seeded, deterministic random numbers. The simulation must NEVER call Math.random().
// Every stochastic component (each source, machine, fleet...) gets its own forked stream
// so that adding a vehicle does not change the random numbers a machine sees.

/** xmur3 string hash -> 32-bit int generator. */
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

/** Create a PRNG (mulberry32). `seed` may be a number or a string. */
export function createRng(seed = 1) {
  const seedInt = typeof seed === 'string' ? xmur3(seed)() : (seed >>> 0) || 0x9e3779b9;
  let a = seedInt;
  const rng = {
    seed: seedInt,
    /** Uniform float in [0, 1). */
    next() {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    /** Uniform float in [lo, hi). */
    range(lo, hi) { return lo + (hi - lo) * rng.next(); },
    /** Uniform integer in [0, n). */
    int(n) { return Math.floor(rng.next() * n); },
    /** Standard normal (Box-Muller). */
    gauss() {
      let u = 0;
      while (u === 0) u = rng.next();
      const v = rng.next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    /** Exponential with the given mean. */
    exp(mean) {
      let u = 0;
      while (u === 0) u = rng.next();
      return -mean * Math.log(u);
    },
    pick(arr) { return arr[rng.int(arr.length)]; },
    /** Independent stream derived from this seed and a label. */
    fork(label) { return createRng(xmur3(seedInt + ':' + label)()); },
  };
  return rng;
}

/**
 * Sample a duration/interval distribution:
 *   { kind: 'const' | 'exp' | 'normal' | 'uniform', mean: seconds, spread: 0..1 }
 * - const:   mean
 * - exp:     exponential with the given mean (spread ignored)
 * - normal:  N(mean, (spread*mean)^2), truncated below at 0.1*mean
 * - uniform: uniform on mean*(1 +/- spread)
 * `factor` multiplies the result (used for runtime what-if factors).
 */
export function sampleDist(rng, dist, factor = 1) {
  const mean = Math.max(0, dist.mean);
  const spread = Math.min(1, Math.max(0, dist.spread ?? 0));
  let x;
  switch (dist.kind) {
    case 'exp': x = rng.exp(mean); break;
    case 'normal': x = Math.max(0.1 * mean, mean + rng.gauss() * spread * mean); break;
    case 'uniform': x = mean * (1 + spread * (2 * rng.next() - 1)); break;
    case 'const':
    default: x = mean;
  }
  return x * factor;
}
