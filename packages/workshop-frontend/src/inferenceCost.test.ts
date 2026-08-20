import { describe, expect, it } from 'vitest'
import { formatInferenceCost } from './inferenceCost'

describe('formatInferenceCost', () => {
  it('never renders an unknown subscription cost as zero dollars', () => {
    expect(formatInferenceCost(null)).toBe('unknown')
    expect(formatInferenceCost(null)).not.toContain('$0')
    expect(formatInferenceCost(0)).toBe('$0.0000')
  })
})
