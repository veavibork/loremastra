import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TAGS_PATH = path.resolve(__dirname, '../defaults/hf-model-tags.json')

export interface HfModelTagsEntry {
  tags: string[]
  updatedAt?: string
}

let cache: Record<string, HfModelTagsEntry> | null = null

export function loadHfModelTags(): Record<string, HfModelTagsEntry> {
  if (cache) return cache
  if (!existsSync(TAGS_PATH)) {
    cache = {}
    return cache
  }
  cache = JSON.parse(readFileSync(TAGS_PATH, 'utf-8')) as Record<string, HfModelTagsEntry>
  return cache
}

export function getHfTagsForModel(modelId: string): string[] {
  return loadHfModelTags()[modelId]?.tags ?? []
}

export function hfTagsPath(): string {
  return TAGS_PATH
}
