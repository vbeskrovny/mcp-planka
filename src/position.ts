/** Planka spaces positions by this gap; new items go at max + GAP. */
export const POSITION_GAP = 65536;

export type PositionSpec = "top" | "bottom" | number | undefined;

/**
 * Compute a fractional position for inserting an item among `existing` positions.
 * - "bottom"/undefined: after the last item
 * - "top": before the first item
 * - number n (0-based): placed so that it becomes the n-th item
 */
export function computePosition(existing: number[], where: PositionSpec = "bottom"): number {
  const sorted = [...existing].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return POSITION_GAP;

  let index: number;
  if (where === "top") index = 0;
  else if (where === "bottom" || where === undefined) index = n;
  else index = Math.max(0, Math.min(Math.trunc(where), n));

  if (index === 0) return sorted[0] / 2;
  if (index >= n) return sorted[n - 1] + POSITION_GAP;
  return (sorted[index - 1] + sorted[index]) / 2;
}
