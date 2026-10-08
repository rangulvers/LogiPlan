// Smooth weighted round-robin (the nginx algorithm): deterministic, spreads picks as evenly as the
// weights allow (weights 3:1 give a a b a a a b a ..., exactly 75 % / 25 % over every 4 picks).
// Used wherever a station splits its output over several outgoing flows.

export class Swrr {
  /**
   * @param {number[]} weights relative shares; a non-positive or non-finite weight means "no share".
   *   When no entry has a share at all, all entries share equally (a load must never be stranded by weights).
   */
  constructor(weights) {
    this.size = weights.length;
    const clean = Float64Array.from(weights, (w) => (Number.isFinite(w) && w > 0 ? w : 0));
    this.share = clean.some((w) => w > 0) ? clean : new Float64Array(this.size).fill(1);
    this.current = new Float64Array(this.size);
    this.mask = new Uint8Array(this.size);
  }

  /**
   * Pick the next index among those for which `eligible(i)` is true and that have a share, or -1 when none is.
   * Only eligible entries earn credit, so a temporarily full flow does not distort the long-run shares.
   * An entry without a share never receives anything while another entry has one: its loads wait instead.
   * @param {(i: number) => boolean} eligible
   */
  pick(eligible) {
    const { size, share, current, mask } = this;
    let count = 0;
    let first = -1;
    for (let i = 0; i < size; i++) {
      const ok = share[i] > 0 && eligible(i) ? 1 : 0;
      mask[i] = ok;
      if (ok) {
        count++;
        if (first < 0) first = i;
      }
    }
    if (count <= 1) return first;
    let total = 0;
    let best = -1;
    for (let i = 0; i < size; i++) {
      if (!mask[i]) continue;
      current[i] += share[i];
      total += share[i];
      if (best < 0 || current[i] > current[best]) best = i;
    }
    current[best] -= total;
    return best;
  }
}
