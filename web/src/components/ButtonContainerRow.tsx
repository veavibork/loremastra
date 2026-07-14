import type { LayoutContainer, LayoutJustify } from '../api'
import './ButtonContainerRow.css'
import { useContainerCollapsed } from '../store'

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

function ContainerGroup({
  storageScope,
  container,
  resolveLabel,
  getButtonProps,
  trailing,
}: {
  storageScope: string
  container: LayoutContainer
  resolveLabel: (id: string, fallback?: string) => string
  getButtonProps: (id: string) => InputBarButtonProps | null
  trailing?: React.ReactNode
}) {
  const [collapsed, toggle] = useContainerCollapsed(storageScope, container.id)
  const buttons = container.buttons ?? []
  if (buttons.length === 0 && !trailing) return null

  return (
    <div
      key={container.id}
      className={`button-container-group ${collapsed ? 'button-container-collapsed' : ''}`}
    >
      {container.label && (
        <button
          type="button"
          className="button-container-label"
          onClick={toggle}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${container.label}`}
        >
          {container.label}
        </button>
      )}
      {!collapsed && (
        <div className={`button-container-buttons ${justifyClass(container.justify)}`}>
          {buttons.map((btn) => {
            const props = getButtonProps(btn.id)
            if (!props) return null
            return (
              <button
                key={btn.id}
                type="button"
                onClick={props.onClick}
                disabled={props.disabled}
                className={`${props.active ? 'active' : ''} ${props.className ?? ''}`}
              >
                {resolveLabel(btn.id, btn.label)}
              </button>
            )
          })}
          {trailing}
        </div>
      )}
    </div>
  )
}

export default function ButtonContainerRow({
  storageScope,
  containers,
  resolveLabel,
  getButtonProps,
  trailing,
}: ButtonContainerRowProps) {
  return (
    <div className="button-container-row">
      {containers.map((container) => {
        if (!container.visible) return null
        return (
          <ContainerGroup
            key={container.id}
            storageScope={storageScope}
            container={container}
            resolveLabel={resolveLabel}
            getButtonProps={getButtonProps}
            trailing={trailing}
          />
        )
      })}
    </div>
  )
}
