import { useEffect, useState } from 'react'
import type { LayoutContainer, LayoutJustify } from './api'
import './ButtonContainerRow.css'

const COLLAPSE_STORAGE_PREFIX = 'loremaster.containerCollapsed.'

function justifyClass(justify: LayoutJustify): string {
  if (justify === 'center') return 'button-container-row-center'
  if (justify === 'right') return 'button-container-row-right'
  return 'button-container-row-left'
}

export interface InputBarButtonProps {
  onClick: () => void
  disabled?: boolean
  active?: boolean
  className?: string
}

export interface ButtonContainerRowProps {
  storageScope: string
  containers: LayoutContainer[]
  resolveLabel: (id: string, fallback?: string) => string
  getButtonProps: (id: string) => InputBarButtonProps | null
  trailing?: React.ReactNode
}

function loadCollapsed(scope: string, containerId: string): boolean {
  try {
    return localStorage.getItem(`${COLLAPSE_STORAGE_PREFIX}${scope}.${containerId}`) === 'true'
  } catch {
    return false
  }
}

export default function ButtonContainerRow({
  storageScope,
  containers,
  resolveLabel,
  getButtonProps,
  trailing,
}: ButtonContainerRowProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  useEffect(() => {
    const next: Record<string, boolean> = {}
    for (const c of containers) {
      if (c.showButton) next[c.id] = loadCollapsed(storageScope, c.id)
    }
    setCollapsed(next)
  }, [storageScope, containers])

  function toggleCollapsed(containerId: string) {
    setCollapsed((prev) => {
      const nextVal = !prev[containerId]
      try {
        localStorage.setItem(
          `${COLLAPSE_STORAGE_PREFIX}${storageScope}.${containerId}`,
          String(nextVal),
        )
      } catch {
        // ignore
      }
      return { ...prev, [containerId]: nextVal }
    })
  }

  return (
    <div className="button-container-row">
      {containers.map((container) => {
        if (!container.visible) return null
        const isCollapsed = container.showButton && collapsed[container.id]
        const visibleButtons = container.buttons.filter(
          (b) => b.visible && getButtonProps(b.id) !== null,
        )

        return (
          <div key={container.id} className={`button-container ${justifyClass(container.justify)}`}>
            {container.showButton && (
              <button
                type="button"
                className="button-container-toggle"
                onClick={() => toggleCollapsed(container.id)}
                aria-expanded={!isCollapsed}
              >
                {container.showLabel && container.label ? `${container.label} ` : ''}
                {isCollapsed ? '▸' : '▾'}
              </button>
            )}
            {!container.showButton && container.showLabel && container.label && (
              <span className="button-container-label">{container.label}</span>
            )}
            {!isCollapsed && (
              <div className="button-container-buttons">
                {visibleButtons.map((btn) => {
                  const props = getButtonProps(btn.id)!
                  return (
                    <button
                      key={btn.id}
                      type="button"
                      className={
                        [props.active ? 'active' : '', props.className ?? '']
                          .filter(Boolean)
                          .join(' ') || undefined
                      }
                      onClick={props.onClick}
                      disabled={props.disabled}
                    >
                      {resolveLabel(btn.id, btn.label)}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
      {trailing}
    </div>
  )
}
