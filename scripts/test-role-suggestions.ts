import { listModels, suggestFiltersForRole } from "../src/inference/featherless-models.js";

async function main() {
  for (const role of ["worker", "editor", "author"] as const) {
    const filters = suggestFiltersForRole(role);
    console.log(`--- ${role} ---`);
    console.log("filters:", JSON.stringify(filters));

    const results = await listModels({ ...filters, contextLengthMin: 8000, perPage: 10 });
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
