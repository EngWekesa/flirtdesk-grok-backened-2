import { OPERATOR_SYSTEM_PROMPT, checkDraft } from "./_rules.js";

const CEREBRAS_BASE = "https://cerebras.ai";
const MAX_CHARS = 900;

const CEREBRAS_OVERRIDE = (process.env.CEREBRAS_MODEL || "")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

const PREFERENCE = [
  "llama3.1-8b",
  "llama-3.1-8b",
  "qwen-3-32b",
  "llama-3.3-70b",
  "qwen-3-235b",
];

function rank(id) {
  const lower = id.toLowerCase();
  const i = PREFERENCE.findIndex((p) => lower.includes(p));
  return i === -1 ? PREFERENCE.length : i;
}

let cerebrasCache = { models: null, at: 0 };
const DISCOVERY_TTL_MS = 30 * 60 * 1000;
const blocked = new Map(); 
const BLOCK_TTL_MS = 15 * 1000;

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
  try { data = JSON.parse(raw); } catch { throw new Error("model discovery: non-JSON response"); }
  const models = (data?.data || [])
    .map((m) => m?.id)
    .filter(Boolean)
    .sort((a, b) => rank(a) - rank(b));
  if (!models.length) throw new Error("model discovery: account exposes no models");
  cerebrasCache = { models, at: Date.now() };
  return models;
}

function buildUserPrompt(clientMessage) {
  let message = String(clientMessage || "").trim();
  if (!message) throw new Error("No client message was received");
  if (message.length > MAX_CHARS) message = message.slice(-MAX_CHARS);
  return [
    "Analyze the conversation history above and write a natural reply to this last client message:",
    "--- LAST CLIENT MESSAGE ---",
    message,
    "--- END LAST CLIENT MESSAGE ---",
    "",
    "STRICT RULES:",
    "1. Stay 100% focused on the existing topic. Do not introduce new events or unmentioned details.",
    "2. If the client message is brief/vague (e.g., 'hey', 'ok', 'cool'), generate a casual response using the chat history context. Do not invent a fake story.",
    "3. Length must be 75-150 characters.",
    "4. End with exactly one specific, interesting question flowing from the chat.",
    "5. Output only raw reply text. No quotes, labels, or notes.",
  ].join("\n");
}

async function callOpenAICompatible({ url, key, model, messages }) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ 
      model, 
      messages, 
      temperature: 0.0, // FORCED TO 0.0 TO STOP OFF-TOPIC DRIFT
      max_completion_tokens: 120 
    }),
  });
  const raw = await res.text();
  let data = {};
  try { data = JSON.parse(raw); } catch { /* ignore */ }
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

  if (cerebrasKey) {
    let models = [];
    try { models = await listCerebrasModels(cerebrasKey); } catch (e) { attempts.push(`cerebras ${e.message}`); }
    for (const model of models) {
      if (isBlocked(model)) continue;
      try {
        return {
          text: await callOpenAICompatible({
            url: `${CEREBRAS_BASE}/chat/completions`,
            key: cerebrasKey,
            model,
          }).then(fn => fn), // safety wrapper
          text: await callOpenAICompatible({ url: `${CEREBRAS_BASE}/chat/completions`, key: cerebrasKey, model, messages }),
          provider: `cerebras/${model}`,
        };
      } catch (e) {
        attempts.push(`cerebras ${e.message}`);
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

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const clientMessage = String(body.clientMessage || "").trim();
    const chatHistory = Array.isArray(body.history) ? body.history : []; // Read chat logs
    
    const userPrompt = buildUserPrompt(clientMessage);

    // Build payload containing the real conversation context
    const messages = [
      { role: "system", content: OPERATOR_SYSTEM_PROMPT },
      ...chatHistory, 
      { role: "user", content: userPrompt },
    ];

    let { text, provider } = await generate(messages);
    let check = checkDraft(text);
    let regenerated = false;

    const hardFail = check.issues.some((i) => !i.startsWith("too short") && !i.startsWith("too long"));
    if (hardFail) {
      regenerated = true;
      const retry = await generate([
        ...messages,
        { role: "assistant", content: text },
        {
          role: "user",
          content: `That draft broke these rules: ${check.issues.join("; ")}. Rewrite it while replying only to the exact client message above. Do not introduce a new topic or new facts. Output only the message.`,
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
      answering: clientMessage,
    });
  } catch (error) {
    console.error("Error:", error);
    return res.status(502).json({ error: error.message || "Internal Server Error" });
  }
}
