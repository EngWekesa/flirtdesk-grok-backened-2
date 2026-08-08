export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,OPTIONS,PATCH,DELETE,POST,PUT"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
  );

  // Handle preflight CORS request
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res
      .status(500)
      .json({ error: "GEMINI_API_KEY environment variable is missing on Vercel" });
  }

  try {
    const { messages, tone, goal, customizedPrompt } = req.body || {};

    // Construct prompt structure
    let promptText = `Generate appropriate reply suggestions for the following conversation.\n`;
    if (tone) promptText += `Tone: ${tone}\n`;
    if (goal) promptText += `Goal: ${goal}\n`;
    if (customizedPrompt) promptText += `Custom instructions: ${customizedPrompt}\n`;

    promptText += `\nConversation History:\n${JSON.stringify(messages || [], null, 2)}`;

    // Call Google Gemini API using stable flash endpoint
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: "You are a helpful flirting and messaging assistant." }]
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
        error: data.error?.message || "Failed to generate reply from Gemini API"
      });
    }

    const replyText =
      data.candidates?.[0]?.content?.parts?.[0]?.text || "No reply generated.";

    return res.status(200).json({ reply: replyText });
  } catch (error) {
    console.error("Server Error:", error);
    return res.status(500).json({ error: error.message || "Internal Server Error" });
  }
}
