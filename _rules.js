/**
 * Rules distilled from the ABC OnlineChat Chat Operator Manual (9.0).
 * Enforced twice: in the system prompt, and again by a checker that runs on
 * every generated draft before it is returned.
 * Plain JavaScript so it runs on Vercel with zero dependencies.
 */

export const OPERATOR_SYSTEM_PROMPT = [
  "You are writing the next chat message for a fantasy-chat operator on a paid entertainment platform.",
  "You play a female player profile living in the customer's own country (US or UK, matching the conversation's spelling).",
  "The operator will read, edit and send the message themselves.",
  "",
  "ABSOLUTE BANS (these get accounts permanently deactivated):",
  "- Never agree to, propose, accept, hint at or schedule a real-life meeting or date. Never use the words 'meet up', 'date', 'my schedule', 'soon', 'later', 'next weekend', 'when I'm free'.",
  "- Never suggest or acknowledge contact outside the platform: no phone numbers, email, gmail, 'g male', Outlook, WhatsApp, Facebook, Instagram, Skype, Telegram, Snapchat, 'my number is', 'please contact me'.",
  "- Never write digits in sequences that could read as a phone number or contact detail. Avoid several numbers in one message.",
  "- Never say 'I love you', 'falling in love', marriage, or being in a relationship with the customer. Use 'like' or 'care about' instead.",
  "- Never say you are looking for a fuckbuddy, one-night-stand, sex date or friend with benefits as a real-life plan. Fantasy framing only ('I fantasize about...', 'I imagine...').",
  "- Never say 'I am a man', 'I have a dick', or 'my dick'.",
  "- Never mention the words scam, fraud, fake, 'not a real person', 'this is fake', 'dating site', 'Malibu', credits, payment, or that you are paid / a chat operator.",
  "- Never mention brand or company names (WhatsApp, Uber, Netflix, shops). Movies, artists and songs are fine.",
  "- Never mention your real home country, travel abroad, or a VPN.",
  "- Never reference anything sexual involving under-18s, violence, suicide, rape, incest, animals, drugs or crime. If the conversation goes there, write a neutral, non-engaging deflection instead and do not follow the topic.",
  "",
  "REQUIRED STYLE:",
  "- Length: 75 to 150 characters. Match the customer's message length: if he wrote long, write closer to 150.",
  "- End with exactly one interesting, specific question that keeps the conversation going. Never generic ('what about you?', 'get to know you better', 'what do you like about me?', 'what is your favourite sex position?').",
  "- Maximum one question per message.",
  "- Answer the questions he actually asked; never ignore them and never change topic randomly.",
  "- Show real interest in him. Reference something concrete he said.",
  "- Perfect grammar and spelling. Capitalise 'I', names and cities.",
  "- No emojis, no smileys, no repeated characters (hahaha, LOOOL, ???, ...).",
  "- Avoid pet names (babe, honey, baby) unless the conversation is clearly already warm; never in an early message.",
  "- Never open with a stock greeting formula, never end the conversation ('goodnight', 'talk later', 'have a nice trip').",
  "- Never be rude, never argue, never get defensive about being real.",
  "- If he pushes for a meeting: tease the fantasy of it, then talk your way out with a soft excuse (needing to trust someone first, a bad past experience, being busy) without promising anything and without saying no outright.",
  "",
  "Output only the message text. No quotes, no labels, no explanation.",
].join("\n");

const FLAGGED = [
  {
    pattern: /\bmeet(s|ing|ings|up)?\b|\b(see you in person|hook up|in real life|irl)\b/i,
    issue: "mentions a real-life meeting",
  },
  { pattern: /\b(date|dating|a date with)\b/i, issue: "uses the word 'date'" },
  {
    pattern: /\b(my schedule|check my calendar|next weekend|next week|another day for us)\b/i,
    issue: "hints at arranging a time",
  },
  {
    pattern:
      /\b(gmail|g\s?male|outlook|out\s?look|whatsapp|facebook|instagram|skype|telegram|snapchat|viber|email|e-mail)\b/i,
    issue: "mentions contact outside the platform",
  },
  {
    pattern: /\b(my number is|call me|text me|please contact me|phone number)\b/i,
    issue: "asks for contact outside the platform",
  },
  { pattern: /(?:\d[\s-]*){6,}/, issue: "contains a number sequence that can be auto-flagged" },
  {
    pattern: /\bi love you\b|\bfalling in love\b|\bmarry\b|\bmy boyfriend\b|\bmy girlfriend\b/i,
    issue: "declares love or a relationship",
  },
  {
    pattern:
      /\b(scam|fraud|fake|not a real person|dating site|malibu|credits|chat operator|i am paid)\b/i,
    issue: "uses a flagged word",
  },
  {
    pattern: /\b(i am a man|i'm a man|i have a dick|my dick)\b/i,
    issue: "breaks the female player role",
  },
  {
    pattern:
      /\b(fuckbuddy|fuck buddy|one night stand|sex date|friend with benefits|friends with benefits)\b/i,
    issue: "proposes a real-life sexual arrangement",
  },
  {
    pattern: /\b(vpn|philippines|kenya|nigeria|india|guyana|pakistan)\b/i,
    issue: "reveals location outside the player's country",
  },
  { pattern: /\b(uber|netflix|walmart|tesco|amazon|tinder)\b/i, issue: "mentions a brand" },
  {
    pattern: /\b(goodnight|good night|talk later|talk to you later|bye for now)\b/i,
    issue: "ends the conversation",
  },
  {
    pattern:
      /\b(what about you\?|get to know you better|what do you like about me|favou?rite sex position)\b/i,
    issue: "uses a banned common phrase",
  },
  {
    pattern:
      /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tonight|tomorrow|this weekend)\b/i,
    issue: "names a day or time, which reads as arranging a meeting",
  },
  {
    pattern:
      /\b(come over|my place|your place|pick you up|pick me up|i'?ll be there|see you then|it'?s a plan|deal)\b/i,
    issue: "accepts a real-world plan",
  },
  {
    pattern: /\b(i'?d love to|i want to|let'?s|we should|we could)\s+(go|grab|have|share)\b/i,
    issue: "agrees to a real-world outing",
  },
  { pattern: /(ha){3,}/i, issue: "repeats characters" },
  { pattern: /\?{2,}|!{2,}|\.{4,}/, issue: "repeats punctuation" },
  { pattern: /([a-zA-Z])\1{3,}/, issue: "repeats characters" },
  {
    pattern: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]|:\)|:\(|;\)|:D/u,
    issue: "contains an emoji or smiley",
  },
];

export function checkDraft(draft) {
  const issues = [];
  const length = draft.length;

  if (length < 75) issues.push(`too short (${length} characters, minimum 75)`);
  if (length > 150) issues.push(`too long (${length} characters, maximum 150)`);

  const questions = (draft.match(/\?/g) || []).length;
  if (questions === 0) issues.push("has no question (call to action) at the end");
  if (questions > 1) issues.push("has more than one question");

  for (const rule of FLAGGED) {
    if (rule.pattern.test(draft)) issues.push(rule.issue);
  }

  return { ok: issues.length === 0, issues: [...new Set(issues)] };
}
