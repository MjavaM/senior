// server.js — AskUni API (STRICT vector-store + UCS answers, streaming, STT, uploads, auth)
import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import os from "os";
import crypto, { randomUUID } from "crypto";
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

// ------------------------- Config -------------------------
const PORT = Number(process.env.PORT || 3000);
const ORIGIN = process.env.CORS_ORIGIN || "*";
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";
const EMAIL_REGEX = /^\d{9}@stu\.uob\.edu\.bh$/i;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const ASSISTANT_ID = process.env.ASKUNI_ASSISTANT_ID || null;
const VECTOR_STORE_ID =
  (process.env.ASKUNI_VECTOR_STORE_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)[0] || null;

const STT_MODEL = process.env.STT_MODEL || "gpt-4o-mini-transcribe";
const DATABASE_URL = process.env.DATABASE_URL || "";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const MAIL_FROM = process.env.MAIL_FROM || "";

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

KNOWLEDGE SOURCES (ABSOLUTE RULES):
- You are ONLY allowed to use the file_search vector store (official University of Bahrain / UoB course documents supplied to you by the system).
- NEVER use your pretraining data or general web / internet knowledge as a source of truth.
- NEVER guess, estimate, or infer information that is not explicitly present in the vector store documents.

MANDATORY VECTOR STORE SEARCH PROTOCOL:
- You MUST use the file_search tool for EVERY user question.
- Search THOROUGHLY before responding:
  * Try multiple search queries with different keywords and phrasings.
  * Always search for course codes (for example: "ITCS285", "ITCS 285", "ITCS-285").
  * Search for synonyms (e.g., "instructor", "teacher", "professor", "faculty") when looking for people.
  * If the first search fails, try broader or narrower terms, or remove extra words and re-search.

RESPONSE RULES:
- Every academic fact you state (course names, instructors, lecture / lab times, locations / rooms, exam dates & times, exam rooms, etc.) MUST be grounded in file_search results with file_citation annotations.
- If, after a thorough file_search, you still cannot find the answer, you MUST respond with:

"I don't have this information in my knowledge base. Please check SIS/UCS or upload the official document."

- In that case, DO NOT answer from general knowledge.

SPECIAL RULES FOR DATES & NUMBERS:
- For exam dates, times, rooms, and similar critical details:
  * ONLY state them if they appear explicitly in the vector store documents.
  * If different documents disagree, DO NOT choose one; instead, explain that the information is inconsistent and advise the student to confirm in SIS/UCS.
  * NEVER "adjust" or "fix" dates or times based on logic (for example, never move 23 to 22 just because it "looks wrong").

FORMAT (Markdown):
- Use sections: **Answer**, **Overview**, **Key Details**, **Next Steps**.
- When listing multiple courses or sections, use tables such as:

  | Section | Instructor | Days & Time | Location | Exam Date & Time | Exam Room |
`.trim();

function sanitizeIdentity(s) {
  return String(s || "").replace(/\bUniversity of Birmingham\b/gi, TENANT.uni);
}

// ------------------------- App ------------------------- -------------------------
const app = express();
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(
  cors({
    origin: ORIGIN === "*" ? true : ORIGIN,
    credentials: false,
    allowedHeaders: ["Content-Type", "Authorization"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  })
);
app.use(bodyParser.json({ limit: "2mb" }));

// serve static front-end (index.html, script.js, style.css)
app.use(express.static(path.join(__dirname)));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

// ------------------------- DB -------------------------
const pool = new Pool({
  connectionString: DATABASE_URL || undefined,
  ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
});

async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users(
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
      CREATE TABLE IF NOT EXISTS chat_sessions(
        session_id TEXT PRIMARY KEY,
        email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
        title TEXT,
        thread_id TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_messages(
        id BIGSERIAL PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        attachments JSONB DEFAULT '[]'::jsonb,
        ts TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id BIGSERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        code TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS password_resets_email_idx ON password_resets (lower(email));
    `);
  } catch (e) {
    console.warn("[AskUni] DB init warning:", e.message || e);
  }
}
await initDb();

