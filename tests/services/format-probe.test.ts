import { describe, expect, it } from 'vitest'
import {
  aggregateProfile,
  assessSanity,
  detectInlineTag,
  scanLeakTokens,
  stripInlineThinking,
  type ProbeObservation,
} from '../../src/inference/format-probe.js'

function obs(partial: Partial<ProbeObservation>): ProbeObservation {
  return {
    condition: 'baseline',
    run: 1,
    ok: true,
    httpStatus: 200,
    deltaKeys: {},
    content: 'The tavern breathes warm woodsmoke as the door swings shut behind the traveler.',
    reasoningField: '',
    reasoningFieldName: null,
    finishReason: 'stop',
    elapsedMs: 1000,
    ...partial,
  }
}

describe('detectInlineTag', () => {
  it('matches think tags and reports closure', () => {
    const m = detectInlineTag('<think>plan the scene</think>The door creaks open.')
    expect(m).toMatchObject({ open: '<think>', close: '</think>', closed: true })
  })

  it('reports an unclosed block', () => {
    const m = detectInlineTag('<think>still thinking when the budget ran out')
    expect(m).toMatchObject({ open: '<think>', closed: false })
  })

  it('matches the Gemma 4 channel variant', () => {
    const m = detectInlineTag('<|channel>thought\nlet me plan<channel|>Prose here.')
    expect(m).toMatchObject({ open: '<|channel>thought', close: '<channel|>' })
  })

  it('returns null for plain prose', () => {
    expect(detectInlineTag('Just a tavern scene, nothing else.')).toBeNull()
  })
})

describe('stripInlineThinking', () => {
  it('removes a closed block', () => {
    const m = detectInlineTag('<think>hmm</think>Answer text.')!
    expect(stripInlineThinking('<think>hmm</think>Answer text.', m)).toBe('Answer text.')
  })

  it('drops everything after an unclosed open', () => {
    const m = detectInlineTag('Intro. <think>never closes')!
    expect(stripInlineThinking('Intro. <think>never closes', m)).toBe('Intro.')
  })
})

describe('scanLeakTokens', () => {
  it('finds ChatML end tokens', () => {
    expect(scanLeakTokens('A fine scene.<|im_end|>')).toContain('<|im_end|>')
  })

  it('finds the fullwidth DeepSeek EOS', () => {
    expect(scanLeakTokens('Prose<｜end▁of▁sentence｜>')).toContain('<｜end▁of▁sentence｜>')
  })

  it('finds residual thinking markers', () => {
    expect(scanLeakTokens('Prose with a stray </think> in it')).toContain('</think>')
  })

  it('returns empty for clean prose', () => {
    expect(scanLeakTokens('The hearth crackles; a bard tunes her lute.')).toEqual([])
  })
})

describe('assessSanity', () => {
  it('accepts normal prose', () => {
    expect(
      assessSanity(
        'The tavern is warm and loud, its long tables crowded with travelers trading stories over dark ale.',
      ).sane,
    ).toBe(true)
  })

  it('rejects near-empty output', () => {
    const s = assessSanity('ok')
    expect(s.sane).toBe(false)
    expect(s.reasons.length).toBeGreaterThan(0)
  })

  it('rejects token soup', () => {
    const s = assessSanity('<|im_end|><|im_end|><|im_end|><|im_end|>')
    expect(s.sane).toBe(false)
  })
})

