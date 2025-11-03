// server.js — AskUni API with guest mode, streaming, STT, uploads, UoB guardrail
import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import bodyParser from "body-parser";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import OpenAI from "openai";
import { Pool } from "pg";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------- Config ----------------
const PORT = Number(process.env.PORT || 3000);
const ORIGIN = process.env.CORS_ORIGIN || "*";
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";
const EMAIL_REGEX = /^\d{9}@stu\.uob\.edu\.bh$/i;
const ASSISTANT_ID = process.env.ASKUNI_ASSISTANT_ID || null;
const STT_MODEL = process.env.STT_MODEL || "gpt-4o-mini-transcribe";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// Tenant & guardrail
const TENANT = {
  uni: "University of Bahrain",
  short: "UoB",
  college: "College of IT",
  dept: "Computer Science",
};

const GUARDRAIL = `
CRITICAL IDENTITY:
- "UoB" ALWAYS means "University of Bahrain".
- NEVER mention "University of Birmingham" unless the user explicitly asks.

TASK:
- Help ${TENANT.uni} • ${TENANT.college} • ${TENANT.dept} students with courses, prerequisites, registration, labs, exams, projects, SIS/UCS, etc.
- Prefer the assistant's vector store and any user attachments. If unknown, say so and point to SIS/UCS.

FORMAT (Markdown):
- Start with **Answer**.
- Then sections: **Overview**, **Key Details**, **Next Steps** (bullets).
- Use compact tables for sections/slots with headers: | Section | Instructor | Days & Time | Location | Seats |.
- Concise (8–12 bullets). Reply in user's language (Arabic/English).
`;

function sanitizeIdentity(s) {
  return String(s || "").replace(/\bUniversity of Birmingham\b/gi, TENANT.uni);
}

// ---------------- App ----------------
const app = express();
// Allow external background images (Unsplash/CDNs) via CSS
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(
  cors({
    origin: ORIGIN === "*" ? true : ORIGIN,
    credentials: false,
    allowedHeaders: ["Content-Type", "Authorization"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  })
);
app.use(bodyParser.json({ limit: "2mb" }));

// Serve SPA statically from repo root
app.use(express.static(path.join(__dirname)));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

// ---------------- DB ----------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
});

await pool.query(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  first_name TEXT,
  last_name TEXT,
  password_hash TEXT,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS users_email_idx ON users (lower(email));
`);

await pool.query(`
CREATE TABLE IF NOT EXISTS chat_sessions (
  session_id TEXT PRIMARY KEY,
  email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
  title TEXT,
  thread_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`);

await pool.query(`
CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  attachments JSONB DEFAULT '[]'::jsonb,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);
`);

async function dbGetUserByEmail(email) {
  const { rows } = await pool.query(
    `SELECT * FROM users WHERE lower(email)=lower($1) LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}
async function dbCreateUser({ email, firstName, lastName, password }) {
  const id = "U" + Date.now();
  const password_hash = await bcrypt.hash(String(password), 10);
  const { rows } = await pool.query(
    `INSERT INTO users (id, email, first_name, last_name, password_hash)
     VALUES ($1,$2,$3,$4,$5) RETURNING id,email,first_name,last_name,registered_at`,
    [id, email, firstName || "", lastName || "", password_hash]
  );
  return rows[0];
}
async function dbTouchLastLogin(email) {
  await pool.query(`UPDATE users SET last_login_at=now() WHERE email=$1`, [email]);
}
async function dbUpsertSession(sessionId, email, title) {
  await pool.query(
    `INSERT INTO chat_sessions (session_id, email, title)
     VALUES ($1,$2,$3)
     ON CONFLICT (session_id) DO UPDATE SET title=EXCLUDED.title, updated_at=now()`,
    [sessionId, email, title]
  );
}
async function dbAddMessage(sessionId, role, text, attachments) {
  await pool.query(
    `INSERT INTO chat_messages (session_id, role, text, attachments) VALUES ($1,$2,$3,$4)`,
    [sessionId, role, text, JSON.stringify(attachments)]
  );
  await pool.query(`UPDATE chat_sessions SET updated_at=now() WHERE session_id=$1`, [sessionId]);
}
async function dbGetSessions(email) {
  const { rows } = await pool.query(
    `SELECT session_id, email, title, updated_at FROM chat_sessions WHERE email=$1 ORDER BY updated_at DESC`,
    [email]
  );
  return rows;
}
async function dbGetMessages(sessionId, email) {
  const { rows: own } = await pool.query(
    `SELECT 1 FROM chat_sessions WHERE session_id=$1 AND email=$2 LIMIT 1`,
    [sessionId, email]
  );
  if (!own.length) return null;
  const { rows } = await pool.query(
    `SELECT role, text, attachments, ts FROM chat_messages WHERE session_id=$1 ORDER BY id ASC`,
    [sessionId]
  );
  return rows;
}
async function dbGetSessionById(sessionId) {
  const { rows } = await pool.query(
    `SELECT session_id, email, title, thread_id FROM chat_sessions WHERE session_id=$1 LIMIT 1`,
    [sessionId]
  );
  return rows[0] || null;
}
async function dbSetThreadId(sessionId, threadId) {
  await pool.query(
    `UPDATE chat_sessions SET thread_id=$2, updated_at=now() WHERE session_id=$1`,
    [sessionId, threadId]
  );
}

