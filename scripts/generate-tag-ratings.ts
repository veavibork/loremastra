import { writeFileSync } from "node:fs";

/**
 * Rates every Featherless filter tag value along two axes:
 *  - filter: "always" (structurally required), "never" (structurally
 *    disqualifying), or "neutral" (informational signal only).
 *  - worker/editor/author: 0-5 usefulness as a signal when picking a model
 *    for that role. Default 3 (no strong opinion) unless overridden below.
 *
 * Deliberately conservative with "always"/"never": these tags are
 * self-reported HuggingFace community tags with no validation (confirmed
 * against HF's own docs, see docs/featherless-notes.md), so soft
 * quality/content judgments stay "neutral" even when the rating swings hard
 * — only genuine structural incompatibilities (wrong modality, non-generative
 * architecture) get a hard filter verdict.
 */

type Filter = "always" | "never" | "neutral";
interface Rating {
  filter: Filter;
  worker: number;
  editor: number;
  author: number;
  note?: string;
}

const DEFAULT: Rating = { filter: "neutral", worker: 3, editor: 3, author: 3 };

function r(partial: Partial<Rating>): Rating {
  return { ...DEFAULT, ...partial };
}

// category -> value -> rating override
const OVERRIDES: Record<string, Record<string, Rating>> = {
  modalities: {
    text: r({ filter: "always", worker: 5, editor: 5, author: 5, note: "Required — everything else in this list is structurally unusable for chat completion." }),
    vision: r({ note: "Extra capability we never use, but doesn't disqualify a model that also does text." }),
    embedding: r({ filter: "never", worker: 0, editor: 0, author: 0, note: "Not a generative/chat model at all — different API shape entirely." }),
  },

  capabilities: {
    chat: r({ worker: 5, editor: 5, author: 5 }),
    chatbot: r({ worker: 4, editor: 4, author: 4 }),
    conversation: r({ worker: 4, editor: 4, author: 5 }),
    "conversational-ai": r({ worker: 4, editor: 4, author: 4 }),
    dialogue: r({ worker: 3, editor: 3, author: 5 }),
    instruct: r({ worker: 5, editor: 5, author: 5 }),
    instruction: r({ worker: 5, editor: 5, author: 5 }),
    "instruction-following": r({ worker: 5, editor: 5, author: 5 }),
    assistant: r({ worker: 4, editor: 4, author: 3 }),
    "virtual-assistant": r({ worker: 3, editor: 3, author: 2 }),
    "tool-use": r({ worker: 5, editor: 5, author: 2, note: "Critical for Worker/Editor forced tool-calling; not needed for baseline Author prose." }),
    function: r({ worker: 5, editor: 5, author: 2 }),
    "function-calling": r({ worker: 5, editor: 5, author: 2 }),
    json: r({ worker: 4, editor: 4, author: 2 }),
    "json mode": r({ worker: 4, editor: 4, author: 2 }),
    "structured-output": r({ worker: 4, editor: 4, author: 2 }),
    "multi-agent": r({ worker: 3, editor: 3, author: 2 }),
    agent: r({ worker: 3, editor: 4, author: 2 }),
    "llm agent": r({ worker: 3, editor: 4, author: 2 }),
    planning: r({ worker: 2, editor: 4, author: 3 }),
    reasoning: r({ worker: 2, editor: 4, author: 3 }),
    "chain-of-thought": r({ worker: 1, editor: 3, author: 3, note: "Adds latency for a task (compression) that doesn't need deep reasoning." }),
    cot: r({ worker: 1, editor: 3, author: 3 }),
    thinking: r({ worker: 1, editor: 3, author: 3 }),
    "critical-thinking": r({ worker: 2, editor: 4, author: 3 }),
    logic: r({ worker: 2, editor: 3, author: 3 }),
    rationality: r({ worker: 2, editor: 3, author: 3 }),
    cognitive: r({ worker: 2, editor: 3, author: 3 }),
    "problem-solving": r({ worker: 2, editor: 4, author: 3 }),
    "long context": r({ worker: 4, editor: 4, author: 4, note: "Generically useful — more room in prompt assembly." }),
    "multi-turn": r({ worker: 3, editor: 4, author: 5 }),
    "multi-task": r({ worker: 3, editor: 3, author: 3 }),
    "content-safety": r({ worker: 3, editor: 3, author: 1, note: "Signals heavy safety tuning — likely to refuse the content Author needs to generate." }),
    guardrails: r({ worker: 3, editor: 3, author: 1 }),
    moderation: r({ worker: 3, editor: 3, author: 1 }),
    "hallucination-detection": r({ worker: 4, editor: 3, author: 3, note: "Mildly positive for Worker's factual-summary job specifically." }),
    "red-teaming": r({ worker: 3, editor: 3, author: 2 }),
    retrieval: r({ worker: 2, editor: 2, author: 3, note: "loremaster.md deliberately rejected vector/RAG retrieval — this doesn't help us." }),
    rag: r({ worker: 2, editor: 2, author: 3 }),
    "image-generation": r({ filter: "never", worker: 0, editor: 0, author: 0, note: "Not a text-chat capability — out of scope entirely." }),
    "video-generation": r({ filter: "never", worker: 0, editor: 0, author: 0 }),
    vision: r({}),
    "vision-language": r({}),
    "vision-language-model": r({}),
    multimodal: r({}),
    "small-language-model": r({ worker: 4, editor: 3, author: 2, note: "Efficient for Worker's small task; less creative depth for Author." }),
    lightweight: r({ worker: 4, editor: 3, author: 2 }),
    efficient: r({ worker: 4, editor: 3, author: 2 }),
    "general-purpose": r({ worker: 4, editor: 4, author: 4 }),
    personality: r({ worker: 2, editor: 2, author: 4, note: "Relevant to character voice/consistency." }),
    "reward-model": r({ worker: 2, editor: 2, author: 1, note: "Reward/scoring models are typically classifiers, not general chat generators." }),
    mteb: r({ worker: 2, editor: 2, author: 1, note: "MTEB is an embedding-benchmark tag — signals an embedding-oriented model." }),
    // Programming-language / dev-tooling capability tags: irrelevant to RP quality either way.
    ...Object.fromEntries(
      [
        "code", "code-agent", "code-analysis", "code-generation", "code-instruct", "code-reasoning",
        "competitive-programming", "sql", "text-to-sql", "python", "javascript", "typescript", "html",
        "css", "angular", "react", "nextjs", "nodejs", "tailwind-css", "swift", "solidity", "terraform",
        "verilog", "lean4", "xml", "yaml", "web-design", "web-generation", "ui-generation",
      ].map((k) => [k, r({ worker: 3, editor: 3, author: 2, note: "Programming/dev-tooling specialization — no bearing on RP quality; slight author penalty since heavy code focus sometimes trades off prose fluency." })])
    ),
  },

  parameter_bucket: {
    "< 1B": r({ worker: 4, editor: 2, author: 1, note: "Too small for reliable creative prose; fine for trivial Worker tasks." }),
    "1B": r({ worker: 4, editor: 2, author: 1 }),
    "2-3B": r({ worker: 4, editor: 2, author: 2 }),
    "4-5B": r({ worker: 4, editor: 3, author: 2 }),
    "7-9B": r({ worker: 4, editor: 4, author: 3 }),
    "10-15B": r({ worker: 3, editor: 4, author: 3 }),
    "16-27B": r({ worker: 3, editor: 4, author: 4 }),
    "28-40B": r({ worker: 2, editor: 4, author: 4 }),
    "65-72B": r({ worker: 2, editor: 4, author: 5 }),
    "100-141B": r({ worker: 1, editor: 3, author: 5 }),
    "200-250B": r({ worker: 1, editor: 3, author: 5 }),
    "300-500B": r({ worker: 1, editor: 2, author: 5, note: "Great quality likely, but cost/latency make this wasteful for background Worker/Editor tasks." }),
    "600-750B": r({ worker: 1, editor: 2, author: 5 }),
    "1T": r({ worker: 1, editor: 2, author: 5 }),
  },

  domains: {
    ...Object.fromEntries(
      [
        "ai-safety", "safety", "safety-research", "trustworthy-ai", "trustworthy-machine-learning",
        "ai-alignment", "ai-alignment-research", "ai-behavior-research", "bias-neutralization",
        "sandbagging-detection", "machine-unlearning", "unlearn", "llm-unlearning", "data-privacy", "privacy",
      ].map((k) => [k, r({ author: 1, note: "Signals safety/alignment-focused tuning or research use — correlates with refusal behavior, bad fit for Author." })])
    ),
    christian: r({ author: 2, note: "Religious-content-focused tuning may correlate with moralizing/restrictive output." }),
    bible: r({ author: 2 }),
    theology: r({ author: 2 }),
    gaming: r({ author: 4, note: "Gaming-adjacent creative content — mild positive for Author." }),
    roblox: r({ author: 4 }),
    art: r({ author: 4 }),
    music: r({ author: 4 }),
    design: r({ author: 4 }),
  },

  creative: {
    roleplay: r({ worker: 2, editor: 2, author: 5 }),
    rp: r({ worker: 2, editor: 2, author: 5 }),
    "creative-writing": r({ worker: 2, editor: 3, author: 5 }),
    creative: r({ worker: 2, editor: 3, author: 5 }),
    storytelling: r({ worker: 2, editor: 3, author: 5 }),
    writing: r({ worker: 2, editor: 3, author: 4 }),
    fiction: r({ worker: 2, editor: 3, author: 4 }),
    story: r({ worker: 2, editor: 3, author: 4 }),
    "story generation": r({ worker: 2, editor: 3, author: 5 }),
    "scene continue": r({ worker: 2, editor: 2, author: 5, note: "Directly matches Author's core continue-the-scene function." }),
    "plot generation": r({ worker: 2, editor: 3, author: 4 }),
    "sub-plot generation": r({ worker: 2, editor: 3, author: 4 }),
    "science fiction": r({ worker: 2, editor: 2, author: 4 }),
    romance: r({ worker: 2, editor: 2, author: 4 }),
    horror: r({ worker: 2, editor: 2, author: 4 }),
    "all genres": r({ worker: 2, editor: 2, author: 4 }),
    "vivid prose": r({ worker: 2, editor: 2, author: 5, note: "Exactly the register loremaster.md wants from Author." }),
    prose: r({ worker: 2, editor: 2, author: 5 }),
    erp: r({ worker: 2, editor: 2, author: 5, note: "Directly matches Loremaster's core stated use case." }),
    npc: r({ worker: 2, editor: 2, author: 5 }),
    character: r({ worker: 2, editor: 2, author: 5 }),
    companion: r({ worker: 2, editor: 2, author: 4 }),
    "ai-companion": r({ worker: 2, editor: 2, author: 4 }),
    persona: r({ worker: 2, editor: 2, author: 4 }),
    friend: r({ worker: 2, editor: 2, author: 3 }),
    waifu: r({ worker: 2, editor: 2, author: 4, note: "Signals romantic/companion-RP tuning, adjacent to ERP use case." }),
    "visual novel": r({ worker: 2, editor: 2, author: 4 }),
    "text adventure": r({ worker: 2, editor: 3, author: 4 }),
    adventure: r({ worker: 2, editor: 2, author: 4 }),
    humor: r({ worker: 2, editor: 2, author: 3 }),
    parody: r({ worker: 2, editor: 2, author: 3 }),
    satire: r({ worker: 2, editor: 2, author: 3 }),
    lyrics: r({ worker: 2, editor: 2, author: 2, note: "Song-writing focus — weak relevance to prose RP." }),
    "synthetic data": r({ worker: 2, editor: 2, author: 2, note: "Training-data-generation focus, not necessarily interactive RP quality." }),
  },

  training: {
    abliterated: r({ worker: 2, editor: 2, author: 5, note: "Serves Author's permissiveness need directly, but our own testing showed abliteration can degrade tool-calling reliability — caution for Worker/Editor." }),
    uncensored: r({ worker: 2, editor: 2, author: 5, note: "Same reasoning as abliterated." }),
    "safe-rlhf": r({ author: 1, note: "Explicitly safety-focused RLHF — correlates with refusals." }),
    ...Object.fromEntries(
      ["merge", "mergekit", "slerp", "ties", "dare", "della", "lazymergekit", "automerger", "model_stock"].map((k) => [
        k,
        r({ note: "Community merges are a mixed bag — no consistent quality signal either way." }),
      ])
    ),
    distill: r({ author: 2, note: "Distilled models sometimes lose creative nuance relative to their teacher." }),
    distillation: r({ author: 2 }),
    "instruction-tuning": r({ worker: 4, editor: 4, author: 4, note: "Baseline positive — confirms the model follows instructions at all." }),
    helpsteer2: r({ author: 2, note: "General-helpfulness tuning, not creative-writing focused — likely more corporate/assistant tone." }),
    "open-r1": r({ worker: 2, editor: 3, author: 2, note: "Reasoning-replication project, likely math/code focused." }),
  },

  families: {
    mistral: r({ author: 4, note: "Strong community reputation for creative-writing/roleplay fine-tunes." }),
    llama3: r({ editor: 4, author: 4, note: "Widely used as a roleplay/creative fine-tuning base; large ecosystem." }),
    llama31: r({ editor: 4, author: 4 }),
    llama32: r({ editor: 4, author: 4 }),
    llama33: r({ editor: 4, author: 4 }),
    qwen: r({ worker: 4, editor: 4, author: 3, note: "Strong instruction-following/tool-use reputation; prose sometimes noted as more clinical than Llama/Mistral RP finetunes." }),
    qwen2: r({ worker: 4, editor: 4, author: 3 }),
    qwen25: r({ worker: 4, editor: 4, author: 3 }),
    qwen3: r({ worker: 4, editor: 4, author: 3 }),
    deepseek3: r({ worker: 4, editor: 4, author: 4, note: "Current Author model family — strong general + creative capability, large context." }),
    deepseek31: r({ worker: 4, editor: 4, author: 4 }),
    deepseek32: r({ worker: 4, editor: 4, author: 4 }),
    deepseek4: r({ worker: 4, editor: 4, author: 4 }),
    phi: r({ author: 2, note: "Optimized for small-size benchmark performance/reasoning, not renowned for creative prose." }),
    phi2: r({ author: 2 }),
    phi3: r({ author: 2 }),
    phi4: r({ author: 2 }),
    rwkv: r({ worker: 2, editor: 2, author: 2, note: "Recurrent (non-transformer) architecture — historically rougher instruction-following/coherence at comparable scale." }),
    rwkv6: r({ worker: 2, editor: 2, author: 2 }),
    bert: r({ filter: "never", worker: 0, editor: 0, author: 0, note: "Encoder-only — not a generative/chat model at all." }),
    "nomic-bert": r({ filter: "never", worker: 0, editor: 0, author: 0 }),
    "xlm-roberta": r({ filter: "never", worker: 0, editor: 0, author: 0 }),
    gpt2: r({ worker: 2, editor: 2, author: 1, note: "Very old/small architecture generation — unlikely competitive for modern RP prose." }),
    gpt2sw3: r({ worker: 2, editor: 2, author: 1 }),
    gptsw3: r({ worker: 2, editor: 2, author: 1 }),
  },

  architectures: {
    mistral: r({ author: 4 }),
    "mistral nemo": r({ author: 4 }),
    "mistral-small": r({ author: 4 }),
    hermes: r({ worker: 4, editor: 4, author: 3, note: "NousResearch Hermes line is specifically tuned for function-calling reliability — this is literally the model family we switched Worker to after empirical testing." }),
    "openhermes-2.5": r({ worker: 4, editor: 4, author: 3 }),
    bert: r({ filter: "never", worker: 0, editor: 0, author: 0 }),
    gpt2: r({ worker: 2, editor: 2, author: 1 }),
  },
};