describe('aggregateProfile', () => {
  const prose =
    'The tavern is warm and loud, its long tables crowded with travelers trading stories over ale.'

  it('classifies a separate-field model (shape A) with working toggles', () => {
    const p = aggregateProfile('deepseek-ai/DeepSeek-V4-Pro', [
      obs({ condition: 'baseline', content: prose }),
      obs({ condition: 'baseline', run: 2, content: prose }),
      obs({ condition: 'thinking-off', content: prose }),
      obs({ condition: 'thinking-off', run: 2, content: prose }),
      obs({
        condition: 'thinking-on',
        content: prose,
        reasoningField: 'x'.repeat(600),
        reasoningFieldName: 'reasoning',
      }),
      obs({
        condition: 'thinking-on',
        run: 2,
        content: prose,
        reasoningField: 'x'.repeat(500),
        reasoningFieldName: 'reasoning',
      }),
      obs({
        condition: 'thinking-budget',
        content: prose,
        reasoningField: 'x'.repeat(100),
        reasoningFieldName: 'reasoning',
      }),
      obs({
        condition: 'thinking-budget',
        run: 2,
        content: prose,
        reasoningField: 'x'.repeat(120),
        reasoningFieldName: 'reasoning',
      }),
    ])
    expect(p.shape).toBe('separate-field')
    expect(p.reasoningFieldName).toBe('reasoning')
    expect(p.thinkingOnProduces).toBe(true)
    expect(p.thinkingOffSuppresses).toBe(true)
    expect(p.thinkingBudgetHonored).toBe(true)
    expect(p.family).toBe('deepseek')
    expect(p.sane).toBe(true)
    expect(p.finishReasonReliable).toBe(true)
  })

  it('classifies inline tags (shape B) and flags a partial suppressor (Kimi-style)', () => {
    const p = aggregateProfile('moonshotai/Kimi-K2.7-Code', [
      obs({ condition: 'baseline', content: prose }),
      obs({ condition: 'baseline', run: 2, content: `<think>plan</think>${prose}` }),
      obs({
        condition: 'thinking-off',
        content: prose,
        reasoningField: 'residual reasoning the off toggle did not stop',
        reasoningFieldName: 'reasoning',
      }),
      obs({ condition: 'thinking-off', run: 2, content: prose }),
      obs({ condition: 'thinking-on', content: `<think>plan</think>${prose}` }),
      obs({ condition: 'thinking-on', run: 2, content: `<think>plan</think>${prose}` }),
    ])
    expect(p.thinkingOffSuppresses).toBe(false)
    expect(p.notes.some((n) => n.includes('inconsistent'))).toBe(true)
    // Field evidence on ANY run wins over inline tags for shape.
    expect(p.shape).toBe('separate-field')
  })

  it('records per-condition shapes when kwargs change the wire format (live Qwen3-8B pattern)', () => {
    // Replay of the 2026-07-19 live run: no kwargs → inline tags; explicit kwargs → field.
    const p = aggregateProfile('Qwen/Qwen3-8B', [
      obs({ condition: 'baseline', content: `<think>plan</think>${prose}` }),
      obs({ condition: 'baseline', run: 2, content: `<think>plan</think>${prose}` }),
      obs({ condition: 'thinking-off', content: prose }),
      obs({ condition: 'thinking-off', run: 2, content: prose }),
      obs({
        condition: 'thinking-on',
        content: prose,
        reasoningField: 'x'.repeat(888),
        reasoningFieldName: 'reasoning',
      }),
      obs({
        condition: 'thinking-on',
        run: 2,
        content: prose,
        reasoningField: 'x'.repeat(1194),
        reasoningFieldName: 'reasoning',
      }),
      obs({
        condition: 'thinking-budget',
        content: prose,
        reasoningField: 'x'.repeat(1543),
        reasoningFieldName: 'reasoning',
        finishReason: 'length',
      }),
      obs({
        condition: 'thinking-budget',
        run: 2,
        content: prose,
        reasoningField: 'x'.repeat(1088),
        reasoningFieldName: 'reasoning',
      }),
    ])
    expect(p.shapeByCondition).toEqual({
      baseline: 'inline-tagged',
      'thinking-off': 'none-observed',
      'thinking-on': 'separate-field',
      'thinking-budget': 'separate-field',
    })
    expect(p.shape).toBe('separate-field')
    expect(p.thinkingOffSuppresses).toBe(true)
    expect(p.thinkingOnProduces).toBe(true)
    expect(p.thinkingBudgetHonored).toBe(false)
    expect(p.notes.some((n) => n.includes('shape depends on kwargs'))).toBe(true)
  })

  it('suspects unmarked reasoning (shape C) when thinking-on balloons content invisibly', () => {
    const p = aggregateProfile('zai-org/GLM-4.7-Flash', [
      obs({ condition: 'baseline', content: prose }),
      obs({ condition: 'baseline', run: 2, content: prose }),
      obs({ condition: 'thinking-off', content: prose }),
      obs({ condition: 'thinking-off', run: 2, content: prose }),
      obs({
        condition: 'thinking-on',
        content: `1. **Analyze the request:** ${'x'.repeat(400)} ${prose}`,
      }),
      obs({
        condition: 'thinking-on',
        run: 2,
        content: `1. **Analyze:** ${'y'.repeat(400)} ${prose}`,
      }),
    ])
    expect(p.thinkingOnProduces).toBe(false)
    expect(p.unmarkedReasoningSuspected).toBe(true)
    expect(p.shape).toBe('none-observed')
  })

  it('collects leak tokens from answer text but not from stripped thinking blocks', () => {
    const p = aggregateProfile('NousResearch/Hermes-3-Llama-3.1-8B', [
      obs({ condition: 'baseline', content: `${prose}<|im_end|>` }),
      obs({
        condition: 'baseline',
        run: 2,
        content: `<think>uses </think>internally</think>${prose}`,
      }),
    ])
    expect(p.leakTokensSeen).toContain('<|im_end|>')
    expect(p.family).toBe('hermes')
  })

  it('flags unreliable finish_reason and failed calls', () => {
    const p = aggregateProfile('acme/Broken-1B', [
      obs({ condition: 'baseline', finishReason: null }),
      obs({ condition: 'baseline', run: 2, ok: false, httpStatus: 503, error: 'unavailable' }),
    ])
    expect(p.finishReasonReliable).toBe(false)
    expect(p.callsSucceeded).toBe(1)
    expect(p.callsAttempted).toBe(2)
  })

  it('marks insane when baseline output is token soup', () => {
    const p = aggregateProfile('acme/BadTemplate-1B', [
      obs({ condition: 'baseline', content: '<|im_end|><|im_end|>' }),
      obs({ condition: 'baseline', run: 2, content: '' }),
    ])
    expect(p.sane).toBe(false)
    expect(p.saneReasons.length).toBeGreaterThan(0)
  })
})
