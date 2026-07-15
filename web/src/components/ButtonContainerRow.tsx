import type { LayoutButton, LayoutContainer, LayoutJustify } from '../api'
import './ButtonContainerRow.css'
import { useContainerCollapsed } from '../store'
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  horizontalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

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
  onReorder?: (containerId: string, reorderedButtons: LayoutButton[]) => void
}

function SortableButton({
  btn,
  resolveLabel,
  buttonProps,
}: {
  btn: LayoutButton
  resolveLabel: (id: string, fallback?: string) => string
  buttonProps: InputBarButtonProps
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: btn.id,
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  return (
    <button
      ref={setNodeRef}
      style={style}
      type="button"
      onClick={buttonProps.onClick}
      disabled={buttonProps.disabled}
      className={`${buttonProps.active ? 'active' : ''} ${buttonProps.className ?? ''} ${isDragging ? 'dragging' : ''}`}
      {...attributes}
      {...listeners}
    >
      {resolveLabel(btn.id, btn.label)}
    </button>
  )
}

function ContainerGroup({
  storageScope,
  container,
  resolveLabel,
  getButtonProps,
  onReorder,
}: {
  storageScope: string
  container: LayoutContainer
  resolveLabel: (id: string, fallback?: string) => string
  getButtonProps: (id: string) => InputBarButtonProps | null
  onReorder?: (containerId: string, reorderedButtons: LayoutButton[]) => void
}) {
  const [collapsed, toggle] = useContainerCollapsed(storageScope, container.id)
  const allButtons = container.buttons ?? []

  // Only include buttons that actually render (getButtonProps returns non-null).
  // This prevents dnd-kit from tracking ghost items with no DOM node.
  const visibleButtons = allButtons.filter((b) => getButtonProps(b.id) !== null)

  if (allButtons.length === 0) return null

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = allButtons.findIndex((b) => b.id === active.id)
    const newIndex = allButtons.findIndex((b) => b.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    onReorder?.(container.id, arrayMove(allButtons, oldIndex, newIndex))
  }

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
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <SortableContext
            items={visibleButtons.map((b) => b.id)}
            strategy={horizontalListSortingStrategy}
          >
            <div className={`button-container-buttons ${justifyClass(container.justify)}`}>
              {visibleButtons.map((btn) => {
                const props = getButtonProps(btn.id)
                if (!props) return null
                return (
                  <SortableButton
                    key={btn.id}
                    btn={btn}
                    resolveLabel={resolveLabel}
                    buttonProps={props}
                  />
                )
              })}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  )
}

export default function ButtonContainerRow({
  storageScope,
  containers,
  resolveLabel,
  getButtonProps,
  onReorder,
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
            onReorder={onReorder}
          />
        )
      })}
    </div>
  )
}
