import { apiFetch } from './client.js'
import type { ModelConfig, ModelConfigPatch, CatalogModel } from './types.js'

export async function fetchModelConfigs(): Promise<ModelConfig[]> {
  const res = await apiFetch(`/api/agents`)
  const data = (await res.json()) as { configs: ModelConfig[] }
  return data.configs
}

export async function createModelConfig(): Promise<ModelConfig> {
  const res = await apiFetch(`/api/agents`, { method: 'POST' })
  const data = (await res.json()) as { config: ModelConfig }
  return data.config
}

export async function updateModelConfig(id: string, patch: ModelConfigPatch): Promise<ModelConfig> {
  const res = await apiFetch(`/api/agents/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data.config
}

export async function deleteModelConfig(id: string): Promise<void> {
  const res = await apiFetch(`/api/agents/${id}`, { method: 'DELETE' })
  const data = await res.json()
  if (data.error) throw new Error(data.error)
}

export async function fetchModelCatalog(provider: string): Promise<CatalogModel[]> {
  const res = await apiFetch(`/api/agents/models?provider=${encodeURIComponent(provider)}`)
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  return data.models
}

export async function reorderModelConfigs(orderedIds: string[]): Promise<ModelConfig[]> {
  const res = await apiFetch(`/api/agents/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderedIds }),
  })
  const data = (await res.json()) as { configs: ModelConfig[] }
  return data.configs
}

export type { ModelConfig, ModelConfigPatch, CatalogModel } from './types.js'
