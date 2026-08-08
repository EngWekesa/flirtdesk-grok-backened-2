import { OPERATOR_SYSTEM_PROMPT, checkDraft } from "./_rules.js";

const CEREBRAS_BASE = "https://api.cerebras.ai/v1";
const MAX_CHARS = 900;

// Optional hard override, e.g. CEREBRAS_MODEL="llama3.1-8b,qwen-3-32b".
// Leave it UNSET in Vercel to let auto-discovery do its job.
const CEREBRAS_OVERRIDE = (process.env.CEREBRAS_MODEL || "")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

// Preference order for auto-discovered models: cheap + fast first, so the free
// daily quota stretches as far as possible. Anything not listed still gets used,
// just after these. Matching is by substring, case-insensitive.
const PREFERENCE = [
  "llama3.1-8b",
  "llama-3.1-8b",
  "llama-4-scout",
  "qwen-3-32b",
  "llama-3.3-70b",
  "llama-4-maverick",
  "qwen-3-235b",
  "gpt-oss",
];

function rank(id) {
  const lower = id.toLowerCase();
  const i = PREFERENCE.findIndex((p) => lower.includes(p));
  return i === -1 ? PREFERENCE.length : i;
}

// ---- model discovery + memory of what actually works -----------------------
// Module scope survives between invocations on a warm Vercel lambda, so we pay
// for discovery roughly once per cold start instead of once per reply.
let cerebrasCache = { models: null, at: 0 };
const DISCOVERY_TTL_MS = 30 * 60 * 1000;
const blocked = new Map(); // model -> timestamp it was blocked (402/404)
const BLOCK_TTL_MS = 15 * 60 * 1000;

function isBlocked(model) {
  const at = blocked.get(model);
  if (!at) return false;
  if (Date.now() - at > BLOCK_TTL_MS) {
    blocked.delete(model);
    return false;
  }
  return true;
}

async function listCerebrasModels(key) {
  if (CEREBRAS_OVERRIDE.length) return CEREBRAS_OVERRIDE;
  if (cerebrasCache.models && Date.now() - cerebrasCache.at < DISCOVERY_TTL_MS) {
    return cerebrasCache.models;
  }
  const res = await fetch(`${CEREBRAS_BASE}/models`, {
    headers: { authorization: `Bearer ${key}` },
  });
  const raw = await res.text();
  if (!res.ok) {
    const err = new Error(`model discovery: HTTP ${res.status} ${raw.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  let data = {};
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("model discovery: non-JSON response");
  }
  const models = (data?.data || [])
    .map((m) => m?.id)
    .filter(Boolean)
    .sort((a, b) => rank(a) - rank(b));
  if (!models.length) throw new Error("model discovery: account exposes no models");
  cerebrasCache = { models, at: Date.now() };
  return models;
}

function buildUserPrompt({ turns, conversation }) {
  let text = "";
  if (Array.isArray(turns) && turns.length) {
    text = turns
      .map((t) => `${t.who === "me" ? "Me" : "Him"}: ${String(t.text || "").trim()}`)
      .join("\n");
  } else {
    text = String(conversation || "");
  }
  if (text.length > MAX_CHARS) text = text.slice(-MAX_CHARS);
  return `Conversation so far:\n${text}\n\nWrite only the next message from me (75-150 characters, exactly one question).`;
}

async function callOpenAICompatible({ url, key, model, messages }) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, temperature: 0.7, max_completion_tokens: 120 }),
  });
  const raw = await res.text();
  let data = {};
  try {
    data = JSON.parse(raw);
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    const detail = data?.error?.message || data?.message || raw.slice(0, 300);
    const err = new Error(`${model}: HTTP ${res.status} ${detail}`);
    err.status = res.status;
    throw err;
  }
  const content = data?.choices?.[0]?.message?.content;
  if (!content || !content.trim()) throw new Error(`${model}: empty completion`);
  return content.trim().replace(/^["'\s]+|["'\s]+$/g, "");
}

async function generate(messages) {
  const attempts = [];
  const cerebrasKey = (process.env.CEREBRAS_API_KEY || "").trim();

  // Cerebras is the only provider.
  if (cerebrasKey) {
    let models = [];
    try {
      models = await listCerebrasModels(cerebrasKey);
    } catch (e) {
      attempts.push(`cerebras ${e.message}`);
    }
    for (const model of models) {
      if (isBlocked(model)) continue;
      try {
        return {
          text: await callOpenAICompatible({
            url: `${CEREBRAS_BASE}/chat/completions`,
            key: cerebrasKey,
            model,
            messages,
          }),
          provider: `cerebras/${model}`,
        };
      } catch (e) {
        attempts.push(`cerebras ${e.message}`);
        // 404 = no access, 402 = billing, 403 = not entitled: stop retrying this
        // model for a while so later replies skip straight to a working one.
        if ([402, 403, 404].includes(e.status)) blocked.set(model, Date.now());
      }
    }
  } else {
    attempts.push("cerebras: CEREBRAS_API_KEY not set");
  }

  const err = new Error(`Cerebras failed -> ${attempts.join(" | ")}`);
  err.attempts = attempts;
  throw err;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Diagnostics: open /api/replies?diag=1 in a browser to see exactly which
  // Cerebras models your key can use right now.
  if (req.method === "GET") {
    const key = (process.env.CEREBRAS_API_KEY || "").trim();
    if (!key) return res.status(200).json({ cerebrasKey: false, models: [] });
    try {
      const models = await listCerebrasModels(key);
      return res.status(200).json({
        cerebrasKey: true,
        models,
        blocked: [...blocked.keys()],
      });
    } catch (e) {
      return res.status(200).json({ cerebrasKey: true, error: e.message });
    }
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const userPrompt = buildUserPrompt(body);

    const messages = [
      { role: "system", content: OPERATOR_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ];

    let { text, provider } = await generate(messages);
    let check = checkDraft(text);
    let regenerated = false;

    const hardFail = check.issues.some(
      (i) => !i.startsWith("too short") && !i.startsWith("too long"),
    );
    if (hardFail) {
      regenerated = true;
      const retry = await generate([
        ...messages,
        { role: "assistant", content: text },
        {
          role: "user",
          content: `That draft broke these rules: ${check.issues.join("; ")}. Rewrite it, fixing every issue. Output only the message.`,
        },
      ]);
      text = retry.text;
      provider = retry.provider;
      check = checkDraft(text);
    }

    return res.status(200).json({
      drafts: [text],
      warnings: check.issues,
      compliant: check.ok,
      characters: text.length,
      regenerated,
      provider,
    });
  } catch (error) {
    console.error("FlirtDesk error:", error);
    return res.status(502).json({ error: error.message || "Internal Server Error" });
  }
}
