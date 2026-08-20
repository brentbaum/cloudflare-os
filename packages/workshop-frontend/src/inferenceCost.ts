/** Format a monetary inference total; null is an explicit unknown, never a zero-dollar total. */
export function formatInferenceCost(cost: number | null, precision = 4): string {
  return cost === null ? 'unknown' : `$${cost.toFixed(precision)}`
}
