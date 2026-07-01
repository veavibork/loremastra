import type Database from "better-sqlite3";
import { createPageWithText, createRetryText } from "./content-store.js";
import { getPage, setPageHidden, listPagesForBook } from "./page-store.js";
import { getText, type TextRow } from "./text-store.js";

export type WorldbookEntryType = "setting" | "register" | "location" | "creature" | "faction" | "character";

/** Doc's per-type "Fields:" lists (loremaster.md Structured Schema section). Soft schema, not DB-enforced — used for display labels and the "highlight if non-conforming" UI check, not validation that blocks saving. */
export const WORLDBOOK_FIELD_SCHEMAS: Record<WorldbookEntryType, { key: string; label: string }[]> = {
  setting: [{ key: "pitch", label: "Pitch" }],
  register: [
    { key: "tense", label: "Tense" },
    { key: "tone", label: "Tone" },
    { key: "motifs", label: "Motifs" },
    { key: "welcome", label: "Welcome" },
    { key: "offTable", label: "Off the table" },
  ],
  location: [
    { key: "atmosphere", label: "Atmosphere" },
    { key: "present", label: "Who's present" },
    { key: "available", label: "What's available" },
    { key: "pcResponse", label: "PC response" },
  ],
  // loremaster.md doesn't spell out explicit "Fields:" lists for Creature/Faction (unlike
  // Location/Character) — pulled from lorepebble's st1.json Setup Assistant card instead,
  // per explicit instruction to treat it as the reference for these two schemas.
  creature: [
    { key: "identity", label: "Identity" },
    { key: "cognition", label: "How they think" },
    { key: "speech", label: "Speech" },
    { key: "wants", label: "Wants" },
    { key: "disposition", label: "Disposition" },
    { key: "doNot", label: "Do not" },
  ],
  faction: [
    { key: "identity", label: "Identity" },
    { key: "appearance", label: "How they appear" },
    { key: "stance", label: "Stance toward the PC" },
    { key: "leader", label: "Leader" },
  ],
  character: [
    { key: "identity", label: "Identity" },
    { key: "wants", label: "Wants" },
    { key: "knows", label: "Knows" },
    { key: "disposition", label: "Disposition" },
    { key: "secrets", label: "Secrets" },
    { key: "voice", label: "Voice" },
  ],
};

export interface WorldbookEntry {
  pageId: string;
  bookId: string;
  entryType: WorldbookEntryType;
  isPc: boolean;
  name: string;
  hidden: boolean;
  broken: boolean;
  createdAt: string;
  fields: Record<string, string>;
  currentTextId: string;
}

interface RawWorldbookEntryRow {
  page_id: string;
  entry_type: WorldbookEntryType;
  is_pc: number;
  name: string;
}

