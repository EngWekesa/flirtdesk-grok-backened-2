import { OPERATOR_SYSTEM_PROMPT, checkDraft } from "./_rules.js";

// Cerebras models to try in order. First one that answers wins.
const CEREBRAS_MODELS = (process.env.CEREBRAS_MODEL || "llama3.1-8b,llama-3.3-70b,gpt-oss-120b")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const MAX_CHARS = 900;

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
  const groqKey = (process.env.GROQ_API_KEY || "").trim();

  if (cerebrasKey) {
    for (const model of CEREBRAS_MODELS) {
      try {
        return {
          text: await callOpenAICompatible({
            url: "https://api.cerebras.ai/v1/chat/completions",
            key: cerebrasKey,
            model,
            messages,
          }),
          provider: `cerebras/${model}`,
        };
      } catch (e) {
        attempts.push(`cerebras ${e.message}`);
      }
    }
  } else {
    attempts.push("cerebras: CEREBRAS_API_KEY not set");
  }

  if (groqKey) {
    try {
      return {
        text: await callOpenAICompatible({
          url: "https://api.groq.com/openai/v1/chat/completions",
          key: groqKey,
          model: GROQ_MODEL,
          messages,
        }),
        provider: `groq/${GROQ_MODEL}`,
      };
    } catch (e) {
      attempts.push(`groq ${e.message}`);
    }
  }

  const err = new Error(`All providers failed -> ${attempts.join(" | ")}`);
  err.attempts = attempts;
  throw err;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") return res.status(200).end();
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

    // Only retry when a hard rule broke, not for a few characters of length drift.
    const hardFail = check.issues.some((i) => !i.startsWith("too short") && !i.startsWith("too long"));
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
