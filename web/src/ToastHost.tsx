import { useEffect, useState } from 'react'
import { dismissToast, subscribeToasts, type Toast } from './toast'
import './ToastHost.css'

const TITLE_FALLBACK: Record<Toast['severity'], string> = {
  info: 'Info',
  warning: 'Warning',
  error: 'Error',
  critical: 'Critical error',
}

export default function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([])

  useEffect(() => subscribeToasts(setToasts), [])

  if (toasts.length === 0) return null

  return (
    <div className="toast-host">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.severity}`}>
          <div className="toast-body">
            <div className="toast-title">{t.title ?? TITLE_FALLBACK[t.severity]}</div>
            <div className="toast-message">{t.message}</div>
          </div>
          <button
            type="button"
            className="toast-dismiss"
            onClick={() => dismissToast(t.id)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