// ---------------- Auth ----------------
function signToken(user) {
  return jwt.sign({ email: user.email, sid: user.id }, JWT_SECRET, { expiresIn: "12h" });
}
function authRequired(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: "Missing token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ ok: false, error: "Invalid token" });
  }
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---------------- Health ----------------
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    status: "online",
    assistants: !!ASSISTANT_ID,
    assistant_id: ASSISTANT_ID || null,
    note: "Streaming /message/stream with UoB guardrail."
  });
});

// ---------------- Auth routes ----------------
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/auth", authLimiter);

app.post("/auth/register", async (req, res) => {
  try {
    const { email, firstName, lastName, password } = req.body || {};
    if (!EMAIL_REGEX.test(email || "")) {
      return res.status(400).json({ ok: false, error: "Use your UoB email (e.g. 202012345@stu.uob.edu.bh)" });
    }
    if (!(password?.length >= 8 && /[A-Za-z]/.test(password) && /\d/.test(password))) {
      return res.status(400).json({ ok: false, error: "Password must be at least 8 chars & include letters and numbers." });
    }
    const existing = await dbGetUserByEmail(email);
    if (existing) return res.status(409).json({ ok: false, error: "Account already exists. Please sign in." });
    const user = await dbCreateUser({ email, firstName, lastName, password });
    const token = signToken({ email: user.email, id: user.id });
    return res.json({ ok: true, user, token });
  } catch (e) {
    console.error("Register error:", e);
    return res.status(500).json({ ok: false, error: "Register failed" });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!EMAIL_REGEX.test(email || "")) return res.status(400).json({ ok: false, error: "Invalid student email format." });
    const user = await dbGetUserByEmail(email);
    if (!user || !user.password_hash) return res.status(401).json({ ok: false, error: "Invalid credentials." });
    const ok = await bcrypt.compare(String(password || ""), user.password_hash);
    if (!ok) return res.status(401).json({ ok: false, error: "Invalid credentials." });

    await dbTouchLastLogin(email);
    const token = signToken({ email: user.email, id: user.id });
    return res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        registered_at: user.registered_at,
      },
      token,
    });
  } catch (e) {
    console.error("Login error:", e);
    return res.status(500).json({ ok: false, error: "Login failed" });
  }
});

app.get("/auth/me", authRequired, async (req, res) => {
  const user = await dbGetUserByEmail(req.user.email);
  if (!user) return res.status(404).json({ ok: false, error: "User not found" });
  res.json({
    ok: true,
    user: { id: user.id, email: user.email, first_name: user.first_name, last_name: user.last_name },
  });
});

// --------- Assistants helpers ---------
async function ensureThreadForSession(sessionId) {
  const row = await dbGetSessionById(sessionId);
  if (row?.thread_id) return row.thread_id;
  const thread = await openai.beta?.threads?.create();
  await dbSetThreadId(sessionId, thread.id);
  return thread.id;
}

