import type Database from 'better-sqlite3'
import {
  createWorldbookEntry,
  type WorldbookEntry,
  type WorldbookEntryType,
} from '../../db/worldbook-store.js'

export interface ExtractedBlock {
  entryType: WorldbookEntryType
  content: string
}

// Keep in sync with web/src/worldbookBlocks.ts -- this project has no shared-module path
// between the Node backend and the Vite frontend, so the two copies are kept in sync by hand.
const BLOCK_PATTERN = /\[(CONTENT|ROSTER|MEMORY)\]([\s\S]*?)\[\/\1\]/g

/**
 * Pulls [CONTENT]/[ROSTER]/[MEMORY] blocks out of raw Editor prose. The backreference
 * (\1) means a block only matches when its own closing tag matches its opening tag --
 * guards against a malformed model output ([CONTENT]...[/ROSTER]) silently spanning two
 * intended entries into one. No attempt is made to parse the "Premise:"/"Wants:" style
 * sub-lines inside a block -- the whole span, trimmed, becomes one entry's raw content.
 * Returns an empty array when nothing matches -- that's a normal outcome, not an error.
 */
export function extractWorldbookBlocks(text: string): ExtractedBlock[] {
  const blocks: ExtractedBlock[] = []
  for (const match of text.matchAll(BLOCK_PATTERN)) {
    const entryType = match[1].toLowerCase() as WorldbookEntryType
    const content = match[2].trim()
    if (content) blocks.push({ entryType, content })
  }
  return blocks
}

/** Extracts blocks from Editor output and creates a worldbook entry for each. */
export function applyExtractedWorldbookBlocks(
  db: Database.Database,
  worldbookBookId: string,
  text: string,
): WorldbookEntry[] {
  const created: WorldbookEntry[] = []
  for (const block of extractWorldbookBlocks(text)) {
    const entry = createWorldbookEntry(db, {
      bookId: worldbookBookId,
      entryType: block.entryType,
      content: block.content,
    })
    created.push(entry)
  }
  return created
}
