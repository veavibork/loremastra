import { useEffect, useRef, useState } from 'react'
import type { LayoutConfigData } from './api'
import ButtonContainerRow from './ButtonContainerRow'
import { flattenNavTabs } from './layoutUtils'
import { resolvePanel } from './Registry'
import type { PanelProps } from './panel-types'
import './Nav.css'

const OPEN_TABS_STORAGE_KEY = 'loremaster.openTabs'
const MIN_COLUMN_PERCENT = 12

export default function Nav({
  config,
  panelProps,
}: {
  config: LayoutConfigData
  panelProps: PanelProps
}) {
  const allTabs = flattenNavTabs(config)

  const [openIds, setOpenIds] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(OPEN_TABS_STORAGE_KEY) ?? 'null') as
        string[] | null
      if (saved?.length) return saved.filter((id) => allTabs.some((t) => t.id === id))
    } catch {
      // ignore malformed storage
    }
    return allTabs[0] ? [allTabs[0].id] : []
  })
  const [widths, setWidths] = useState<Record<string, number>>({})
  const rowRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    localStorage.setItem(OPEN_TABS_STORAGE_KEY, JSON.stringify(openIds))
    const equalShare = 100 / (openIds.length || 1)
    setWidths(Object.fromEntries(openIds.map((id) => [id, equalShare])))
  }, [openIds])

  function toggleTab(id: string) {
    setOpenIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  function startResize(e: React.MouseEvent, leftId: string, rightId: string) {
    e.preventDefault()
    const row = rowRef.current
    if (!row) return
    const totalWidth = row.getBoundingClientRect().width
    const startX = e.clientX
    const startLeft = widths[leftId] ?? 100 / openIds.length
    const startRight = widths[rightId] ?? 100 / openIds.length
    const pairTotal = startLeft + startRight

    function onMove(moveEvent: MouseEvent) {
      const deltaPct = ((moveEvent.clientX - startX) / totalWidth) * 100
      const newLeft = Math.min(
        pairTotal - MIN_COLUMN_PERCENT,
        Math.max(MIN_COLUMN_PERCENT, startLeft + deltaPct),
      )
      setWidths((w) => ({ ...w, [leftId]: newLeft, [rightId]: pairTotal - newLeft }))
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div className="nav-shell">
      <nav className="nav-tabbar">
        <ButtonContainerRow
          storageScope="nav"
          containers={config.nav.containers}
          resolveLabel={(id, fallback) => fallback ?? allTabs.find((t) => t.id === id)?.label ?? id}
          getButtonProps={(id) => ({
            onClick: () => toggleTab(id),
            active: openIds.includes(id),
          })}
        />
      </nav>

      <div className="nav-columns" ref={rowRef}>
        {openIds.length === 0 && <p className="nav-empty">No panels open — click a tab above.</p>}
        {openIds.map((id, i) => {
          const tab = allTabs.find((t) => t.id === id)
          const Panel = tab ? resolvePanel(tab.id) : null
          return (
            <div
              key={id}
              className="nav-column-group"
              style={{ flexBasis: `${widths[id] ?? 100 / openIds.length}%` }}
            >
              <div className="nav-column">
                <div className="nav-column-header">
                  <span>{tab?.label}</span>
                  <button
                    type="button"
                    className="nav-column-close"
                    onClick={() => toggleTab(id)}
                    aria-label={`Close ${tab?.label}`}
                  >
                    ×
                  </button>
                </div>
                <div className="nav-column-body">
                  {Panel ? (
                    <Panel {...panelProps} inputBar={config.inputBar} />
                  ) : (
                    <p>Nothing configured here yet.</p>
                  )}
                </div>
              </div>
              {i < openIds.length - 1 && (
                <div
                  className="nav-resize-handle"
                  onMouseDown={(e) => startResize(e, id, openIds[i + 1])}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
