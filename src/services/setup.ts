import type Database from "better-sqlite3";
import { callWithTools, withModelFallback, type ChatMessage, type ToolCall, type ToolDefinition } from "../inference/featherless.js";
import { getAgentProfile } from "./agent-config.js";
import {
  createWorldbookEntry,
  listWorldbookEntries,
  updateWorldbookEntry,
  WORLDBOOK_FIELD_SCHEMAS,
  type WorldbookEntry,
  type WorldbookEntryType,
} from "../db/worldbook-store.js";
import { createTag, isValidTagName, listTags, setTagWorldbookPage } from "../db/tag-store.js";
import { reindexTagAcrossBook, autoLinkEntryToTags } from "./tag-index.js";

const ENTRY_TYPES: WorldbookEntryType[] = ["setting", "register", "location", "creature", "faction", "character"];

/**
 * The Editor's conversational voice — purely a design conversation, no tool-calling
 * mechanics. It doesn't need to know JSON schema keys at all anymore: a separate
 * extraction pass (runWorldbookExtraction, on the Worker's model) reads this reply
 * afterward and records whatever facts it establishes. See docs/stub-revisions.md's
 * "volley" note — this split exists because auto-tool-choice with multiple
 * simultaneous tool calls on one model was unreliable (garbled tool names observed
 * live), while forced single-call tool use has been 100% reliable all session
 * (compress/archive). Splitting conversation from extraction keeps DeepSeek's
 * established creative/content-boundary voice for the visible reply while routing
 * the one fragile mechanism — parsing structured facts out of prose — to the model
 * already proven reliable at exactly that.
 */
const EDITOR_SETUP_SYSTEM_PROMPT = `You are the Editor, running the setup conversation for a new roleplay story.

Your job is collaborative worldbuilding, not an interview. Follow the user's lead — if they hand you a genre and a character idea in one line, ask about what's still missing, not what they already gave you. Ask one or two focused questions per turn. If they don't know what they want, offer two or three concrete options shaped to what they've said so far.

You need, at minimum, before the story can begin: a Setting, a Register (content boundaries and tone), a PC (the user's character), and at least one other entry (an NPC or Location) for them to interact with. You don't need to track or record any of this yourself — just talk it through naturally. Everything you and the user establish gets picked up automatically after you reply.

Ask directly about content boundaries once the basic shape is clear: what's welcome, what's off the table, what tone should dominate. This is freeform adult roleplay — be specific enough that it actually configures the Author.

When the user says they're ready, or you judge there's enough to begin, tell them so plainly. Don't narrate scenes yourself — that's the Author's job once the story starts.`;

// Shows both the exact JSON key and the human label — models otherwise mirror the label's
// casing/wording back as the key (e.g. "Off the table" instead of "offTable"), which then
// fails to match anywhere the schema key is looked up. See normalizeFields for the backstop.
function describeSchemas(): string {
  return (Object.entries(WORLDBOOK_FIELD_SCHEMAS) as [WorldbookEntryType, { key: string; label: string }[]][])
    .map(([type, fields]) => `- ${type}: ${fields.map((f) => `${f.key} (${f.label})`).join(", ")}`)
    .join("\n");
}

/** The extraction pass's system prompt — reads a design conversation, records only what's new or changed. */
export const EXTRACTION_SYSTEM_PROMPT = `You read a roleplay setup conversation between a user and an Editor, and record any new or
changed worldbook facts established in it as structured entries. You don't converse — you only extract.

Entry types and their fields:
${describeSchemas()}

A described genre, world, or premise (even one line, e.g. "cyberpunk heist") establishes a setting entry
— always check for one. A stated content boundary or tone preference (what's welcome, what's off the
table, how graphic or how light) establishes a register entry — always check for one. These are as
important to record as named characters and are easy to miss since they're rarely announced explicitly.

The user's own character is a character entry with isPc set to true — not a tag, a field on the entry
itself.

Only record an entry for something the model wouldn't already know or that needs a specific decision for
this game — a generic "shopkeeper" doesn't need an entry, "the fence who's been laundering money through
the PC's family business for a decade" does.

You'll be asked to record one entry at a time, repeatedly, until you say there's nothing left. A single
exchange often establishes several things at once — a setting, a register, a PC, and a named character
can all show up in the same message. Before setting done to true, check whether you've recorded every
distinct fact from this exchange, not just the first or most obvious one. Set done to true (and leave
everything else out) only once nothing is left worth recording — don't invent entries or repeat ones
nothing new was said about just to have something to report.`;

