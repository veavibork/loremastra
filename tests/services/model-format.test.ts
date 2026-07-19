import { describe, expect, it } from 'vitest'
import {
  shouldPrefillThinkFor,
  streamIdleTimeoutMsFor,
  splitterTagsFor,
  detectFormatDriftFor,
} from '../../src/services/model-format.js'
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  REASONING_IDLE_TIMEOUT_MS,
} from '../../src/inference/featherless.js'
import {
  ReasoningStreamSplitter,
  DEFAULT_OPEN_TAGS,
  DEFAULT_CLOSE_TAGS,
} from '../../src/inference/reasoning-stream.js'
import type { ModelFormatProfile } from '../../src/inference/format-probe.js'

function profile(overrides: Partial<ModelFormatProfile>): ModelFormatProfile {
  return {
    provider: 'featherless',
    modelId: 'x/y',
    probedAt: '2026-07-19T14:00:00.000Z',
    family: null,
    reasoningFieldName: null,
    inlineThinkingTag: null,
    shape: 'none-observed',
    shapeByCondition: {},
    unmarkedReasoningSuspected: false,
    thinkingOffSuppresses: null,
    thinkingOnProduces: null,
    thinkingBudgetHonored: null,
    leakTokensSeen: [],
    finishReasonReliable: true,
    sane: true,
    saneReasons: [],
    callsAttempted: 8,
    callsSucceeded: 8,
    notes: [],
    ...overrides,
  }
}

const ON = { enable_thinking: true }
const OFF = { enable_thinking: false }

describe('shouldPrefillThinkFor', () => {
  it('never prefills unless thinking is explicitly enabled', () => {
    // Live-confirmed on DeepSeek-V4-Pro 2026-07-19: off+no-prefill streams clean prose.
    expect(shouldPrefillThinkFor(null, 'deepseek-ai/DeepSeek-V4-Pro', OFF)).toBe(false)
    expect(shouldPrefillThinkFor(null, 'deepseek-ai/DeepSeek-V4-Pro', undefined)).toBe(false)
    expect(
      shouldPrefillThinkFor(profile({ family: 'deepseek', thinkingOnProduces: true }), 'x', OFF),
    ).toBe(false)
  })

  it('prefills a deepseek-family model with thinking on (profiled and unprofiled)', () => {
    expect(shouldPrefillThinkFor(null, 'deepseek-ai/DeepSeek-V4-Pro', ON)).toBe(true)
    expect(
      shouldPrefillThinkFor(
        profile({ family: 'deepseek', thinkingOnProduces: true }),
        'deepseek-ai/DeepSeek-V4-Pro',
        ON,
      ),
    ).toBe(true)
  })

  it('does not prefill other families even when thinking is on', () => {
    expect(shouldPrefillThinkFor(null, 'zai-org/GLM-5.2', ON)).toBe(false)
    expect(
      shouldPrefillThinkFor(profile({ family: 'qwen', thinkingOnProduces: true }), 'Qwen/Q', ON),
    ).toBe(false)
  })

  it('does not prefill a deepseek-named model whose probe says it cannot think', () => {
    expect(
      shouldPrefillThinkFor(
        profile({ family: 'deepseek', thinkingOnProduces: false }),
        'deepseek-ai/Distill-NoThink',
        ON,
      ),
    ).toBe(false)
  })
})

describe('streamIdleTimeoutMsFor', () => {
  it('falls back to the name heuristic without a profile', () => {
    expect(streamIdleTimeoutMsFor(null, 'deepseek-ai/DeepSeek-V4-Pro', ON)).toBe(
      REASONING_IDLE_TIMEOUT_MS,
    )
    expect(streamIdleTimeoutMsFor(null, 'zai-org/GLM-5.2', OFF)).toBe(DEFAULT_IDLE_TIMEOUT_MS)
  })

  it('gives the short budget when the probe says thinking-on produces nothing', () => {
    expect(streamIdleTimeoutMsFor(profile({ thinkingOnProduces: false }), 'x', ON)).toBe(
      DEFAULT_IDLE_TIMEOUT_MS,
    )
  })

  it('gives the long budget with thinking off when the model ignores the off switch', () => {
    expect(streamIdleTimeoutMsFor(profile({ thinkingOffSuppresses: false }), 'x', OFF)).toBe(
      REASONING_IDLE_TIMEOUT_MS,
    )
    expect(streamIdleTimeoutMsFor(profile({ thinkingOffSuppresses: true }), 'x', OFF)).toBe(
      DEFAULT_IDLE_TIMEOUT_MS,
    )
  })
})

