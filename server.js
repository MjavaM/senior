const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
require("dotenv").config();
const { OpenAI } = require("openai");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const assistantId = "asst_autuWSL1jDoOJzLUZbbvCwPP";

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

function cleanResponse(text) {
  if (!text) return text;
  return text.replace(/【[^】]*】/g, '').replace(/\s{2,}/g, ' ').trim();
}

// Keep threadId persistent using UUID or client-side id (simplified here as a shared ID for demo)
let sharedThreadId = null;

app.post("/message", async (req, res) => {
  try {
    const userMessage = req.body.message;

    if (!sharedThreadId) {
      const thread = await openai.beta.threads.create();
      sharedThreadId = thread.id;
    }

    await openai.beta.threads.messages.create(sharedThreadId, {
      role: "user",
      content: userMessage,
    });

    const run = await openai.beta.threads.runs.create(sharedThreadId, {
      assistant_id: assistantId,
    });

    let runStatus;
    let attempts = 0;
    const maxAttempts = 60;

    // Reduce polling interval to 500ms
    do {
      if (attempts >= maxAttempts) {
        return res.status(504).json({ message: "The AI assistant is taking too long to respond. Please try again." });
      }

      runStatus = await openai.beta.threads.runs.retrieve(sharedThreadId, run.id);

      if (runStatus.status === "failed") return res.status(500).json({ message: "The assistant encountered an error." });
      if (runStatus.status === "cancelled") return res.status(500).json({ message: "The request was cancelled." });

      await new Promise(resolve => setTimeout(resolve, 500));
      attempts++;
    } while (runStatus.status !== "completed");

    const messages = await openai.beta.threads.messages.list(sharedThreadId);
    const assistantMessage = messages.data.find(msg => msg.role === "assistant");
    let reply = assistantMessage?.content?.[0]?.text?.value;

    if (!reply) res.status(404).json({ message: "No reply received from assistant." });
    else res.json({ message: cleanResponse(reply) });
  } catch (err) {
    console.error("❌ Server Error:", err.message);
    res.status(500).json({ message: "Server error occurred: " + err.message });
  }
});

app.listen(3000, () => console.log("✅ Server running on http://localhost:3000"));

