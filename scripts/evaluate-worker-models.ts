import { listModels, suggestFiltersForRole, type FeatherlessModel } from "../src/inference/featherless-models.js";

const ROLE = "worker" as const;

const apiKey = process.env.FEATHERLESS_API_KEY;
if (!apiKey) {
  console.error("set FEATHERLESS_API_KEY to run this script");
  process.exit(1);
}

// ── model ID analysis ────────────────────────────────────────

/** Family patterns by org prefix or model name substring. */
const FAMILY_PATTERNS: [RegExp, string, number][] = [
  // ⭐4 worker families from tag ratings — strong instruction/tool-use reputation
  [/deepseek/i, "deepseek", 3],
  [/^Qwen\/Qwen3\.\d/i, "qwen3.x", 3],
  [/^Qwen\/Qwen3/i, "qwen3", 3],
  [/^Qwen\/Qwen2\.5-Coder/i, "qwen2.5-coder", 3],
  [/^Qwen\/Qwen2\.5/i, "qwen2.5", 3],
  [/^Qwen\/Qwen2/i, "qwen2", 3],
  [/^Qwen\/QwQ/i, "qwq", 2],
  // ⭐3 worker families — solid generalists
  [/llama.*instruct/i, "llama-instruct", 2],
  [/^meta-llama/i, "llama", 1],
  [/gemma.*(instruct|it)/i, "gemma-instruct", 2],
  [/gemma/i, "gemma", 1],
  [/mistral.*instruct/i, "mistral-instruct", 2],
  [/mistral/i, "mistral", 1],
  [/^microsoft\/phi/i, "phi", 1],
  [/^nvidia/i, "nemotron", 1],
  [/hermes/i, "hermes", 2], // Hermes is specifically tuned for function-calling
];

/** Patterns that signal creative/RP fine-tunes — unsuitable for tool-calling worker. */
const CREATIVE_PATTERNS: RegExp[] = [
  /magnum/i, /pantheon/i, /rp[-_]?max/i, /roleplay/i, /creative/i,
  /uncensored/i, /abliterat/i, /heretic/i, /nsfw/i, /erotic/i,
  /godslayer/i, /angelslayer/i, /patricide/i, /darkatom/i,
  /stardust/i, /chronos/i, /darkness/i, /abomination/i, /runeweaver/i,
  /personalityengine/i, /bigger-body/i,
];

/** Patterns that signal strong instruction/tool-use tuning. */
const INSTRUCTION_PATTERNS: RegExp[] = [
  /instruct/i, /chat/i, /coder/i,
  /^NousResearch\/Hermes/i, // Hermes is function-calling tuned
];

/** Patterns that signal experimental/throwaway fine-tunes (epoch experiments, random merges). */
const EXPERIMENTAL_PATTERNS: RegExp[] = [
  /_epoch_\d+/i, /_savedmath/i, /_sft_/i,
  /anmolagarwal/i, // epoch experiment author
];

/** Models specialized for math/reasoning — not general tool-calling. */
const MATH_SPECIFIC_PATTERNS: RegExp[] = [
  /-Math-/i, /-Math$/i,
];

/** Known untrustworthy orgs for tool-calling (fine-tune farms, creative collectives). */
const LOW_REPUTATION_ORGS: Record<string, true> = {
  "anthracite-org": true, "Gryphe": true, "redrix": true,
  "PocketDoc": true, "Khetterman": true,
  "Luni": true, "Delta-Vector": true, "SicariusSicariiStuff": true,
  "UsernameJustAnother": true, "rubenroy": true, "limloop": true,
  "Umranz": true, "allura-org": true, "elinas": true,
  "huihui-ai": true, // abliteration specialist
};

