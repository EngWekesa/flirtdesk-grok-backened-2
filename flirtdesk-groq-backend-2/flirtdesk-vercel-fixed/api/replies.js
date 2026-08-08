export default async function handler(req, res) {
  // CORS Headers
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

  // Handle OPTIONS preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.CEREBRAS_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "CEREBRAS_API_KEY environment variable is missing on Vercel"
    });
  }

  try {
    const { messages, tone, goal, customizedPrompt } = req.body || {};

    let promptText = `Generate appropriate reply suggestions for the following conversation.\n`;
    if (tone) promptText += `Tone: ${tone}\n`;
    if (goal) promptText += `Goal: ${goal}\n`;
    if (customizedPrompt) promptText += `Custom instructions: ${customizedPrompt}\n`;

    promptText += `\nConversation History:\n${JSON.stringify(messages || [], null, 2)}`;

    // Call Cerebras Chat Completions API with standard llama3.1-8b
    const response = await fetch("https://api.cerebras.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey.trim()}`
      },
      body: JSON.stringify({
        model: "llama3.1-8b",
        messages: [
          {
            role: "system",
            content: "You are a helpful flirting and messaging assistant."
          },
          {
            role: "user",
            content: promptText
          }
        ],
        temperature: 0.7
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Cerebras Detailed Error:", JSON.stringify(data));
      const errorMessage =
        data.error?.message ||
        data.detail ||
        (typeof data.error === 'string' ? data.error : null) ||
        JSON.stringify(data);

      return res.status(response.status).json({
        error: `Cerebras Error (${response.status}): ${errorMessage}`
      });
    }

    const replyText =
      data.choices?.[0]?.message?.content || "No reply generated.";

    return res.status(200).json({ reply: replyText });
  } catch (error) {
    console.error("Server Error:", error);
    return res.status(500).json({ error: error.message || "Internal Server Error" });
  }
}