// ---------------- Chats / Messages ----------------
// Non-streaming fallback — GUEST ENABLED
app.post("/message", async (req, res) => {
  try {
    const { message, attachments, sessionId } = req.body || {};
    if (!message && (!attachments || !attachments.length)) {
      return res.status(400).json({ ok: false, error: "Empty message" });
    }

    // Persist only if logged in
    const isLoggedIn = !!req.headers.authorization;
    const sid = sessionId || ("S" + Date.now());

    if (isLoggedIn) {
      const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const decoded = jwt.verify(token, JWT_SECRET);
      await dbUpsertSession(sid, decoded.email, (message || "New chat").slice(0, 60));
      await dbAddMessage(sid, "user", message || "", attachments || []);
    }

    const attachBlk = (attachments || [])
      .map((a, i) => `---\n${a.filename || "attachment-" + (i + 1)}\n${(a.text || "").slice(0, 8000)}`)
      .join("\n");

    const unifiedText =
      (attachBlk ? `📎 Attached materials (extracted):\n${attachBlk}\n\n` : "") + String(message || "");

    let text = "ℹ️ Assistant is offline (missing OPENAI_API_KEY or ASKUNI_ASSISTANT_ID).";
    if (OPENAI_API_KEY && ASSISTANT_ID) {
      const threadId = isLoggedIn ? await ensureThreadForSession(sid) : (await openai.beta.threads.create()).id;
      await openai.beta.threads.messages.create(threadId, { role: "user", content: unifiedText });
      const run = await openai.beta.threads.runs.create(threadId, {
        assistant_id: ASSISTANT_ID,
        additional_instructions: GUARDRAIL,
      });

      // Poll until complete
      for (;;) {
        const r = await openai.beta.threads.runs.retrieve(threadId, run.id);
        if (r.status === "completed") break;
        if (["failed", "cancelled", "expired"].includes(r.status))
          throw new Error(`Assistant run ${r.status}`);
        await new Promise((s) => setTimeout(s, 700));
      }

      const msgs = await openai.beta.threads.messages.list(threadId, { limit: 10 });
      const latest = msgs.data.find((m) => m.role === "assistant");
      text = (latest?.content || [])
        .map((c) => (c.type === "text" ? c.text.value : ""))
        .join("\n")
        .trim();
      text = sanitizeIdentity(text);
    }

    if (isLoggedIn) await dbAddMessage(sid, "bot", text, []);

    res.json({ ok: true, message: text, sessionId: sid });
  } catch (e) {
    const detail = e?.response?.data?.error?.message || e?.message || String(e);
    console.error("Assistant error:", detail);
    res.status(500).json({ ok: false, error: "Assistant error", detail });
  }
});

