import { OPERATOR_SYSTEM_PROMPT, checkDraft } from "./_rules.js";

// Groq's OpenAI-compatible endpoint. Free tier, keys start with "gsk_".
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";

// Token-saving limits: only the very recent on-screen exchange is used.
const MAX_TURNS = 6; // ~last 2-3 exchanges
const MAX_CHARS = 900; // hard cap on what we ever send to Groq
const MAX_OUTPUT_TOKENS = 90; // short, natural replies only

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function send(res, status, payload) {
  for (const [name, value] of Object.entries(CORS)) res.setHeader(name, value);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.status(status).send(JSON.stringify(payload));
}

// Lines that are chat-app UI noise, not real messages.
const NOISE = [
  /^\d{1,2}:\d{2}(\s?[apAP]\.?[mM]\.?)?$/, // 10:42, 9:57 PM
  /^(today|yesterday|now|online|offline|typing\.{0,3}|seen|delivered|read|sent)$/i,
  /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?.*\d{1,2}.*$/i, // date separators
  /^[\s\u200b\u2022·+\-–—•]+$/, // separators / bullets
  /^(you|me|he|she|they)$/i, // stray name chips
  /^(like|reply|forward|react|edit|delete|copy|translate|unsend)$/i,
  /^\d+\s*(new\s*)?messages?$/i,
  /^(voice message|photo|video|sticker|gif|attachment|audio)$/i,
];

function isNoise(line) {
  if (line.length < 2) return true;
  return NOISE.some((re) => re.test(line));
}

const tidy = (s) =>
  String(s || "")
    .replace(/\s+/g, " ")
    .trim();

// Strip an existing speaker prefix so we can normalise it.
function stripPrefix(line) {
  const m = line.match(
    /^(me|you|myself|him|her|them|he|she|they|other|partner)\s*[:\-–]\s*(.+)$/i,
  );
  if (!m) return { who: null, text: line };
  const tag = m[1].toLowerCase();
  const mine = ["me", "you", "myself"].includes(tag);
  return { who: mine ? "ME" : "THEM", text: m[2].trim() };
}

/** Trim a labelled turn list to the size/character budget and render it. */
function packTurns(turns) {
  let kept = turns.slice(-MAX_TURNS);
  const render = (arr) => arr.map((k) => `${k.who}: ${k.text}`).join("\n");
  let text = render(kept);
  while (text.length > MAX_CHARS && kept.length > 1) {
    kept = kept.slice(1);
    text = render(kept);
  }

  const newest = kept[kept.length - 1];
  const lastThem = [...kept].reverse().find((k) => k.who === "THEM");
  return {
    text: text.slice(-MAX_CHARS),
    last: lastThem ? lastThem.text : "",
    // True when I was the last one to write: nothing new to answer, so the
    // draft must be a natural follow-up instead of a reply.
    waitingOnThem: Boolean(newest && newest.who === "ME"),
    turnCount: kept.length,
  };
}

/**
 * Preferred path: the extension already knows who owns each bubble, so we use
 * its labels verbatim and never guess.
 */
function turnsFromPayload(raw) {
  if (!Array.isArray(raw)) return null;
  const cleaned = [];
  for (const item of raw) {
    const text = tidy(item?.text);
    if (!text || isNoise(text)) continue;
    const who = String(item?.who || "").toUpperCase() === "ME" ? "ME" : "THEM";
    const prev = cleaned[cleaned.length - 1];
    if (prev && prev.who === who) prev.text = `${prev.text} ${text}`.trim();
    else cleaned.push({ who, text });
  }
  if (!cleaned.length) return null;
  return packTurns(cleaned);
}

/**
 * Fallback for the old plain-text blob: keep only the last few real messages,
 * oldest-first. Labels are used when present; only if the blob is completely
 * unlabelled do we alternate backwards from the newest line.
 */
function recentTurns(raw) {
  const lines = String(raw)
    .split(/\r?\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !isNoise(l));

  if (!lines.length) return null;

  const kept = lines.slice(-MAX_TURNS).map(stripPrefix);
  const anyLabelled = kept.some((k) => k.who);

  if (!anyLabelled) {
    // Newest is THEM, then alternate going backwards.
    for (let i = kept.length - 1, flip = 0; i >= 0; i--, flip++) {
      kept[i].who = flip % 2 === 0 ? "THEM" : "ME";
    }
  } else {
    let lastKnown = "THEM";
    for (let i = kept.length - 1; i >= 0; i--) {
      if (kept[i].who) lastKnown = kept[i].who;
      else kept[i].who = lastKnown;
    }
  }

  const merged = [];
  for (const k of kept) {
    const prev = merged[merged.length - 1];
    if (prev && prev.who === k.who) prev.text = `${prev.text} ${k.text}`.trim();
    else merged.push({ who: k.who, text: tidy(k.text) });
  }
  return packTurns(merged);
}