async function dbGetUserByEmail(email) {
  const { rows } = await pool.query(
    `SELECT * FROM users WHERE lower(email)=lower($1) LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}
async function dbCreateUser({ email, firstName, lastName, password }) {
  const id = "U" + Date.now();
  const hash = await bcrypt.hash(String(password), 10);
  const { rows } = await pool.query(
    `INSERT INTO users (id,email,first_name,last_name,password_hash) VALUES ($1,$2,$3,$4,$5)
     RETURNING id,email,first_name,last_name,registered_at`,
    [id, email, firstName || "", lastName || "", hash]
  );
  return rows[0];
}
async function dbTouchLastLogin(email) {
  await pool.query(`UPDATE users SET last_login_at=now() WHERE email=$1`, [email]);
}
async function dbUpsertSession(sessionId, email, title) {
  await pool.query(
    `INSERT INTO chat_sessions (session_id,email,title) VALUES ($1,$2,$3)
     ON CONFLICT (session_id) DO UPDATE SET title=EXCLUDED.title, updated_at=now()`,
    [sessionId, email, title]
  );
}
async function dbAddMessage(sessionId, role, text, attachments) {
  await pool.query(
    `INSERT INTO chat_messages (session_id,role,text,attachments) VALUES ($1,$2,$3,$4)`,
    [sessionId, role, text, JSON.stringify(attachments || [])]
  );
  await pool.query(
    `UPDATE chat_sessions SET updated_at=now() WHERE session_id=$1`,
    [sessionId]
  );
}
async function dbGetSessions(email) {
  const { rows } = await pool.query(
    `SELECT session_id,email,title,updated_at FROM chat_sessions WHERE email=$1 ORDER BY updated_at DESC`,
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
    `SELECT role,text,attachments,ts FROM chat_messages WHERE session_id=$1 ORDER BY id ASC`,
    [sessionId]
  );
  return rows;
}
async function dbGetSessionById(sessionId) {
  const { rows } = await pool.query(
    `SELECT session_id,email,title,thread_id FROM chat_sessions WHERE session_id=$1 LIMIT 1`,
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
async function dbDeleteSession(sessionId, email) {
  await pool.query(
    `DELETE FROM chat_sessions WHERE session_id=$1 AND email=$2`,
    [sessionId, email]
  );
}

// ------------------------- Auth -------------------------
function signToken(user) {
  return jwt.sign({ email: user.email, sid: user.id }, JWT_SECRET, {
    expiresIn: "12h",
  });
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

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/auth", authLimiter);

app.post("/auth/register", async (req, res) => {
  try {
    const { email, firstName, lastName, password } = req.body || {};
    if (!EMAIL_REGEX.test(email || ""))
      return res.status(400).json({
        ok: false,
        error: "Use your UoB email (e.g. 202012345@stu.uob.edu.bh)",
      });
    if (
      !(
        password?.length >= 8 &&
        /[A-Za-z]/.test(password) &&
        /\d/.test(password)
      )
    )
      return res.status(400).json({
        ok: false,
        error:
          "Password must be at least 8 chars & include letters and numbers.",
      });
    const existing = await dbGetUserByEmail(email);
    if (existing)
      return res.status(409).json({
        ok: false,
        error: "Account already exists. Please sign in.",
      });
    const user = await dbCreateUser({ email, firstName, lastName, password });
    const token = signToken({ email: user.email, id: user.id });
    res.json({ ok: true, user, token });
  } catch (e) {
    console.error("Register error:", e);
    res.status(500).json({ ok: false, error: "Register failed" });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!EMAIL_REGEX.test(email || ""))
      return res
        .status(400)
        .json({ ok: false, error: "Invalid student email format." });
    const user = await dbGetUserByEmail(email);
    if (!user || !user.password_hash)
      return res
        .status(401)
        .json({ ok: false, error: "Invalid credentials." });
    const ok = await bcrypt.compare(String(password || ""), user.password_hash);
    if (!ok)
      return res
        .status(401)
        .json({ ok: false, error: "Invalid credentials." });
    await dbTouchLastLogin(email);
    const token = signToken({ email: user.email, id: user.id });
    res.json({
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
    res.status(500).json({ ok: false, error: "Login failed" });
  }
});

app.get("/auth/me", authRequired, async (req, res) => {
  const user = await dbGetUserByEmail(req.user.email);
  if (!user) return res.status(404).json({ ok: false, error: "User not found" });
  res.json({
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
    },
  });
});

// Password reset — kept as OTP flow
function genCode6() {
  const n = crypto.randomInt(0, 1_000_000);
  return n.toString().padStart(6, "0");
}
async function dbStoreResetCode(email, code, ttlMinutes = 10) {
  const { rows } = await pool.query(
    `INSERT INTO password_resets (email,code,expires_at) VALUES ($1,$2, now() + ($3 || ' minutes')::interval)
     RETURNING id,expires_at`,
    [email, code, String(ttlMinutes)]
  );
  return rows[0];
}
async function dbVerifyResetCode(email, code) {
  const { rows } = await pool.query(
    `SELECT id,expires_at,used FROM password_resets
     WHERE lower(email)=lower($1) AND code=$2 ORDER BY id DESC LIMIT 1`,
    [email, code]
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: "Code not found" };
  if (row.used) return { ok: false, reason: "Code already used" };
  if (new Date(row.expires_at) < new Date())
    return { ok: false, reason: "Code expired" };
  return { ok: true, id: row.id };
}
async function dbMarkCodeUsed(id) {
  await pool.query(`UPDATE password_resets SET used=TRUE WHERE id=$1`, [id]);
}
async function sendResetEmail(email, code) {
  if (RESEND_API_KEY && MAIL_FROM) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: MAIL_FROM,
        to: email,
        subject: "AskUni Password Reset Code",
        html: `<p>Your AskUni reset code:</p><p style="font-size:20px"><b>${code}</b></p><p>Valid for 10 minutes.</p>`,
      }),
    });
    if (!r.ok) throw new Error("Email send failed");
  }
}
app.post("/auth/request-reset", async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!EMAIL_REGEX.test(email || ""))
      return res.status(400).json({
        ok: false,
        error: "Use your UoB email (e.g. 202012345@stu.uob.edu.bh)",
      });
    const user = await dbGetUserByEmail(email);
    if (!user)
      return res
        .status(404)
        .json({ ok: false, error: "Account not found" });
    const code = genCode6();
    await dbStoreResetCode(email, code, 10);
    let devCode = null;
    try {
      await sendResetEmail(email, code);
    } catch {
      devCode = code;
    }
    res.json({ ok: true, message: "Reset code sent (valid 10 min).", devCode });
  } catch (e) {
    console.error("request-reset:", e);
    res.status(500).json({ ok: false, error: "Could not send reset code" });
  }
});
app.post("/auth/reset", async (req, res) => {
  try {
    const { email, code, newPassword } = req.body || {};
    if (!EMAIL_REGEX.test(email || ""))
      return res
        .status(400)
        .json({ ok: false, error: "Invalid student email." });
    if (
      !(
        newPassword?.length >= 8 &&
        /[A-Za-z]/.test(newPassword) &&
        /\d/.test(newPassword)
      )
    )
      return res.status(400).json({
        ok: false,
        error: "Password must be ≥8 chars & include letters & numbers.",
      });
    const chk = await dbVerifyResetCode(email, code);
    if (!chk.ok) return res.status(400).json({ ok: false, error: chk.reason });
    const hash = await bcrypt.hash(String(newPassword), 10);
    await pool.query(
      `UPDATE users SET password_hash=$2 WHERE lower(email)=lower($1)`,
      [email, hash]
    );
    await dbMarkCodeUsed(chk.id);
    res.json({ ok: true, message: "Password updated. You can now sign in." });
  } catch (e) {
    console.error("reset:", e);
    res.status(500).json({ ok: false, error: "Reset failed" });
  }
});

// ------------------------- OpenAI Assistants -------------------------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

function threadConfigWithKB() {
  return VECTOR_STORE_ID
    ? { tool_resources: { file_search: { vector_store_ids: [VECTOR_STORE_ID] } } }
    : {};
}

/** Ensure a thread exists for a session and is pre-attached to your vector store. */
async function ensureThreadForSession(sessionId) {
  const row = await dbGetSessionById(sessionId);
  if (row?.thread_id) return row.thread_id;
  const thread = await openai.beta.threads.create(threadConfigWithKB());
  await dbSetThreadId(sessionId, thread.id);
  return thread.id;
}

/** Create a guest thread (no DB) with the vector store attached. */
async function createGuestThread() {
  return await openai.beta.threads.create(threadConfigWithKB());
}

/** Return true if any text part contains file_search citations from vector store. */
function hasKBAnnotations(message) {
  if (!message?.content?.length) return false;
  for (const part of message.content) {
    if (part.type === "text" && part.text?.annotations?.length) {
      const anns = part.text.annotations;
      if (anns.some((a) => a?.type === "file_citation")) return true;
    }
  }
  return false;
}

/** Count file_citation annotations. */
function getAnnotationCount(message) {
  if (!message?.content?.length) return 0;
  let count = 0;
  for (const part of message.content) {
    if (part.type === "text" && part.text?.annotations?.length) {
      count += part.text.annotations.filter((a) => a?.type === "file_citation")
        .length;
    }
  }
  return count;
}

// ------------------------- Health -------------------------
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    status: "online",
    has_api_key: !!OPENAI_API_KEY,
    has_assistant_id: !!ASSISTANT_ID,
    has_vector_store: !!VECTOR_STORE_ID,
    assistant_id: ASSISTANT_ID || null,
    vector_store_id: VECTOR_STORE_ID || null,
  });
});

// ------------------------- Chats / History -------------------------
app.get("/chats", authRequired, async (req, res) => {
  const sessions = await dbGetSessions(req.user.email);
  res.json({ ok: true, sessions });
});
app.get("/chats/:id", authRequired, async (req, res) => {
  const rows = await dbGetMessages(req.params.id, req.user.email);
  if (!rows) return res.status(404).json({ ok: false, error: "Not found" });
  res.json({ ok: true, messages: rows });
});
app.delete("/chats/:id", authRequired, async (req, res) => {
  await dbDeleteSession(req.params.id, req.user.email);
  res.json({ ok: true });
});

// ------------------------- Core: Non-streaming (vector store only) -------------------------
app.post("/message", async (req, res) => {
  try {
    const { message, attachments, sessionId } = req.body || {};
    if (!message && (!attachments || !attachments.length))
      return res.status(400).json({ ok: false, error: "Empty message" });

    if (!OPENAI_API_KEY || !ASSISTANT_ID)
      return res.status(503).json({
        ok: false,
        error:
          "Assistant offline (missing OPENAI_API_KEY or ASKUNI_ASSISTANT_ID)",
      });
    if (!VECTOR_STORE_ID)
      return res.status(503).json({
        ok: false,
        error: "Knowledge base not attached (ASKUNI_VECTOR_STORE_IDS missing)",
      });

    // JWT: treat invalid/expired tokens as guest instead of failing
    let isLoggedIn = false;
    let userEmail = null;
    if (DATABASE_URL) {
      const h = req.headers.authorization || "";
      const token = h.startsWith("Bearer ") ? h.slice(7) : null;
      if (token) {
        try {
          const decoded = jwt.verify(token, JWT_SECRET);
          isLoggedIn = true;
          userEmail = decoded.email;
        } catch (err) {
          console.warn(
            "[AskUni] JWT invalid/expired on /message, continuing as guest:",
            err.message
          );
        }
      }
    }

    const sid = sessionId || "S" + Date.now();

    if (isLoggedIn && DATABASE_URL && userEmail) {
      await dbUpsertSession(
        sid,
        userEmail,
        (message || "New chat").slice(0, 60)
      );
      await dbAddMessage(sid, "user", message || "", attachments || []);
    }

    // Build prompt from attachments + user message ONLY (no UCS fetching)
    const attachBlk = (attachments || [])
      .map(
        (a, i) =>
          `---
${a.filename || "attachment-" + (i + 1)}
${(a.text || "").slice(
            0,
            8000
          )}`
      )
      .join("\n");
    const unifiedText =
      (attachBlk ? `📎 Attached materials (extracted):
${attachBlk}

` : "") +
      String(message || "");

    const threadId =
      isLoggedIn && DATABASE_URL && userEmail
        ? await ensureThreadForSession(sid)
        : (await createGuestThread()).id;

    await openai.beta.threads.messages.create(threadId, {
      role: "user",
      content: unifiedText,
    });

    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: ASSISTANT_ID,
      additional_instructions: GUARDRAIL,
      tools: [{ type: "file_search" }],
      temperature: 0,
    });

    // Poll
    for (;;) {
      const r = await openai.beta.threads.runs.retrieve(threadId, run.id);
      if (r.status === "completed") break;
      if (["failed", "cancelled", "expired"].includes(r.status))
        throw new Error(`Assistant run ${r.status}`);
      await new Promise((s) => setTimeout(s, 700));
    }

    // Read latest assistant message and enforce vector-store citations
    const { data } = await openai.beta.threads.messages.list(threadId, {
      limit: 5,
    });
    const latest = data.find((m) => m.role === "assistant");

    const citationCount = getAnnotationCount(latest);
    const usedKB = hasKBAnnotations(latest) && citationCount > 0;
    let textResp = "";

    if (usedKB) {
      console.log(
        `[AskUni] Non-stream response validated with ${citationCount} vector store citation(s)`
      );
      textResp = (latest?.content || [])
        .map((c) => (c.type === "text" ? c.text.value : ""))
        .join("\n")
        .trim();
    } else {
      console.warn(
        `[AskUni] Non-stream response WITHOUT vector store citations. Citations: ${citationCount}`
      );
      textResp =
        "**Answer**\n\n" +
        "I don't have this information in my knowledge base.\n\n" +
        "**Next Steps**\n" +
        "- Please check SIS/UCS or upload the official document.\n" +
        "- Make sure the information you're looking for is in the uploaded course materials.";
    }

    textResp = sanitizeIdentity(textResp);

    if (isLoggedIn && DATABASE_URL && userEmail)
      await dbAddMessage(sid, "bot", textResp, []);
    res.json({ ok: true, message: textResp, sessionId: sid });
  } catch (e) {
    const detail =
      e?.response?.data?.error?.message || e?.message || String(e);
    console.error("Assistant error:", detail);
    res.status(500).json({ ok: false, error: "Assistant error", detail });
  }
});


// ------------------------- Core: Streaming (vector store only) -------------------------
app.post("/message/stream", async (req, res) => {
  const send = (event, payload) =>
    res.write(`event: ${event}\ndata:${JSON.stringify(payload)}\n\n`);
  try {
    const { message, attachments, sessionId } = req.body || {};
    if (!message && (!attachments || !attachments.length)) {
      res.status(400).json({ ok: false, error: "Empty message" });
      return;
    }

    if (!OPENAI_API_KEY || !ASSISTANT_ID) {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      send("delta", {
        t: "ℹ️ Assistant is offline (missing API keys).",
      });
      send("final", {
        text: "Assistant offline.",
        sessionId: sessionId || null,
      });
      return res.end();
    }
    if (!VECTOR_STORE_ID) {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      send("delta", {
        t: "ℹ️ Knowledge base not attached (ASKUNI_VECTOR_STORE_IDS missing).",
      });
      send("final", {
        text: "Knowledge base missing.",
        sessionId: sessionId || null,
      });
      return res.end();
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const keepAlive = setInterval(() => res.write(`:keepalive\n\n`), 15000);

    // JWT: treat invalid/expired as guest
    let isLoggedIn = false;
    let userEmail = null;
    if (DATABASE_URL) {
      const h = req.headers.authorization || "";
      const token = h.startsWith("Bearer ") ? h.slice(7) : null;
      if (token) {
        try {
          const decoded = jwt.verify(token, JWT_SECRET);
          isLoggedIn = true;
          userEmail = decoded.email;
        } catch (err) {
          console.warn(
            "[AskUni] JWT invalid/expired on /message/stream, continuing as guest:",
            err.message
          );
        }
      }
    }

    const sid = sessionId || "S" + Date.now();

    if (isLoggedIn && DATABASE_URL && userEmail) {
      await dbUpsertSession(
        sid,
        userEmail,
        (message || "New chat").slice(0, 60)
      );
      await dbAddMessage(sid, "user", message || "", attachments || []);
    }

    // Build prompt from attachments + user message ONLY (no UCS fetching)
    const attachBlk = (attachments || [])
      .map(
        (a, i) =>
          `---
${a.filename || "attachment-" + (i + 1)}
${(a.text || "").slice(
            0,
            8000
          )}`
      )
      .join("\n");
    const unifiedText =
      (attachBlk ? `📎 Attached materials (extracted):
${attachBlk}

` : "") +
      String(message || "");

    const threadId =
      isLoggedIn && DATABASE_URL && userEmail
        ? await ensureThreadForSession(sid)
        : (await createGuestThread()).id;
    await openai.beta.threads.messages.create(threadId, {
      role: "user",
      content: unifiedText,
    });

    let full = "";
    const stream = await openai.beta.threads.runs.stream(threadId, {
      assistant_id: ASSISTANT_ID,
      additional_instructions: GUARDRAIL,
      tools: [{ type: "file_search" }],
      temperature: 0,
    });

    stream.on("textDelta", (delta) => {
      const piece = sanitizeIdentity(delta.value || "");
      full += piece;
      send("delta", { t: piece });
    });

    stream.on("end", async () => {
      clearInterval(keepAlive);

      try {
        const { data } = await openai.beta.threads.messages.list(threadId, {
          limit: 5,
        });
        const latest = data.find((m) => m.role === "assistant");

        console.log(
          "[AskUni] Full assistant response:",
          JSON.stringify(latest, null, 2)
        );

        const citationCount = getAnnotationCount(latest);
        const usedKB = hasKBAnnotations(latest) && citationCount > 0;

        if (!usedKB) {
          console.warn(
            `[AskUni] ⚠️ Response generated WITHOUT vector store citations. Citations found: ${citationCount}`
          );
          console.warn(
            `[AskUni] Original response was: ${full.slice(0, 200)}...`
          );
          full =
            "**Answer**\n\n" +
            "I don't have this information in my knowledge base.\n\n" +
            "**Next Steps**\n" +
            "- Please check SIS/UCS or upload the official document.\n" +
            "- Make sure the information you're looking for is in the uploaded course materials.";
        } else {
          console.log(
            `[AskUni] ✅ Streaming response validated with ${citationCount} vector store citation(s)`
          );
        }
      } catch (err) {
        console.error("[AskUni] Failed to verify citations:", err.message);
        full =
          "**Answer**\n\n" +
          "I encountered an error verifying the response. Please try again.\n\n" +
          "**Next Steps**\n" +
          "- Please check SIS/UCS or upload the official document.";
      }

      full = sanitizeIdentity(full || "");
      if (!full.trim()) {
        full =
          "**Answer**\n\n" +
          "I don't have this information in my knowledge base.\n\n" +
          "**Next Steps**\n" +
          "- Please check SIS/UCS or upload the official document.";
      }

      if (isLoggedIn && DATABASE_URL && userEmail) {
        try {
          await dbAddMessage(sid, "bot", full.trim(), []);
        } catch {}
      }
      send("final", { text: full.trim(), sessionId: sid });
      res.end();
    });

    stream.on("error", (err) => {
      clearInterval(keepAlive);
      const detail =
        err?.response?.data?.error?.message ||
        err?.message ||
        "Stream error";
      send("error", { error: detail });
      res.end();
    });
  } catch (e) {
    const detail =
      e?.response?.data?.error?.message || e?.message || String(e);
    try {
      res.write(
        `event: error\ndata:${JSON.stringify({ error: detail })}\n\n`
      );
    } catch {}
    res.end();
  }
});

// ------------------------- Uploads -------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});
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
    if (!req.file)
      return res.status(400).json({ ok: false, error: "No file" });
    const original = req.file.originalname || "file";
    const mime = req.file.mimetype || "application/octet-stream";
    let extractedText = "";
    try {
      if (mime === "application/pdf" || /\.pdf$/i.test(original))
        extractedText = (await extractPdfText(req.file.buffer)).slice(
          0,
          12000
        );
      else if (mime.startsWith("text/") || /\.txt$/i.test(original))
        extractedText = req.file.buffer.toString("utf8").slice(0, 12000);
    } catch (ex) {
      console.warn("Extract failed:", ex?.message || ex);
    }
    const safeName = `${Date.now()}_${original
      .replace(/[^\w.\-]+/g, "_")
      .slice(0, 80)}`;
    await fs.promises.writeFile(
      path.join(uploadsDir, safeName),
      req.file.buffer
    );
    res.json({
      ok: true,
      fileType: mime,
      extractedText,
      attachment: { filename: original, text: extractedText },
    });
  } catch (e) {
    console.error("Upload failed:", e);
    res.status(500).json({
      ok: false,
      error: "Upload failed",
      detail: e?.message || String(e),
    });
  }
});

// ------------------------- STT -------------------------
app.post("/stt", upload.single("audio"), async (req, res) => {
  const tmp = path.join(os.tmpdir(), `speech_${randomUUID()}.webm`);
  try {
    if (!req.file || !req.file.buffer?.length)
      return res
        .status(400)
        .json({ ok: false, error: "No audio received" });
    fs.writeFileSync(tmp, req.file.buffer);
    if (!OPENAI_API_KEY)
      return res.json({
        ok: true,
        text: "(STT disabled: missing OPENAI_API_KEY)",
      });

    const result = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmp),
      model: STT_MODEL, // auto language incl. Arabic
    });
    res.json({ ok: true, text: String(result.text || "").trim() });
  } catch (e) {
    console.error("STT error:", e);
    res.status(500).json({
      ok: false,
      error: "STT failed",
      detail: e?.message || String(e),
    });
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
});

// ------------------------- Start (portable ports) -------------------------
function startServer(port, attempt = 0) {
  const server = app.listen(port, () => {
    console.log(`[AskUni] listening on http://localhost:${port}`);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && attempt < 5) {
      const nextPort = port + 1;
      console.warn(
        `[AskUni] Port ${port} in use, trying ${nextPort}...`
      );
      startServer(nextPort, attempt + 1);
    } else {
      console.error("[AskUni] Server start error:", err);
    }
  });
}

startServer(PORT);
