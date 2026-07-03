import { listModels, suggestFiltersForRole } from "../src/inference/featherless-models.js";

// Standalone dev script, not part of the app runtime — see check-worker-model.ts's comment.
const apiKey = process.env.FEATHERLESS_API_KEY;
if (!apiKey) {
  console.error("set FEATHERLESS_API_KEY to run this script");
  process.exit(1);
}

async function main() {
  for (const role of ["worker", "editor", "author"] as const) {
    const filters = suggestFiltersForRole(role);
    console.log(`--- ${role} ---`);
    console.log("filters:", JSON.stringify(filters));

    const results = await listModels(apiKey!, { ...filters, contextLengthMin: 8000, perPage: 10 });
    console.log(`found ${results.length} (showing up to 10):`);
    for (const m of results) {
      console.log(`  ${m.id} | context=${m.contextLength} cost=${m.concurrencyCost ?? "?"} toolUse=${m.toolUse}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