// Streaming — GUEST ENABLED
app.post("/message/stream", async (req, res) => {
  const send = (event, payload) =>
    res.write(`event: ${event}\ndata:${JSON.stringify(payload)}\n\n`);

  try {
    const { message, attachments, sessionId } = req.body || {};
    if (!message && (!attachments || !attachments.length)) {
      res.status(400).json({ ok: false, error: "Empty message" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const keepAlive = setInterval(() => res.write(`:keepalive\n\n`), 15000);

    const isLoggedIn = !!req.headers.authorization;
    const sid = sessionId || ("S" + Date.now());

    if (isLoggedIn) {
      const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const decoded = jwt.verify(token, JWT_SECRET);
      await dbUpsertSession(sid, decoded.email, (message || "New chat").slice(0, 60));
      await dbAddMessage(sid, "user", message || "", attachments || []);
    }

    const attachBlk = (attachments || [])
      .map((a, i) => `---\n${a.filename || "attachment-" + (i + 1)}\n${(a.text || "").slice(0, 8000)}`)
      .join("\n");

    const unifiedText =
      (attachBlk ? `📎 Attached materials (extracted):\n${attachBlk}\n\n` : "") + String(message || "");

    if (!OPENAI_API_KEY || !ASSISTANT_ID) {
      send("delta", { t: "ℹ️ Assistant is offline (missing API keys)." });
      send("final", { text: "Assistant offline.", sessionId: sid });
      clearInterval(keepAlive);
      res.end();
      return;
    }

    const threadId = isLoggedIn ? await ensureThreadForSession(sid) : (await openai.beta.threads.create()).id;
    await openai.beta.threads.messages.create(threadId, { role: "user", content: unifiedText });

    let full = "";
    const stream = await openai.beta.threads.runs.stream(threadId, {
      assistant_id: ASSISTANT_ID,
      additional_instructions: GUARDRAIL,
    });

    stream.on("textDelta", (delta) => {
      const piece = sanitizeIdentity(delta.value || "");
      full += piece;
      send("delta", { t: piece });
    });

    stream.on("end", async () => {
      clearInterval(keepAlive);
      const finalText = (full || "").trim();
      if (isLoggedIn) {
        try { await dbAddMessage(sid, "bot", finalText, []); } catch {}
      }
      send("final", { text: finalText, sessionId: sid });
      res.end();
    });

    stream.on("error", (err) => {
      clearInterval(keepAlive);
      const detail = err?.response?.data?.error?.message || err?.message || "Stream error";
      send("error", { error: detail });
      res.end();
    });
  } catch (e) {
    const detail = e?.response?.data?.error?.message || e?.message || String(e);
    try { res.write(`event: error\ndata:${JSON.stringify({ error: detail })}\n\n`); } catch {}
    res.end();
  }
});

// ---------------- Uploads (guest enabled) ----------------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const uploadsDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

async function extractPdfText(buffer) {
  const pdf = await getDocument({ data: buffer, disableWorker: true }).promise;
  let full = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    full += tc.items.map((it) => it.str).join(" ") + "\n";
  }
  return full;
}

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file" });
    const original = req.file.originalname || "file";
    const mime = req.file.mimetype || "application/octet-stream";

    let extractedText = "";
    try {
      if (mime === "application/pdf" || /\.pdf$/i.test(original)) {
        extractedText = (await extractPdfText(req.file.buffer)).slice(0, 12000);
      } else if (mime.startsWith("text/") || /\.txt$/i.test(original)) {
        extractedText = req.file.buffer.toString("utf8").slice(0, 12000);
      }
    } catch (ex) { console.warn("Extract failed:", ex?.message || ex); }

    const safeName = `${Date.now()}_${original.replace(/[^\w.\-]+/g, "_").slice(0, 80)}`;
    await fs.promises.writeFile(path.join(uploadsDir, safeName), req.file.buffer);

    res.json({
      ok: true,
      fileType: mime,
      extractedText,
      attachment: { filename: original, text: extractedText },
    });
  } catch (e) {
    console.error("Upload failed:", e);
    res.status(500).json({ ok: false, error: "Upload failed", detail: e?.message || String(e) });
  }
});

// ---------------- STT (guest enabled, always JSON) ----------------
app.post("/stt", upload.single("audio"), async (req, res) => {
  const tmp = path.join(os.tmpdir(), `speech_${randomUUID()}.webm`);
  try {
    if (!req.file || !req.file.buffer?.length)
      return res.status(400).json({ ok: false, error: "No audio received" });

    fs.writeFileSync(tmp, req.file.buffer);

    if (!OPENAI_API_KEY) {
      return res.json({ ok: true, text: "(STT disabled: missing OPENAI_API_KEY)" });
    }

    let transcription;
    try {
      transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tmp),
        model: STT_MODEL,
      });
    } catch (e1) {
      try {
        transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream(tmp),
          model: "whisper-1",
        });
      } catch (e2) {
        const detail =
          e2?.response?.data?.error?.message ||
          e1?.response?.data?.error?.message ||
          e2?.message || e1?.message || "STT error";
        throw new Error(detail);
      }
    }
    const text = (transcription?.text || "").trim();
    res.json({ ok: true, text: text || "" });
  } catch (e) {
    const detail = e?.response?.data?.error?.message || e?.message || String(e);
    console.error("STT error:", detail);
    res.status(500).json({ ok: false, error: "STT error", detail });
  } finally {
    fs.existsSync(tmp) && fs.unlink(tmp, () => {});
  }
});

// ---------------- Start ----------------
console.log(`[AskUni] Starting API on port ${PORT}`);
if (!OPENAI_API_KEY) console.warn("[AskUni] WARNING: OPENAI_API_KEY is not set.");
if (!ASSISTANT_ID) console.warn("[AskUni] WARNING: ASKUNI_ASSISTANT_ID is not set — assistant will be offline.");

function start(port, attempts = 6) {
  const server = app.listen(port, () => console.log(`AskUni API at http://localhost:${port}`));
  server.on("error", (err) => {
    if (err?.code === "EADDRINUSE" && attempts > 0) {
      const next = port + 1;
      console.warn(`Port ${port} in use; trying ${next}...`);
      start(next, attempts - 1);
    } else {
      console.error("Failed to start:", err?.message || err);
      process.exit(1);
    }
  });
}
start(PORT);
