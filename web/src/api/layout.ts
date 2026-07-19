import { apiFetch } from './client.js'
import type { LayoutConfigData, LayoutConfigResponse } from './types.js'

export async function fetchLayout(): Promise<LayoutConfigResponse> {
  const res = await apiFetch(`/api/layout`)
  return res.json()
}

export async function updateLayout(config: LayoutConfigData): Promise<LayoutConfigResponse> {
  const res = await apiFetch(`/api/layout`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config }),
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data
}

export type {
  LayoutConfigData,
  LayoutConfigResponse,
  LayoutContainer,
  LayoutRegion,
  LayoutButton,
  LayoutJustify,
  LayoutCatalog,
  LayoutCatalogEntry,
} from './types.js'