async function askGroq(key, prompt, temperature = 0.6) {
  const response = await fetch(GROQ_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MODEL,
      // Lower temperature = stays on topic instead of inventing a new one.
      temperature,
      top_p: 0.9,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [
        { role: "system", content: OPERATOR_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
  });

  const body = await response.text();
  if (!response.ok) {
    const error = new Error(`Groq request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }

  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error("Groq returned a response that could not be read.");
  }

  return String(json?.choices?.[0]?.message?.content || "")
    .trim()
    .replace(/^\s*(ME|YOU|REPLY)\s*[:\-–]\s*/i, "")
    .replace(/^["'\u201c\u201d]+|["'\u201c\u201d]+$/g, "")
    .trim();
}

function buildPrompt({ text, last, waitingOnThem, extra }) {
  const task = waitingOnThem
    ? [
        "The newest message on screen is MINE, so they have not written back yet.",
        "Write my natural follow-up that revives the same topic we were already on.",
      ]
    : [
        `The message you must answer is THEM: "${last}"`,
        "Reply directly and specifically to that last message. Stay on their exact topic.",
      ];

  return [
    "You are drafting MY next message in a 1-on-1 chat.",
    "THEM = the customer. ME = me, the player profile.",
    "",
    "Last few on-screen messages (oldest first, labels are accurate):",
    text,
    "",
    ...task,
    "",
    "Rules:",
    "- Reuse their own words and concrete details so the message clearly follows on.",
    "- Do not change the subject, do not invent facts, events or plans they never mentioned.",
    "- If they asked a question, answer it first, then add exactly one specific question back.",
    "- Never treat a message labelled ME as something to answer; that was written by me.",
    "- 75 to 150 characters, one question maximum, no emojis.",
    extra || "",
    "",
    "Output only the message text. No labels, no quotes, no explanation.",
  ]
    .filter(Boolean)
    .join("\n");
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    for (const [name, value] of Object.entries(CORS)) res.setHeader(name, value);
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    return send(res, 405, { error: "Use POST." });
  }

  let payload = req.body;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      payload = null;
    }
  }

  const packed = turnsFromPayload(payload?.turns) || recentTurns(payload?.conversation || "");
  if (!packed || !packed.text || packed.text.length < 20) {
    return send(res, 400, {
      error: "Send { turns } (or { conversation }) with the visible chat on screen.",
    });
  }

  const key = process.env.GROQ_API_KEY;
  if (!key) {
    return send(res, 500, {
      error: "GROQ_API_KEY is not set on this deployment. Add it in Vercel and redeploy.",
    });
  }

  try {
    let draft = await askGroq(key, buildPrompt(packed));
    if (!draft) {
      return send(res, 502, { error: "The model returned an empty reply. Try again." });
    }

    let check = checkDraft(draft);
    let regenerated = false;

    // One corrective retry only, so a rule-breaking draft is not what we ship.
    if (!check.ok) {
      const retryPrompt = buildPrompt({
        ...packed,
        extra: [
          "Your previous attempt was rejected for these reasons:",
          ...check.issues.map((i) => `- ${i}`),
          "Rewrite it so none of those apply, keeping the same topic and meaning.",
        ].join("\n"),
      });
      const second = await askGroq(key, retryPrompt, 0.45);
      if (second) {
        const secondCheck = checkDraft(second);
        regenerated = true;
        if (secondCheck.issues.length <= check.issues.length) {
          draft = second;
          check = secondCheck;
        }
      }
    }

    return send(res, 200, {
      drafts: [draft],
      compliant: check.ok,
      warnings: check.issues,
      characters: draft.length,
      model: MODEL,
      regenerated,
      answering: packed.waitingOnThem ? "" : packed.last,
      waitingOnThem: packed.waitingOnThem,
      turnsUsed: packed.turnCount,
    });
  } catch (error) {
    const status = error?.status;
    if (status === 429) {
      return send(res, 429, {
        error: "Groq rate limited the free tier. Wait a few seconds and try again.",
      });
    }
    if (status === 401 || status === 403) {
      return send(res, status, {
        error:
          "Groq rejected the API key. Confirm GROQ_API_KEY starts with gsk_ and has no quotes or spaces, then redeploy.",
      });
    }
    if (status === 404 || status === 400) {
      return send(res, 502, {
        error:
          "Groq rejected the request, usually because the model name was retired. Set GROQ_MODEL in Vercel to a current model such as llama-3.1-8b-instant.",
      });
    }
    return send(res, 502, { error: "The AI request failed. Try again." });
  }
}
