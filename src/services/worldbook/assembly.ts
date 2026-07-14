import type Database from 'better-sqlite3'
import { getBookByType } from '../../db/book-store.js'
import { listContentEntries } from '../../db/worldbook-store.js'

const GENERIC_PC_NAMES = new Set(['you', 'player', 'pc', 'character', 'protagonist'])

/** Parse PC name from CONTENT entry prose (Editor schema: "PC: Lex. ..."). */
export function resolvePcNameFromContent(db: Database.Database): string | null {
  const worldbook = getBookByType(db, 'worldbook')
  if (!worldbook) return null

  for (const entry of listContentEntries(db, worldbook.id)) {
    const match = entry.content.match(/^PC:\s*([A-Za-z][A-Za-z'-]*)/im)
    if (!match?.[1]) continue
    const name = match[1].trim()
    if (name && !GENERIC_PC_NAMES.has(name.toLowerCase())) return name
  }
  return null
}

/** Always-on CONTENT blocks for Worker prompts — PC identity lives here, not in ROSTER. */
export function buildContentBlockForWorker(db: Database.Database): string {
  const worldbook = getBookByType(db, 'worldbook')
  if (!worldbook) return ''

  const blocks = listContentEntries(db, worldbook.id).map((e) => `[CONTENT]\n${e.content.trim()}`)
  return blocks.join('\n\n')
}

/** Parse Register/tone line from CONTENT (Editor schema: "Register: ..."). */
export function resolveRegisterFromContent(db: Database.Database): string | null {
  const worldbook = getBookByType(db, 'worldbook')
  if (!worldbook) return null

  for (const entry of listContentEntries(db, worldbook.id)) {
    const match = entry.content.match(/^Register:\s*(.+)$/im)
    if (match?.[1]?.trim()) return match[1].trim()
  }
  return null
}

export function compressRegisterGuidance(register: string | null): string {
  if (!register) {
    return (
      'REGISTER: Summaries are brief in-world memory notes — not clinical reportage. ' +
      'Preserve emotional color, tension, and how people spoke ( dialect, formality, heat ) even in short notes. ' +
      'Do not flatten vivid scenes into neutral textbook prose.'
    )
  }
  return (
    `REGISTER (match this tone in every summary — do not write neutral/clinical prose): ${register}. ` +
    'Memory notes stay short but keep voice, emotional color, and speech flavor from the source.'
  )
}

export function compressPcGuidance(pcName: string | null): string {
  if (pcName) {
    return (
      `Player character: ${pcName}. Summaries are third-person memory notes — never use "you/your". ` +
      `GM narration in second person ("you arrive", "your bag") refers to ${pcName}; write "${pcName} arrives", "${pcName}'s bag".`
    )
  }
  return (
    `Summaries are third-person memory notes. When GM text uses "you/your" to address the player character, ` +
    `resolve to the PC's proper name from the CONTENT block below if given.`
  )
}

/** If a summary includes speech with an opening quote but no closing quote, add one. */
export function balanceSpeechQuotes(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return text

  const straight = (trimmed.match(/"/g) ?? []).length
  if (straight % 2 === 1) return `${trimmed}"`

  const openCurly = (trimmed.match(/“/g) ?? []).length
  const closeCurly = (trimmed.match(/”/g) ?? []).length
  if (openCurly > closeCurly) return `${trimmed}”`

  return text
}

/** Post-process: convert lingering second-person PC address to proper name. */
export function resolvePcInSummary(summary: string, pcName: string): string {
  if (!summary.trim() || !pcName.trim()) return summary
  const escaped = pcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (new RegExp(`\\b${escaped}\\b`, 'i').test(summary)) return summary

  return summary
    .replace(/\bYour\b/g, `${pcName}'s`)
    .replace(/\byour\b/g, `${pcName}'s`)
    .replace(/\bYours\b/g, `${pcName}'s`)
    .replace(/\byours\b/g, `${pcName}'s`)
    .replace(/\bYou\b/g, pcName)
    .replace(/\byou\b/g, pcName)
}