export const RECORD_ENTRY_TOOL: ToolDefinition = {
  name: "record_worldbook_entry",
  description:
    "Record ONE new or changed worldbook entry (matched to an existing one by entryType + name, or isPc for the PC, and merged in; otherwise created). Set done to true instead if there's nothing (more) to record.",
  parameters: {
    type: "object",
    properties: {
      done: {
        type: "boolean",
        description: "True if there is nothing (more) to record this turn — omit entryType/name/fields when true.",
      },
      entryType: { type: "string", enum: ENTRY_TYPES, description: "Which schema this entry uses." },
      name: { type: "string", description: "Display name — a person's name, a place's name, or a short label like \"Setting\"." },
      isPc: {
        type: "boolean",
        description: "Only meaningful when entryType is 'character' — true if this is the player's character, not an NPC.",
      },
      fields: {
        type: "object",
        description:
          "Field values for this entry type. Keys must be the exact lowercase key listed for that type (the part before the parenthesized label), e.g. \"offTable\" not \"Off the table\".",
        additionalProperties: { type: "string" },
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Tag names to attach to this entry (letters only, no spaces or punctuation). Existing tags are reused; new ones are created.",
      },
    },
    required: ["done"],
  },
};

function findExistingEntry(
  db: Database.Database,
  worldbookBookId: string,
  entryType: WorldbookEntryType,
  isPc: boolean,
  name: string
): WorldbookEntry | null {
  const entries = listWorldbookEntries(db, worldbookBookId, { includeHidden: true });
  if (entryType === "setting") return entries.find((e) => e.entryType === "setting") ?? null;
  if (entryType === "register") return entries.find((e) => e.entryType === "register") ?? null;
  if (entryType === "character" && isPc) return entries.find((e) => e.isPc) ?? null;
  return entries.find((e) => e.entryType === entryType && e.name.toLowerCase() === name.toLowerCase()) ?? null;
}