describe('splitterTagsFor', () => {
  it('defaults to the hardcoded think pair', () => {
    expect(splitterTagsFor(null)).toEqual({
      openTags: [...DEFAULT_OPEN_TAGS],
      closeTags: [...DEFAULT_CLOSE_TAGS],
    })
  })

  it('adds a probe-confirmed variant on top of the defaults', () => {
    const tags = splitterTagsFor(
      profile({ inlineThinkingTag: { open: '<seed:think>', close: '</seed:think>' } }),
    )
    expect(tags.openTags).toEqual(['<think>', '<seed:think>'])
    expect(tags.closeTags).toEqual(['</think>', '</seed:think>'])
  })

  it('does not duplicate the default pair', () => {
    const tags = splitterTagsFor(
      profile({ inlineThinkingTag: { open: '<think>', close: '</think>' } }),
    )
    expect(tags.openTags).toEqual(['<think>'])
    expect(tags.closeTags).toEqual(['</think>'])
  })
})

describe('detectFormatDriftFor', () => {
  const clean = { sawReasoningField: false, sawInlineThinking: false, answerText: 'Prose.' }

  it('never flags without a profile, and silence never flags', () => {
    expect(detectFormatDriftFor(null, OFF, { ...clean, sawReasoningField: true })).toEqual([])
    expect(
      detectFormatDriftFor(
        profile({ thinkingOnProduces: true, reasoningFieldName: null }),
        ON,
        clean,
      ),
    ).toEqual([])
  })

  it('flags reasoning that appears despite a working off switch', () => {
    const p = profile({ thinkingOffSuppresses: true, reasoningFieldName: 'reasoning' })
    const reasons = detectFormatDriftFor(p, OFF, { ...clean, sawReasoningField: true })
    expect(reasons.some((r) => r.includes('thinking off'))).toBe(true)
  })

  it('does not flag off-mode reasoning when the profile already says the switch is ignored', () => {
    const p = profile({ thinkingOffSuppresses: false, reasoningFieldName: 'reasoning' })
    expect(detectFormatDriftFor(p, OFF, { ...clean, sawReasoningField: true })).toEqual([])
  })

  it('flags a reasoning field / inline tag the probe never observed', () => {
    const noField = profile({ thinkingOffSuppresses: null, reasoningFieldName: null })
    expect(
      detectFormatDriftFor(noField, ON, { ...clean, sawReasoningField: true }).some((r) =>
        r.includes('delta field'),
      ),
    ).toBe(true)
    const noTag = profile({ inlineThinkingTag: null })
    expect(
      detectFormatDriftFor(noTag, ON, { ...clean, sawInlineThinking: true }).some((r) =>
        r.includes('inline thinking tags'),
      ),
    ).toBe(true)
  })

  it('flags a new template-token leak but tolerates known ones', () => {
    const p = profile({ leakTokensSeen: ['<|im_end|>'] })
    expect(detectFormatDriftFor(p, ON, { ...clean, answerText: 'Prose.<|im_end|>' })).toEqual([])
    const reasons = detectFormatDriftFor(p, ON, { ...clean, answerText: 'Prose.<|eot_id|>' })
    expect(reasons.some((r) => r.includes('<|eot_id|>'))).toBe(true)
  })

  it('ignores probe-only tokens in live prose ([INST] bracket-note collision)', () => {
    const reasons = detectFormatDriftFor(profile({}), ON, {
      ...clean,
      answerText: 'The sign reads [INST]ANT SOUP[/INST] in crooked letters.',
    })
    expect(reasons.filter((r) => r.includes('[INST]'))).toEqual([])
  })
})

describe('ReasoningStreamSplitter with custom tags', () => {
  it('splits on a profile-confirmed variant tag', () => {
    const splitter = new ReasoningStreamSplitter({
      openTags: ['<think>', '<seed:think>'],
      closeTags: ['</think>', '</seed:think>'],
    })
    let thinking = ''
    let answer = ''
    splitter.push(
      '<seed:think>planning the scene</seed:think>The door creaks open.',
      (t) => (thinking += t),
      (t) => (answer += t),
    )
    splitter.flush(
      (t) => (thinking += t),
      (t) => (answer += t),
    )
    expect(thinking).toBe('planning the scene')
    expect(answer).toBe('The door creaks open.')
  })

  it('holds a partial variant tag across chunk boundaries', () => {
    const splitter = new ReasoningStreamSplitter({
      openTags: ['<think>', '<seed:think>'],
      closeTags: ['</think>', '</seed:think>'],
    })
    let thinking = ''
    let answer = ''
    const emitT = (t: string) => (thinking += t)
    const emitA = (t: string) => (answer += t)
    splitter.push('Intro. <seed:th', emitT, emitA)
    splitter.push('ink>hidden</seed:think>Rest.', emitT, emitA)
    splitter.flush(emitT, emitA)
    expect(thinking).toBe('hidden')
    expect(answer).toBe('Intro. Rest.')
  })
})
