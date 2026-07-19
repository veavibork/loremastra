import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LAYOUT_CONFIG,
  LAYOUT_BUTTON_CATALOG,
  normalizeLayoutConfig,
  type LayoutConfigData,
} from '../../src/services/layout.js'

describe('layout button resurrection', () => {
  it('re-adds toggle.length to a saved layout that predates the toggle being wired', () => {
    // A realistic pre-2026-07-19 save: user layout with no toggle.length anywhere.
    const saved: LayoutConfigData = {
      version: 2,
      nav: DEFAULT_LAYOUT_CONFIG.nav,
      inputBar: {
        containers: [
          {
            id: 'input-toggles',
            visible: true,
            showButton: false,
            showLabel: false,
            justify: 'center',
            buttons: [
              { id: 'toggle.effort', label: 'Effort', visible: true },
              { id: 'toggle.reasoning.show', label: 'Trace', visible: true },
              { id: 'toggle.reasoning.expand', label: 'Trace open', visible: true },
            ],
          },
        ],
      },
    }
    const normalized = normalizeLayoutConfig(saved)
    const ids = normalized.inputBar.containers.flatMap((c) => c.buttons.map((b) => b.id))
    expect(ids).toContain('toggle.length')
  })

  it('does not duplicate a button the user already placed (even hidden)', () => {
    const saved: LayoutConfigData = {
      version: 2,
      nav: DEFAULT_LAYOUT_CONFIG.nav,
      inputBar: {
        containers: [
          {
            id: 'input-toggles',
            visible: true,
            showButton: false,
            showLabel: false,
            justify: 'center',
            buttons: [{ id: 'toggle.length', label: 'Len', visible: false }],
          },
        ],
      },
    }
    const normalized = normalizeLayoutConfig(saved)
    const lengthButtons = normalized.inputBar.containers.flatMap((c) =>
      c.buttons.filter((b) => b.id === 'toggle.length'),
    )
    expect(lengthButtons).toHaveLength(1)
    expect(lengthButtons[0]).toMatchObject({ label: 'Len', visible: false })
  })
})

describe('layout button catalog', () => {
  it('offers toggle.length in the input bar', () => {
    expect(LAYOUT_BUTTON_CATALOG.inputBar.map((e) => e.id)).toContain('toggle.length')
  })

  it('excludes the unwired mood/param/model toggles', () => {
    const ids = LAYOUT_BUTTON_CATALOG.inputBar.map((e) => e.id)
    expect(ids).not.toContain('toggle.mood')
    expect(ids).not.toContain('toggle.param')
    expect(ids).not.toContain('toggle.model')
  })

  it('every default-layout button is in the catalog (nothing placeable is undiscoverable)', () => {
    const catalogIds = {
      nav: new Set(LAYOUT_BUTTON_CATALOG.nav.map((e) => e.id)),
      inputBar: new Set(LAYOUT_BUTTON_CATALOG.inputBar.map((e) => e.id)),
    }
    for (const region of ['nav', 'inputBar'] as const) {
      for (const container of DEFAULT_LAYOUT_CONFIG[region].containers) {
        for (const btn of container.buttons) {
          expect(catalogIds[region].has(btn.id), `${region} catalog missing ${btn.id}`).toBe(true)
        }
      }
    }
  })
})
