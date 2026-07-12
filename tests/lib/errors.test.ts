import { describe, it, expect } from 'vitest'
import { formatError, logUnhandledError } from '../../src/lib/errors.js'

describe('formatError', () => {
  it('returns the message from an Error', () => {
    expect(formatError(new Error('boom'))).toBe('boom')
  })

  it('returns the string for a string', () => {
    expect(formatError('plain string')).toBe('plain string')
  })

  it('handles null/undefined', () => {
    expect(formatError(null)).toBe('null')
    expect(formatError(undefined)).toBe('undefined')
  })

  it('handles a number', () => {
    expect(formatError(42)).toBe('42')
  })
})

describe('logUnhandledError', () => {
  it('does not throw', () => {
    // logUnhandledError should never throw even with weird inputs
    expect(() => logUnhandledError({ source: 'test' }, new Error('test error'))).not.toThrow()
    expect(() => logUnhandledError({ source: 'test', storyId: 's1' }, 'string error')).not.toThrow()
  })
})
