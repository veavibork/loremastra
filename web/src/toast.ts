import { API_BASE, getSessionId } from './api'

export type ToastSeverity = 'info' | 'warning' | 'error' | 'critical'

export interface Toast {
  id: string
  severity: ToastSeverity
  title?: string
  message: string
  createdAt: number
}

const AUTO_DISMISS_MS: Record<ToastSeverity, number | null> = {
  info: 4000,
  warning: 6000,
  error: 8000,
  critical: null,
}

type ToastListener = (toasts: Toast[]) => void

let toasts: Toast[] = []
const listeners: ToastListener[] = []

function emit(): void {
  for (const listener of listeners) listener(toasts)
}

export function subscribeToasts(listener: ToastListener): () => void {
  listeners.push(listener)
  listener(toasts)
  return () => {
    const i = listeners.indexOf(listener)
    if (i !== -1) listeners.splice(i, 1)
  }
}

export function dismissToast(id: string): void {
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

/**
 * Fire-and-forget log to the backend for later "run the numbers" analysis. Plain fetch,
 * not apiFetch — going through apiFetch's 409 handling here could recursively trigger
 * onSuperseded from inside error reporting itself, and a failed log-POST (backend down)
 * must never cascade into another toast/log attempt.
 */
function reportToBackend(toast: Toast): void {
  if (toast.severity === 'info') return
  const sessionId = getSessionId()
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (sessionId) headers.set('X-Loremaster-Session', sessionId)
  fetch(`${API_BASE}/api/client-errors`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      severity: toast.severity,
      message: toast.message,
      url: location.href,
      userAgent: navigator.userAgent,
    }),
  }).catch(() => {})
}

export function pushToast(input: {
  severity: ToastSeverity
  message: string
  title?: string
}): void {
  const toast: Toast = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    severity: input.severity,
    title: input.title,
    message: input.message,
    createdAt: Date.now(),
  }
  toasts = [toast, ...toasts]
  emit()
  reportToBackend(toast)

  const duration = AUTO_DISMISS_MS[toast.severity]
  if (duration !== null) {
    setTimeout(() => dismissToast(toast.id), duration)
  }
}

export const toast = {
  info: (message: string, title?: string) => pushToast({ severity: 'info', message, title }),
  warning: (message: string, title?: string) => pushToast({ severity: 'warning', message, title }),
  error: (message: string, title?: string) => pushToast({ severity: 'error', message, title }),
  critical: (message: string, title?: string) =>
    pushToast({ severity: 'critical', message, title }),
}