const TAG_VALUES: Record<string, string[]> = {
  modalities: ["text", "vision", "embedding"],
  parameter_bucket: [
    "< 1B", "1B", "2-3B", "4-5B", "7-9B", "10-15B", "16-27B", "28-40B",
    "65-72B", "100-141B", "200-250B", "300-500B", "600-750B", "1T",
  ],
  capabilities: [
    "agent", "analysis", "analytical", "angular", "assistant", "bash", "bilingual", "chain-of-thought",
    "chat", "chatbot", "chatml", "classification", "code", "code-agent", "code-analysis",
    "code-generation", "code-instruct", "code-reasoning", "cognitive", "competitive-programming",
    "content-safety", "conversation", "conversational-ai", "cot", "critical-thinking", "css",
    "deep-research", "dialogue", "efficient", "evaluation", "expert", "function", "function-calling",
    "general-purpose", "guardrails", "hallucination-detection", "html", "human-ai-collaboration",
    "image-generation", "information-extraction", "instruct", "instruction", "instruction-following",
    "javascript", "json", "json mode", "lean4", "lightweight", "llm", "llm agent", "logic",
    "long context", "math", "math-reasoning", "moderation", "moe", "mteb", "multi-agent", "multi-task",
    "multi-turn", "multimodal", "ner", "nextjs", "nodejs", "personality", "planning", "problem-solving",
    "python", "qa", "rag", "rationality", "react", "reasoning", "red-teaming", "research", "retrieval",
    "reward-model", "scientific-reasoning", "sentiment-analysis", "small-language-model", "solidity",
    "sql", "structured-output", "swift", "tailwind-css", "terraform", "text-to-sql", "thinking",
    "tool-use", "typescript", "ui-generation", "verilog", "video-generation", "virtual-assistant",
    "vision", "vision-language", "vision-language-model", "web-design", "web-generation", "xml", "yaml",
  ],
  families: [
    "afmoe", "apertus", "bamba", "bert", "deepseek3", "deepseek31", "deepseek32", "deepseek4", "ernie4-5",
    "ernie4-5-moe", "exaone4", "falcon", "gemma", "gemma2", "gemma3", "gemma4", "glm4", "glm46", "glm47",
    "glm5", "glm51", "glm52", "gpt-bigcode", "gpt-oss", "gpt2", "gpt2sw3", "gptsw3", "granite",
    "granitemoe", "hyperclovax-vlm", "internlm3", "kimi-linear", "kimik2", "kimik25", "lfm2", "lfm2-moe",
    "llama2", "llama3", "llama31", "llama32", "llama33", "mamba", "mellum", "mimo", "mimo2", "mimo25",
    "minimax-m2", "minimax-m3", "minimaxm2", "minimaxm21", "minimaxm25", "mistral", "mistral3",
    "mistral31", "nanbeige", "nemotron-h", "nemotron-nas", "nemotron3", "nomic-bert", "olmo", "olmo3",
    "ouro", "panguembedded", "phi", "phi2", "phi3", "phi4", "phimoe", "qwen", "qwen15", "qwen2", "qwen25",
    "qwen3", "qwen3-5", "qwen3-5-moe", "qwen3-moe", "qwen35", "qwen3next", "qwerky", "rwkv", "rwkv6",
    "stablelm", "step35", "step3p7", "talkie", "xlm-roberta", "yi1.5",
  ],
  domains: [
    "medical", "safety", "nlp", "finance", "biology", "legal", "chemistry", "cybersecurity", "healthcare",
    "security", "education", "science", "clinical", "experimental", "physics", "low-resource", "climate",
    "safety-research", "philosophy", "sandbagging-detection", "ai-safety", "biomedical", "mental-health",
    "devops", "stem", "art", "clinical-reasoning", "software-engineering", "enterprise", "compliance",
    "ai-research", "engineering", "machine-unlearning", "economics", "radiology", "privacy",
    "materials science", "psychology", "dermatology", "unlearn", "llm-unlearning", "data-privacy",
    "trustworthy-ai", "trustworthy-machine-learning", "bible", "theology", "bias-neutralization",
    "ai-alignment-research", "ai-alignment", "ai-behavior-research", "biological materials",
    "scientific ai", "christian", "software", "pathology", "ophthalmology", "chest-x-ray", "cloud",
    "african-languages", "web3", "music", "pharmaceutical", "business", "roblox", "ai4science",
    "computer-science", "medical-ai", "blockchain", "ethics", "therapeutics", "drug-development",
    "cardiology", "scripting", "aws", "e-commerce", "politics", "bioinformatics",
    "vulnerability-detection", "bioinspiration", "astronomy", "docker", "jenkins", "powershell", "azure",
    "gcp", "ecology", "design", "materials informatics", "environment", "gaming",
  ],
  creative: [
    "roleplay", "creative-writing", "creative", "storytelling", "writing", "rp", "fiction", "story",
    "plot generation", "sub-plot generation", "story generation", "scene continue", "science fiction",
    "all genres", "vivid prose", "romance", "synthetic data", "horror", "erp", "humor", "persona",
    "text adventure", "npc", "friend", "character", "companion", "prose", "adventure", "waifu",
    "visual novel", "ai-companion", "lyrics", "parody", "satire",
  ],
  architectures: [
    "llama", "qwen2", "qwen3", "mistral", "gemma2", "qwen", "gemma", "gemma3", "qwen3_5", "llama-3",
    "gemma3_text", "llama-2", "phi3", "qwen2.5", "phi", "glm4", "llama3", "qwen-coder", "llama-3.1",
    "gpt4", "codeqwen", "mistral3", "gpt", "mistral-common", "nemo", "llama2", "alpaca", "deepseek",
    "gemma-3", "llama3.1", "gpt2", "tinyllama", "llama-3.2", "falcon", "orca", "llama3.3", "r1",
    "llama3.2", "solar", "codellama", "phi-3", "qwen3_moe", "hermes", "vicuna", "llama-3.3", "sailor",
    "qwen-3", "mixtral", "mistral-small", "llama-3-ko", "mistral-7b", "openhermes-2.5", "qwq",
    "llama-3-instruct", "phi-2", "mistral nemo", "openchat", "deepseek_v3", "glm4_moe_lite",
    "rwkv6qwen2", "chatglm", "dolphin", "gemma-2b", "exaone", "mpt", "exaone-3.5",
  ],
  training: [
    "abliterated", "alignment", "alignment-handbook", "automerger", "autotrain", "axolotl", "c-rlft",
    "continued-pretraining", "cpo", "cpt", "dapo", "dare", "della", "distilabel", "distill",
    "distillation", "dpo", "drdpo", "finetune", "genrl-swarm", "gensyn", "gkd", "grpo", "h2o-llmstudio",
    "helpsteer2", "human feedback", "instruction-tuning", "kto", "lazymergekit", "llama-factory", "lora",
    "merge", "mergekit", "model_stock", "open-r1", "orpo", "peft", "post-training", "ppo", "preferences",
    "pretrained", "qlora", "rl", "rl-swarm", "rlaif", "rlhf", "rlvr", "safe-rlhf", "sft", "simpo", "slerp",
    "slimorca", "supervised-fine-tuning", "ties", "trl", "ultrafeedback", "uncensored", "unsloth",
  ],
};

const output: Record<string, Record<string, Rating>> = {};
for (const [category, values] of Object.entries(TAG_VALUES)) {
  output[category] = {};
  for (const value of values) {
    output[category][value] = OVERRIDES[category]?.[value] ?? DEFAULT;
  }
}

writeFileSync("src/data/featherless-tag-ratings.json", JSON.stringify(output, null, 2) + "\n");

let overrideCount = 0;
let totalCount = 0;
for (const values of Object.values(output)) {
  for (const rating of Object.values(values)) {
    totalCount += 1;
    if (rating !== DEFAULT && JSON.stringify(rating) !== JSON.stringify(DEFAULT)) overrideCount += 1;
  }
}
console.log(`Wrote src/data/featherless-tag-ratings.json — ${totalCount} tags, ${overrideCount} with non-default ratings.`);
