import { describe, expect, it } from 'vitest'
import {
  FAMILY_PATTERNS,
  KWARG_HYPOTHESES,
  LEAK_TOKEN_HYPOTHESES,
  PROMPT_CONTROL_HYPOTHESES,
  THINKING_TAG_HYPOTHESES,
  allLeakScanTokens,
  familyForModelId,
} from '../../src/data/format-hypotheses.js'

describe('format hypothesis corpus integrity', () => {
  it('every entry carries at least one source and one family', () => {
    const entries = [
      ...THINKING_TAG_HYPOTHESES,
      ...LEAK_TOKEN_HYPOTHESES,
      ...KWARG_HYPOTHESES,
      ...PROMPT_CONTROL_HYPOTHESES,
      ...FAMILY_PATTERNS.map((p) => ({ families: [p.family], sources: p.sources })),
    ]
    for (const e of entries) {
      expect(e.sources.length).toBeGreaterThan(0)
      expect(e.families.length).toBeGreaterThan(0)
    }
  })

  it('leak tokens are unique', () => {
    const tokens = LEAK_TOKEN_HYPOTHESES.map((t) => t.token)
    expect(new Set(tokens).size).toBe(tokens.length)
  })

  it('kwarg keys are unique', () => {
    const keys = KWARG_HYPOTHESES.map((k) => k.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('family patterns compile as case-insensitive regexes', () => {
    for (const p of FAMILY_PATTERNS) {
      expect(() => new RegExp(p.pattern, 'i')).not.toThrow()
    }
  })

  it('allLeakScanTokens includes thinking markers and leak tokens', () => {
    const all = allLeakScanTokens()
    expect(all).toContain('<|im_end|>')
    expect(all).toContain('<think>')
    expect(all).toContain('</think>')
    expect(all).toContain('<channel|>')
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('familyForModelId', () => {
  // Real Featherless catalog ids this project has actually used.
  const cases: Array<[string, string]> = [
    ['deepseek-ai/DeepSeek-V4-Pro', 'deepseek'],
    ['NousResearch/Hermes-3-Llama-3.1-8B', 'hermes'], // hermes must win over llama3
    ['zai-org/GLM-4.7-Flash', 'glm'],
    ['moonshotai/Kimi-K2.7-Code', 'kimi'],
    ['Qwen/Qwen3-8B', 'qwen'],
    ['google/gemma-4-E2B-it', 'gemma4'], // gemma4 must win over gemma
    ['openai/gpt-oss-20b', 'gpt-oss'],
  ]
  for (const [id, family] of cases) {
    it(`${id} → ${family}`, () => {
      expect(familyForModelId(id)).toBe(family)
    })
  }

  it('returns null for an unrecognized id', () => {
    expect(familyForModelId('acme/TotallyNovel-7B')).toBeNull()
  })

  it('the chatml fallback pattern never matches any id', () => {
    expect(familyForModelId('chatml')).toBeNull()
  })
})
