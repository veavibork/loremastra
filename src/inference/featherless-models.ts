import { FEATHERLESS_USER_AGENT } from "./featherless-config.js";
import { getAlwaysTags, getTopTagsForRole, type AgentRole, type TagCategory } from "./featherless-tag-ratings.js";

const MODELS_URL = "https://api.featherless.ai/v1/models";
const TAG_CATEGORIES: TagCategory[] = [
  "capabilities",
  "families",
  "modalities",
  "parameter_bucket",
  "domains",
  "creative",
  "architectures",
  "training",
];

// Schema confirmed against the live endpoint 2026-07-01 — docs describe a
// flat `capabilities` array and don't mention `concurrency_cost` at all;
// actual response nests capability flags under `features` and does include
// a per-model `concurrency_cost`. See docs/featherless-notes.md.
export interface FeatherlessModel {
  id: string;
  isGated: boolean;
  created: number;
  modelClass: string;
  ownedBy: string;
  contextLength: number;
  maxCompletionTokens?: number;
  concurrencyCost?: number;
  toolUse: boolean;
  availableOnCurrentPlan?: boolean;
}

export interface ListModelsFilters {
  q?: string;
  /**
   * `capabilities=chat,tool-use` is a real server-side param (confirmed
   * 2026-07-01) and worth sending to shrink a potentially huge unfiltered
   * result set (~22k models), but it's approximate — ~5% of what it returns
   * doesn't actually have `features.tool_use: true`. This always gets
   * verified client-side too; treat that as the authoritative check.
   */
  requireToolUse?: boolean;
  /**
   * Raw category -> values filters. Multiple values within one category are
   * OR'd (confirmed 2026-07-01 for `capabilities` and `creative` — see
   * docs/featherless-tag-taxonomy.md; same syntax presumed, not individually
   * verified, for the rest). These come from self-reported HuggingFace
   * community tags (see docs/featherless-notes.md) — useful for narrowing a
   * *search*, not verifiable against an already-fetched model, since the
   * list response doesn't echo back which tags a model has.
   */
  tags?: Partial<Record<TagCategory, string[]>>;
  contextLengthMin?: number;
  contextLengthMax?: number;
  availableOnCurrentPlan?: boolean;
  perPage?: number;
  page?: number;
}

interface RawFeatherlessModel {
  id: string;
  is_gated: boolean;
  created: number;
  model_class: string;
  owned_by: string;
  context_length: number;
  max_completion_tokens?: number;
  concurrency_cost?: number;
  features?: { tool_use?: boolean };
  available_on_current_plan?: boolean;
}

function mapModel(raw: RawFeatherlessModel): FeatherlessModel {
  return {
    id: raw.id,
    isGated: raw.is_gated,
    created: raw.created,
    modelClass: raw.model_class,
    ownedBy: raw.owned_by,
    contextLength: raw.context_length,
    maxCompletionTokens: raw.max_completion_tokens,
    concurrencyCost: raw.concurrency_cost,
    toolUse: raw.features?.tool_use ?? false,
    availableOnCurrentPlan: raw.available_on_current_plan,
  };
}

function headers(apiKey: string): Record<string, string> {
  const base: Record<string, string> = { "User-Agent": FEATHERLESS_USER_AGENT };
  if (apiKey) base.Authorization = `Bearer ${apiKey}`;
  return base;
}

export async function listModels(apiKey: string, filters: ListModelsFilters = {}): Promise<FeatherlessModel[]> {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);

  const capabilities = new Set(filters.tags?.capabilities ?? []);
  if (filters.requireToolUse) {
    capabilities.add("chat");
    capabilities.add("tool-use");
  }
  if (capabilities.size) params.set("capabilities", [...capabilities].join(","));

  for (const category of TAG_CATEGORIES) {
    if (category === "capabilities") continue; // handled above, merged with requireToolUse
    const values = filters.tags?.[category];
    if (values?.length) params.set(category, values.join(","));
  }

  if (filters.contextLengthMin != null) params.set("context_length_min", String(filters.contextLengthMin));
  if (filters.contextLengthMax != null) params.set("context_length_max", String(filters.contextLengthMax));
  if (filters.availableOnCurrentPlan) params.set("available_on_current_plan", "true");
  params.set("per_page", String(filters.perPage ?? 100));
  if (filters.page) params.set("page", String(filters.page));

  const res = await fetch(`${MODELS_URL}?${params.toString()}`, { headers: headers(apiKey) });
  if (!res.ok) {
    throw new Error(`Featherless models request failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { data: RawFeatherlessModel[] };
  const models = data.data.map(mapModel);
  return filters.requireToolUse ? models.filter((m) => m.toolUse) : models;
}

/** Exact-ID lookup — the API only exposes fuzzy search (`q`), so this filters a search result down to the exact match. */
export async function getModel(apiKey: string, id: string): Promise<FeatherlessModel | null> {
  const results = await listModels(apiKey, { q: id, perPage: 100 });
  return results.find((m) => m.id === id) ?? null;
}

/**
 * Builds a starting search filter for discovering candidate models for a
 * given agent role: always requires the structurally-necessary modality
 * (`text`), and suggests — doesn't force — the top-rated creative/capability
 * tags for that role as an OR filter. Caller can extend or override any of
 * this before passing it to `listModels`; nothing here is a hard gate beyond
 * the `always`-rated tags (see docs/featherless-tag-ratings.json).
 */
export function suggestFiltersForRole(role: AgentRole): ListModelsFilters {
  const requiredModalities = getAlwaysTags("modalities");
  const suggestedCreative = getTopTagsForRole("creative", role, { minStars: 4 });
  const suggestedCapabilities = getTopTagsForRole("capabilities", role, { minStars: 4 });

  const tags: Partial<Record<TagCategory, string[]>> = {};
  if (requiredModalities.length) tags.modalities = requiredModalities;
  if (suggestedCreative.length) tags.creative = suggestedCreative;
  if (suggestedCapabilities.length) tags.capabilities = suggestedCapabilities;

  return { tags, availableOnCurrentPlan: true };
}
