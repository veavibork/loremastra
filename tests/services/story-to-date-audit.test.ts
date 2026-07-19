/** Coverage-audit vote tallying + judge-output parsing (services/story-to-date/audit.ts). */
import { describe, it, expect } from 'vitest'
import {
  parseAuditJudge,
  tallyAuditVotes,
  type AuditVote,
} from '../../src/services/story-to-date/audit.js'

const pass: AuditVote = { verdict: 'pass', missing: [] }
const fail = (...missing: string[]): AuditVote => ({ verdict: 'fail', missing })

describe('tallyAuditVotes (3 votes, flag at 2 fails)', () => {
  it('stays undecided while the outcome can still change', () => {
    expect(tallyAuditVotes([pass])).toBeNull()
    expect(tallyAuditVotes([fail('- a')])).toBeNull()
    expect(tallyAuditVotes([pass, fail('- a')])).toBeNull()
  })

  it('early-exits once two votes agree', () => {
    expect(tallyAuditVotes([pass, pass])?.verdict).toBe('pass')
    expect(tallyAuditVotes([fail('- a'), fail('- b')])?.verdict).toBe('flagged')
  })

  it('resolves a split on the third vote', () => {
    expect(tallyAuditVotes([pass, fail('- a'), pass])?.verdict).toBe('pass')
    expect(tallyAuditVotes([fail('- a'), pass, fail('- b')])?.verdict).toBe('flagged')
  })

  it('unions and dedupes missing lines from failing votes only', () => {
    const result = tallyAuditVotes([fail('- a (post 3)', '- b (post 5)'), fail('- a (post 3)')])
    expect(result?.missing).toEqual(['- a (post 3)', '- b (post 5)'])
  })

  it('a pass verdict carries no missing lines even if a lone fail vote had some', () => {
    const result = tallyAuditVotes([pass, fail('- a'), pass])
    expect(result?.missing).toEqual([])
  })
})

describe('parseAuditJudge', () => {
  it('parses verdict and missing lines', () => {
    const vote = parseAuditJudge(
      '[MISSING]\n- Rook promised Briar an anchor (post 12)\n- pet name "little bird" (post 14)\n[/MISSING]\n[VERDICT]fail[/VERDICT]',
    )
    expect(vote?.verdict).toBe('fail')
    expect(vote?.missing).toHaveLength(2)
  })

  it('parses a clean pass with empty missing section', () => {
    const vote = parseAuditJudge('[MISSING]\n[/MISSING]\n[VERDICT]pass[/VERDICT]')
    expect(vote).toEqual({ verdict: 'pass', missing: [] })
  })

  it('returns null on output with no verdict tag', () => {
    expect(parseAuditJudge('the block looks fine to me')).toBeNull()
  })
})