function ensureTagsAttached(
  db: Database.Database,
  tagScopeBookId: string,
  tagNames: string[],
  worldbookPageId: string
): string[] {
  const warnings: string[] = [];
  const existing = listTags(db, tagScopeBookId);
  for (const raw of tagNames) {
    const name = raw.trim();
    if (!isValidTagName(name)) {
      warnings.push(`skipped invalid tag "${raw}" (letters only)`);
      continue;
    }
    const found = existing.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (!found) {
      try {
        const tag = createTag(db, { bookId: tagScopeBookId, name, worldbookPageId });
        reindexTagAcrossBook(db, tag.id);
        existing.push(tag);
      } catch (err) {
        warnings.push(`failed to create tag "${name}": ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }
    if (found.worldbookPageId !== worldbookPageId) {
      setTagWorldbookPage(db, found.id, worldbookPageId);
    }
  }
  return warnings;
}

/**
 * The tool description gives the model human-readable field labels ("Identity", "Off the
 * table"), and models reliably mirror that casing/wording back as JSON keys rather than the
 * schema's actual camelCase keys ("identity", "offTable") — confirmed empirically 2026-07-01:
 * every field from a real setup conversation came back capitalized. Without this, those values
 * would silently fail to match WORLDBOOK_FIELD_SCHEMAS lookups in both prompt assembly and the
 * Lore UI's edit form — present in the DB but invisible everywhere they're read. Matches
 * case-insensitively against both the real key and the label; anything that matches neither is
 * dropped and reported back to the model as a warning rather than silently discarded.
 */
function normalizeFields(entryType: WorldbookEntryType, rawFields: Record<string, unknown>): { fields: Record<string, string>; warnings: string[] } {
  const schema = WORLDBOOK_FIELD_SCHEMAS[entryType];
  const fields: Record<string, string> = {};
  const warnings: string[] = [];
  for (const [rawKey, rawValue] of Object.entries(rawFields)) {
    if (typeof rawValue !== "string" || !rawValue.trim()) continue;
    const match = schema.find((f) => f.key.toLowerCase() === rawKey.toLowerCase() || f.label.toLowerCase() === rawKey.toLowerCase());
    if (!match) {
      warnings.push(`unrecognized field "${rawKey}" for entryType "${entryType}" — ignored`);
      continue;
    }
    fields[match.key] = rawValue;
  }
  return { fields, warnings };
}

function executeUpsertWorldbookEntry(
  db: Database.Database,
  worldbookBookId: string,
  tagScopeBookId: string,
  rawArgs: Record<string, unknown>
): { ok: boolean; error?: string } {
  const entryType = rawArgs.entryType as WorldbookEntryType;
  const name = typeof rawArgs.name === "string" ? rawArgs.name.trim() : "";
  if (!ENTRY_TYPES.includes(entryType)) {
    return { ok: false, error: `invalid entryType "${String(rawArgs.entryType)}"` };
  }
  if (!name) return { ok: false, error: "name is required" };

  const rawFields = typeof rawArgs.fields === "object" && rawArgs.fields !== null ? (rawArgs.fields as Record<string, unknown>) : {};
  const { fields } = normalizeFields(entryType, rawFields);
  const isPc = entryType === "character" && rawArgs.isPc === true;
  const tags = Array.isArray(rawArgs.tags) ? rawArgs.tags.filter((t): t is string => typeof t === "string") : [];

  try {
    const existing = findExistingEntry(db, worldbookBookId, entryType, isPc, name);
    const entry = existing
      ? updateWorldbookEntry(db, existing.pageId, { fields: { ...existing.fields, ...fields } })
      : createWorldbookEntry(db, { bookId: worldbookBookId, entryType, isPc, name, fields });

    if (tags.length) ensureTagsAttached(db, tagScopeBookId, tags, entry.pageId);
    // Belt-and-suspenders: catches a tag that already shares this entry's name but wasn't
    // explicitly listed in this call's tags array (e.g. created earlier via the Lore UI).
    autoLinkEntryToTags(db, tagScopeBookId, entry);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const MAX_ENTRY_ITERATIONS = 4;
const EXTRACTION_MAX_ATTEMPTS_PER_STEP = 3;

/**
 * Reads the conversation (including the Editor's just-generated reply) and records any new or
 * changed worldbook facts. Loops a single *forced* call per entry (record_worldbook_entry, one
 * flat object, no array) rather than one call carrying an array of entries — testing showed the
 * array shape measurably less reliable ("model did not call the required tool" on roughly a
 * third of attempts) than the single-flat-object shape already proven 100% reliable for
 * compress/archive. Each step gets its own small retry budget; if a step exhausts its retries,
 * extraction just stops there rather than losing entries already recorded in earlier
 * iterations. A background-extraction hiccup should never invalidate the conversational reply
 * the user already has — this never throws.
 */
export async function runWorldbookExtraction(
  db: Database.Database,
  worldbookBookId: string,
  tagScopeBookId: string,
  conversation: ChatMessage[]
): Promise<void> {
  const messages: ChatMessage[] = [{ role: "system", content: EXTRACTION_SYSTEM_PROMPT }, ...conversation];

  for (let i = 0; i < MAX_ENTRY_ITERATIONS; i++) {
    let call: ToolCall | null = null;
    let content: string | null = null;
    for (let attempt = 1; attempt <= EXTRACTION_MAX_ATTEMPTS_PER_STEP && !call; attempt++) {
      try {
        const result = await withModelFallback(getAgentProfile("worker"), (profile) =>
          callWithTools(profile, messages, [RECORD_ENTRY_TOOL], { forceToolName: "record_worldbook_entry" })
        );
        if (result.toolCalls[0]) {
          call = result.toolCalls[0];
          content = result.content;
        }
      } catch {
        // swallowed — retried up to the attempt budget, then this step (and extraction) just stops
      }
    }
    if (!call) break;
    if (call.arguments.done === true) break;

    executeUpsertWorldbookEntry(db, worldbookBookId, tagScopeBookId, call.arguments);
    messages.push({ role: "assistant", content, toolCalls: [call] });
    messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify({ ok: true }) });
  }
}

export { EDITOR_SETUP_SYSTEM_PROMPT };
