import { FEATHERLESS_BASE_URL, FEATHERLESS_USER_AGENT } from "../src/inference/featherless-config.js";

const k = process.env.FEATHERLESS_API_KEY!;
const H = { Authorization: `Bearer ${k}`, "Content-Type": "application/json", "User-Agent": FEATHERLESS_USER_AGENT };
const MODELS = ["Qwen/Qwen2.5-Coder-7B-Instruct", "NousResearch/Hermes-3-Llama-3.1-8B", "Qwen/Qwen2.5-Coder-32B-Instruct"];

async function check(m: string) {
  const s = performance.now();
  try {
    const r = await fetch(`${FEATHERLESS_BASE_URL}/chat/completions`, {
      method: "POST", headers: H,
      body: JSON.stringify({ model: m, messages: [{ role: "user", content: "Say hello." }], max_tokens: 20, temperature: 0, stream: false }),
    });
    const ms = Math.round(performance.now() - s);
    const d = await r.json() as { choices?: Array<{ message?: { content?: string } }> };
    console.log(`${m}: ${ms}ms HTTP${r.status} — "${d.choices?.[0]?.message?.content ?? ""}"`);
  } catch (e) {
    console.log(`${m}: FAIL ${String(e).slice(0, 150)}`);
  }
}

async function main() {
  for (const m of MODELS) { await check(m); await new Promise(r => setTimeout(r, 2000)); }
}

main().catch(e => { console.error(e); process.exit(1); });