/**
 * Agent behaviour is stochastic. One run that ends without a violation is not
 * evidence that the rule holds; it is one sample. These helpers keep the
 * reporting honest about how little a small n tells you.
 */

export interface Interval {
  low: number;
  high: number;
}

/**
 * Wilson score interval for a binomial proportion. Chosen over the normal
 * approximation because it stays inside [0,1] and behaves at n=1 and at
 * p=0 or 1, which is exactly where our numbers live.
 */
export function wilson(successes: number, n: number, z = 1.96): Interval {
  if (n <= 0) return { low: 0, high: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { low: Math.max(0, (centre - margin) / denom), high: Math.min(1, (centre + margin) / denom) };
}

/** Rounded to whole percents, for prose. */
export function intervalPercent(i: Interval): string {
  return `${Math.round(i.low * 100)}–${Math.round(i.high * 100)}%`;
}

/**
 * How many consecutive clean trials it takes before the upper bound on the
 * violation rate drops below `target`. Answers "how many runs do I need?"
 * with a number instead of a shrug.
 */
export function trialsForUpperBound(target: number, z = 1.96): number {
  for (let n = 1; n <= 10_000; n++) {
    if (wilson(0, n, z).high < target) return n;
  }
  return 10_000;
}

/**
 * Plain-English caution for a run of n clean trials. We never say "safe".
 */
export function cleanRunCaveat(n: number): string {
  if (n === 0) return "no live trials ran";
  const hi = wilson(0, n).high;
  return `${n} clean trial${n === 1 ? "" : "s"}; with this few, a violation rate as high as ${Math.round(hi * 100)}% is still consistent with what we saw`;
}

/**
 * Two-proportion comparison for compare: did head actually differ from base,
 * or is this noise? Returns null when either arm has no trials.
 *
 * Uses the Wilson intervals rather than a p-value: the question a reviewer
 * asks is "could these be the same?", and non-overlapping intervals answer it
 * conservatively without pretending we ran a designed experiment.
 */
export function differs(aSuccess: number, aN: number, bSuccess: number, bN: number): { differs: boolean; why: string } | null {
  if (aN === 0 || bN === 0) return null;
  const a = wilson(aSuccess, aN);
  const b = wilson(bSuccess, bN);
  const apart = a.high < b.low || b.high < a.low;
  return {
    differs: apart,
    why: apart
      ? `${aSuccess}/${aN} (${intervalPercent(a)}) vs ${bSuccess}/${bN} (${intervalPercent(b)}): the intervals do not overlap`
      : `${aSuccess}/${aN} (${intervalPercent(a)}) vs ${bSuccess}/${bN} (${intervalPercent(b)}): the intervals overlap, so this run cannot tell them apart`,
  };
}
