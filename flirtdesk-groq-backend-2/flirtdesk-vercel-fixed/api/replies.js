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

  // Handle preflight OPTIONS request
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
    const cleanApiKey = apiKey.trim();

    // Dynamically fetch currently available active models from Cerebras
    let targetModel = "llama3.1-8b";
    try {
      const modelsResponse = await fetch("https://api.cerebras.ai/v1/models", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${cleanApiKey}`
        }
      });

      if (modelsResponse.ok) {
        const modelsData = await modelsResponse.json();
        if (modelsData.data && modelsData.data.length > 0) {
          // Use the first active model available on your account
          targetModel = modelsData.data[0].id;
        }
      }
    } catch (e) {
      console.warn("Could not dynamically fetch models, using default:", e.message);
    }

    const { messages, tone, goal, customizedPrompt } = req.body || {};

    let promptText = `Generate appropriate reply suggestions for the following conversation.\n`;
    if (tone) promptText += `Tone: ${tone}\n`;
    if (goal) promptText += `Goal: ${goal}\n`;
    if (customizedPrompt) promptText += `Custom instructions: ${customizedPrompt}\n`;

    promptText += `\nConversation History:\n${JSON.stringify(messages || [], null, 2)}`;

    // Call Cerebras Chat Completions
    const response = await fetch("https://api.cerebras.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cleanApiKey}`
      },
      body: JSON.stringify({
        model: targetModel,
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
      console.error("Cerebras API Error:", data);
      return res.status(response.status).json({
        error: data.error?.message || "Failed to generate reply from Cerebras API"
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
