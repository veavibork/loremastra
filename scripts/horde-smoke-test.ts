import { listTextModels, submitTextGeneration, pollTextGeneration } from "../src/inference/horde.js";
import type { AgentProfile } from "../src/config.js";

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 3 * 60_000;

async function main() {
  console.log("--- available text models (count = workers currently online) ---");
  const models = await listTextModels();
  const withWorkers = models.filter((m) => m.count > 0).sort((a, b) => b.count - a.count);
  if (!withWorkers.length) {
    console.error("no models currently have any online workers — nothing to test against right now");
    process.exit(1);
  }
  for (const m of withWorkers.slice(0, 15)) {
    console.log(`${m.name} | workers=${m.count} queued=${m.queued} eta=${m.eta}s`);
  }

  const target = withWorkers[0];
  console.log(`\n--- submitting a test prompt against ${target.name} ---`);

  const profile: AgentProfile = {
    model: target.name,
    temperature: 0.8,
    responseLimit: 60,
    contextLimit: 2048,
  };
  const { id, kudos } = await submitTextGeneration(profile, [
    { role: "user", content: "Say hello in exactly one short sentence." },
  ]);
  console.log(`submitted, id=${id} kudos=${kudos}`);

  const startedAt = Date.now();
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const status = await pollTextGeneration(id);
    console.log(
      `poll: done=${status.done} faulted=${status.faulted} isPossible=${status.isPossible} ` +
        `queuePosition=${status.queuePosition} waitTime=${status.waitTime}s`
    );
    if (status.faulted) {
      console.error("generation faulted");
      process.exit(1);
    }
    if (status.done) {
      console.log(`\n--- result ---\n${status.text}`);
      return;
    }
  }
  console.error(`gave up waiting after ${POLL_TIMEOUT_MS / 1000}s`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