function parseFields(genPackage: string | null): Record<string, string> {
  if (!genPackage) return {};
  try {
    const parsed = JSON.parse(genPackage);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function toEntry(row: RawWorldbookEntryRow, page: { bookId: string; hidden: boolean; broken: boolean; createdAt: string }, text: TextRow): WorldbookEntry {
  return {
    pageId: row.page_id,
    bookId: page.bookId,
    entryType: row.entry_type,
    isPc: !!row.is_pc,
    name: row.name,
    hidden: page.hidden,
    broken: page.broken,
    createdAt: page.createdAt,
    fields: parseFields(text.genPackage),
    currentTextId: text.id,
  };
}

/** Friendlier error than the raw SQLite UNIQUE constraint message when a singleton entry type already exists. */
function assertSingletonAvailable(db: Database.Database, worldbookBookId: string, entryType: WorldbookEntryType, isPc: boolean): void {
  if (entryType !== "setting" && entryType !== "register" && !isPc) return;
  const existing = listWorldbookEntries(db, worldbookBookId, { includeHidden: true });
  if (entryType === "setting" && existing.some((e) => e.entryType === "setting")) {
    throw new Error("A Setting entry already exists for this story — there can only be one.");
  }
  if (entryType === "register" && existing.some((e) => e.entryType === "register")) {
    throw new Error("A Register entry already exists for this story — there can only be one.");
  }
  if (isPc && existing.some((e) => e.isPc)) {
    throw new Error("A PC entry already exists for this story — there can only be one.");
  }
}

export function createWorldbookEntry(
  db: Database.Database,
  input: { bookId: string; entryType: WorldbookEntryType; isPc?: boolean; name: string; fields: Record<string, string> }
): WorldbookEntry {
  const isPc = input.isPc ?? false;
  assertSingletonAvailable(db, input.bookId, input.entryType, isPc);

  const run = db.transaction(() => {
    const { page, text } = createPageWithText(db, {
      bookId: input.bookId,
      role: "system",
      genPackage: JSON.stringify(input.fields),
    });
    db.prepare(`INSERT INTO worldbook_entry (page_id, entry_type, is_pc, name) VALUES (?, ?, ?, ?)`).run(
      page.id,
      input.entryType,
      isPc ? 1 : 0,
      input.name
    );
    return { page, text };
  });
  const { page } = run();
  return getWorldbookEntry(db, page.id)!;
}

export function getWorldbookEntry(db: Database.Database, pageId: string): WorldbookEntry | null {
  const row = db.prepare(`SELECT * FROM worldbook_entry WHERE page_id = ?`).get(pageId) as RawWorldbookEntryRow | undefined;
  if (!row) return null;
  const page = getPage(db, pageId);
  if (!page || !page.selectedTextId) return null;
  const text = getText(db, page.selectedTextId);
  if (!text) return null;
  return toEntry(row, page, text);
}

export function listWorldbookEntries(
  db: Database.Database,
  worldbookBookId: string,
  opts?: { includeHidden?: boolean }
): WorldbookEntry[] {
  const pages = listPagesForBook(db, worldbookBookId);
  const entries: WorldbookEntry[] = [];
  for (const page of pages) {
    if (!opts?.includeHidden && page.hidden) continue;
    const entry = getWorldbookEntry(db, page.id);
    if (entry) entries.push(entry);
  }
  return entries;
}

export function getSingletonEntry(db: Database.Database, worldbookBookId: string, entryType: "setting" | "register"): WorldbookEntry | null {
  return listWorldbookEntries(db, worldbookBookId).find((e) => e.entryType === entryType) ?? null;
}

export function getPcEntry(db: Database.Database, worldbookBookId: string): WorldbookEntry | null {
  return listWorldbookEntries(db, worldbookBookId).find((e) => e.isPc) ?? null;
}

/** Edit = new text version under the same page (createRetryText), same convention posts already use — gives worldbook version history for free. Name isn't versioned content, just a label, so it's updated in place. */
export function updateWorldbookEntry(
  db: Database.Database,
  pageId: string,
  input: { name?: string; fields?: Record<string, string> }
): WorldbookEntry {
  const existing = getWorldbookEntry(db, pageId);
  if (!existing) throw new Error(`Worldbook entry ${pageId} not found`);

  if (input.fields) {
    createRetryText(db, {
      pageId,
      priorTextId: existing.currentTextId,
      role: "system",
      genPackage: JSON.stringify(input.fields),
    });
  }
  if (typeof input.name === "string") {
    db.prepare(`UPDATE worldbook_entry SET name = ? WHERE page_id = ?`).run(input.name, pageId);
  }
  return getWorldbookEntry(db, pageId)!;
}

/** Doc says "delete" for worldbook entries, but nothing is ever hard-deleted elsewhere in this schema — same hide toggle as pages/tags, consistent with worldbook versioning (history stays recoverable). */
export function setWorldbookEntryHidden(db: Database.Database, pageId: string, hidden: boolean): void {
  setPageHidden(db, pageId, hidden);
}
