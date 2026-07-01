import { getModel, listModels } from "../src/inference/featherless-models.js";
import { DEFAULT_AUTHOR_PROFILE, DEFAULT_WORKER_PROFILE } from "../src/config.js";

async function main() {
  console.log("--- current author model ---");
  console.log(await getModel(DEFAULT_AUTHOR_PROFILE.model));

  console.log("--- current worker model ---");
  console.log(await getModel(DEFAULT_WORKER_PROFILE.model));

  console.log("--- models supporting tool-use, context >= 8000, on current plan ---");
  const candidates = await listModels({
    requireToolUse: true,
    contextLengthMin: 8000,
    availableOnCurrentPlan: true,
    perPage: 200,
  });
  console.log(`found ${candidates.length}`);
  for (const m of candidates.slice(0, 30)) {
    console.log(
      `${m.id} | context=${m.contextLength} maxOut=${m.maxCompletionTokens ?? "?"} cost=${m.concurrencyCost ?? "?"} gated=${m.isGated}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
