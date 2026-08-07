import { SYSTEM_PROMPT } from "./_rules.js";

export default async function handler(req, res) {
  // CORS setup
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,OPTIONS,PATCH,DELETE,POST,PUT"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: "GEMINI_API_KEY environment variable is missing" });
  }

  try {
    const { messages, tone, goal, customizedPrompt } = req.body;

    // Build the user prompt context
    let promptText = `Generate appropriate reply suggestions for the following conversation.\n`;
    if (tone) promptText += `Tone: ${tone}\n`;
    if (goal) promptText += `Goal: ${goal}\n`;
    if (customizedPrompt) promptText += `Custom instructions: ${customizedPrompt}\n`;

    promptText += `\nConversation History:\n${JSON.stringify(messages || [], null, 2)}`;

    // Call Google Gemini API
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: SYSTEM_PROMPT || "You are a helpful assistant." }]
          },
          contents: [
            {
              role: "user",
              parts: [{ text: promptText }]
            }
          ]
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Gemini API Error:", data);
      return res.status(response.status).json({
        error: data.error?.message || "Failed to generate replies from Gemini API"
      });
    }

    const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

    return res.status(200).json({ reply: replyText });
  } catch (error) {
    console.error("Server Error:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