function analyzeModel(m: FeatherlessModel) {
  const id = m.id;
  const org = id.split("/")[0];

  // classify family
  let family = "other";
  let familyBonus = 0;
  for (const [pat, name, bonus] of FAMILY_PATTERNS) {
    if (pat.test(id)) {
      family = name;
      familyBonus = bonus;
      break;
    }
  }

  // detect parameter size from model name (e.g. "-7B", "-8B", "-12B")
  const name = id.split("/").slice(1).join("/");
  const paramMatch = name.match(/[-_](\d+\.?\d*)[-_ ]?[bB]/);
  const paramsB = paramMatch ? parseFloat(paramMatch[1]) : 0;

  // flags
  const isCreative = CREATIVE_PATTERNS.some((p) => p.test(id));
  const isInstruct = INSTRUCTION_PATTERNS.some((p) => p.test(id));
  const isExperimental = EXPERIMENTAL_PATTERNS.some((p) => p.test(id));
  const isMathSpecific = MATH_SPECIFIC_PATTERNS.some((p) => p.test(id));
  const isLowReputation = org in LOW_REPUTATION_ORGS;

  // score
  let score = 0;
  score += familyBonus;

  if (isInstruct) score += 2;
  if (isCreative) score -= 3;
  if (isExperimental) score -= 4; // throwaway — hard exclude
  if (isMathSpecific && !isInstruct) score -= 2; // math-only, not general-purpose
  if (isLowReputation && !isInstruct) score -= 1;

  // parameter size: prefer 7-9B (⭐4), accept 1-14B
  if (paramsB >= 7 && paramsB <= 9) score += 2;
  else if (paramsB >= 3 && paramsB <= 14 && paramsB > 0) score += 1;
  else if (paramsB > 14 && paramsB <= 34) score += 0;
  else if (paramsB > 34) score -= 2;

  // context bonus
  if (m.contextLength >= 131072) score += 2;
  else if (m.contextLength >= 65536) score += 1;

  // output token bonus
  if ((m.maxCompletionTokens ?? 0) >= 16384) score += 2;
  else if ((m.maxCompletionTokens ?? 0) >= 8192) score += 1;

  return { family, familyBonus, paramsB, isCreative, isInstruct, isExperimental, isMathSpecific, isLowReputation, score };
}

// ── acquisition ──────────────────────────────────────────────

interface Candidate extends FeatherlessModel {
  score: number;
  family: string;
  paramsB: number;
  isCreative: boolean;
  isInstruct: boolean;
}

async function main() {
  const baseFilters = suggestFiltersForRole(ROLE);
  baseFilters.perPage = 200;

  const allCandidates: Candidate[] = [];
  let page = 1;

  console.error("Fetching models (paginated)...");
  while (true) {
    const models = await listModels(apiKey!, { ...baseFilters, page });
    console.error(`  page ${page}: ${models.length} models`);
    if (models.length === 0) break;

    for (const m of models) {
      if (!m.toolUse) continue;
      if (m.isGated) continue;
      if (m.contextLength < 32768) continue;
      const cost = m.concurrencyCost ?? 99;
      if (cost !== 1 && cost !== 2) continue;

      const analysis = analyzeModel(m);
      allCandidates.push({ ...m, ...analysis });
    }

    if (models.length < (baseFilters.perPage ?? 200)) break;
    page++;
  }

  console.error(`\nTotal candidates after filtering: ${allCandidates.length}`);

  // ── rank ────────────────────────────────────────────────────
  allCandidates.sort((a, b) => b.score - a.score);

  const slot1 = allCandidates.filter((c) => c.concurrencyCost === 1);
  const slot2 = allCandidates.filter((c) => c.concurrencyCost === 2);

  function printTable(candidates: Candidate[], title: string) {
    console.log(`\n## ${title} (${candidates.length} candidates)`);
    console.log("| # | S | Model ID | Family | P | Ctx | Out |");
    console.log("|---|----|----------|--------|----|-----|-----|");
    const show = Math.min(candidates.length, 25);
    for (let i = 0; i < show; i++) {
      const c = candidates[i];
      const flags = [c.isInstruct ? "I" : "", c.isCreative ? "C" : ""].filter(Boolean).join("");
      console.log(
        `| ${i + 1} | ${c.score} | \`${c.id}\` | ${c.family} | ${c.paramsB}B | ${(c.contextLength / 1024).toFixed(0)}K | ${c.maxCompletionTokens ?? "?"} |${flags ? ` ${flags}` : ""}`
      );
    }
  }

  printTable(slot1, "1-slot candidates");
  printTable(slot2, "2-slot candidates");

  // ── baseline ────────────────────────────────────────────────
  const baselineId = "NousResearch/Hermes-3-Llama-3.1-8B";
  const baseline = allCandidates.find((c) => c.id === baselineId);
  if (baseline) {
    console.log(`\n## Baseline: Hermes-3-8B (score ${baseline.score})`);
    console.log(`  Rank (1-slot): #${slot1.indexOf(baseline) + 1} / ${slot1.length}`);
    const above = slot1.filter((c) => c.score > baseline.score);
    console.log(`  Models scoring above baseline: ${above.length}`);
    for (const c of above.slice(0, 15)) {
      console.log(`    - \`${c.id}\` (score ${c.score}, ${c.family} ${c.paramsB}B ${c.isInstruct ? "INSTRUCT" : ""})`);
    }
  } else {
    console.log(`\n⚠ Baseline ${baselineId} not found in results.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});