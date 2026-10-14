"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { DatabaseSync } = require("node:sqlite");

const scrypt = promisify(crypto.scrypt);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "outputs");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const PORT = Number(process.env.PORT) || 3000;
const SESSION_DAYS = 30;
const COOKIE_NAME = "grind_session";
const MAX_BODY_BYTES = 1024 * 1024;
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"
};

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "the-grind.sqlite"));
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
    password_salt BLOB NOT NULL, password_hash BLOB NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS habits (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '🎯', image TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'Personal', target INTEGER NOT NULL DEFAULT 1,
    unit TEXT NOT NULL DEFAULT 'times', step INTEGER NOT NULL DEFAULT 1,
    reminder TEXT NOT NULL DEFAULT '', started_on TEXT NOT NULL, total_completed INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id, name)
  );
  CREATE TABLE IF NOT EXISTS habit_logs (
    habit_id TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
    day TEXT NOT NULL, amount INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(habit_id, day)
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_habits_user ON habits(user_id);
`);

const insertSession = db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)");
const deleteSession = db.prepare("DELETE FROM sessions WHERE token_hash=?");
const getUserByEmail = db.prepare("SELECT * FROM users WHERE email=?");
const getUserById = db.prepare("SELECT id,name,email FROM users WHERE id=?");
const getSessionUser = db.prepare(`SELECT users.id,users.name,users.email,sessions.token_hash
  FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>?`);
const allHabits = db.prepare("SELECT * FROM habits WHERE user_id=? ORDER BY rowid");
const habitLogs = db.prepare(`SELECT habit_logs.day,habit_logs.amount,habit_logs.completed,habits.name
  FROM habit_logs JOIN habits ON habits.id=habit_logs.habit_id WHERE habits.user_id=?`);

function json(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders });
  res.end(JSON.stringify(payload));
}
function fail(status, message) { const error = new Error(message); error.status = status; throw error; }
function cookieValue(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return "";
}
function secureRequest(req) { return (req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http")).split(",")[0].trim() === "https"; }
function setSessionCookie(res, token, req) {
  const seconds = SESSION_DAYS * 24 * 60 * 60;
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${seconds}${secureRequest(req) ? "; Secure" : ""}`);
}
function clearSessionCookie(res, req) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureRequest(req) ? "; Secure" : ""}`);
}
function hashToken(token) { return crypto.createHash("sha256").update(token).digest("hex"); }
function currentUser(req) {
  const token = cookieValue(req, COOKIE_NAME);
  return token ? getSessionUser.get(hashToken(token), Date.now()) : null;
}
function requireUser(req) { const user = currentUser(req); if (!user) fail(401, "Please sign in to continue."); return user; }
function validateOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  const proto = secureRequest(req) ? "https" : "http";
  if (origin !== `${proto}://${req.headers.host}`) fail(403, "Request origin was not accepted.");
}
async function readBody(req) {
  let size = 0, content = "";
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) fail(413, "Request is too large.");
    content += chunk.toString("utf8");
  }
  if (!content) return {};
  try { return JSON.parse(content); } catch { fail(400, "Request body must be valid JSON."); }
}
function isEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254; }
function createSession(userId, res, req) {
  const token = crypto.randomBytes(32).toString("base64url");
  insertSession.run(hashToken(token), userId, Date.now() + SESSION_DAYS * 86400000);
  setSessionCookie(res, token, req);
}
function toClientHabits(userId) {
  const result = {};
  for (const row of allHabits.all(userId)) {
    result[row.name] = {
      name: row.name, icon: row.icon, image: row.image, category: row.category,
      target: row.target, unit: row.unit, step: row.step, reminder: row.reminder,
      startedOn: row.started_on, totalCompleted: row.total_completed, completions: [], dailyTotals: {}
    };
  }
  for (const row of habitLogs.all(userId)) {
    const habit = result[row.name];
    if (!habit) continue;
    habit.dailyTotals[row.day] = row.amount;
    if (row.completed) habit.completions.push(row.day);
  }
  return result;
}
function validDay(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value); }
function cleanHabit(key, raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.name || key).trim().slice(0, 40);
  if (!name) return null;
  const target = Math.max(1, Math.min(10000, Math.trunc(Number(raw.target) || 1)));
  const step = Math.max(1, Math.min(target, Math.trunc(Number(raw.step) || 1)));
  const icon = Array.from(String(raw.icon || "🎯")).slice(0, 4).join("");
  const image = /^assets\/[\w-]+\.svg(?:\?v=\d+)?$/.test(String(raw.image || "")) ? String(raw.image) : "";
  const reminder = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(raw.reminder || "")) ? String(raw.reminder) : "";
  const dailyTotals = raw.dailyTotals && typeof raw.dailyTotals === "object" ? raw.dailyTotals : {};
  const completions = new Set(Array.isArray(raw.completions) ? raw.completions.filter(validDay) : []);
  const logs = Object.entries(dailyTotals).filter(([day]) => validDay(day)).map(([day, amount]) => {
    const value = Math.max(0, Math.min(target, Math.trunc(Number(amount) || 0)));
    return { day, amount: value, completed: completions.has(day) || value >= target };
  });
  for (const day of completions) if (!logs.some(log => log.day === day)) logs.push({ day, amount: target, completed: true });
  return {
    name, icon, image,
    category: String(raw.category || "Personal").trim().slice(0, 24) || "Personal",
    target, unit: String(raw.unit || "times").slice(0, 16), step,
    reminder, startedOn: validDay(raw.startedOn) ? raw.startedOn : new Date().toISOString().slice(0, 10),
    totalCompleted: Math.max(0, Math.trunc(Number(raw.totalCompleted) || logs.filter(log => log.completed).length)), logs
  };
}
function replaceHabits(userId, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(400, "Habits must be an object.");
  const entries = Object.entries(input).slice(0, 100).map(([key, value]) => cleanHabit(key, value)).filter(Boolean);
  const seen = new Set();
  for (const habit of entries) {
    const normalized = habit.name.toLocaleLowerCase();
    if (seen.has(normalized)) fail(400, "Habit names must be unique.");
    seen.add(normalized);
  }
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM habits WHERE user_id=?").run(userId);
    const putHabit = db.prepare(`INSERT INTO habits(id,user_id,name,icon,image,category,target,unit,step,reminder,started_on,total_completed)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    const putLog = db.prepare("INSERT INTO habit_logs(habit_id,day,amount,completed) VALUES(?,?,?,?)");
    for (const habit of entries) {
      const id = crypto.randomUUID();
      putHabit.run(id, userId, habit.name, habit.icon, habit.image, habit.category, habit.target, habit.unit, habit.step, habit.reminder, habit.startedOn, habit.totalCompleted);
      for (const log of habit.logs) putLog.run(id, log.day, log.amount, log.completed ? 1 : 0);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function progressSummary(habits, today) {
  const list = Object.values(habits).map(habit => {
    const goal = Math.max(1, Number(habit.target) || 1);
    const amount = Math.min(goal, Number(habit.dailyTotals?.[today]) || 0);
    return { name: habit.name, amount, goal, unit: habit.unit || "times", remaining: Math.max(0, goal - amount) };
  });
  const done = list.filter(item => !item.remaining).length;
  return { list, done };
}
function localCoachAnswer(question, habits, today) {
  const { list, done } = progressSummary(habits, today);
  const next = list.filter(item => item.remaining).sort((a, b) => b.amount / b.goal - a.amount / a.goal)[0];
  if (!list.length) return "You haven't added a habit yet. Pick one that matters to you and set a small daily target.";
  if (/miss|forgot|skip/i.test(question)) return `It's okay to miss a day; your progress isn't erased. You've completed ${done} of ${list.length} goals today.${next ? ` Try one small step toward ${next.name} (${next.remaining} ${next.unit} left).` : " You've reached all today's goals."}`;
  if (/streak/i.test(question)) return `You've completed ${done} of ${list.length} goals today. ${next ? `Your next step is ${next.name}: ${next.remaining} ${next.unit} left.` : "You're all caught up today."}`;
  if (/progress|goal|how many|status|track/i.test(question)) return `Today's progress: ${done} of ${list.length} goals complete. ${list.map(item => item.remaining ? `${item.name}: ${item.amount}/${item.goal} ${item.unit}` : `${item.name}: complete`).join(" · ")}.`;
  return next ? `You're ${Math.round(next.amount / next.goal * 100)}% through ${next.name}. ${next.remaining} ${next.unit} left. Try a small step now, and I'll update your progress.` : "You've completed all today's goals. Take a moment to enjoy that progress.";
}
async function openAiCoachAnswer(question, habits, today) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const summary = progressSummary(habits, today);
  const prompt = `The user's question is: ${question}\nTheir habit progress today (JSON): ${JSON.stringify(summary)}\nGive one warm, concise, practical coaching reply tied to their actual progress. Do not shame the user or invent completed activity. Do not provide medical advice.`;
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST", headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: process.env.OPENAI_MODEL || "gpt-4.1-mini", input: prompt, max_output_tokens: 180, store: false })
  });
  if (!response.ok) throw new Error("AI coach request failed");
  const data = await response.json();
  const text = (data.output || []).flatMap(item => item.content || []).filter(part => part.type === "output_text").map(part => part.text).join("\n").trim();
  return text.slice(0, 1200) || null;
}

const authAttempts = new Map();
function allowAttempt(key) {
  const now = Date.now();
  const record = authAttempts.get(key);
  if (!record || now - record.started > 15 * 60 * 1000) { authAttempts.set(key, { started: now, count: 1 }); return true; }
  record.count++;
  return record.count <= 12;
}

async function handleApi(req, res, url) {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) validateOrigin(req);
  const pathname = url.pathname;
  if (req.method === "GET" && pathname === "/api/health") return json(res, 200, { ok: true });

  if (req.method === "POST" && (pathname === "/api/register" || pathname === "/api/login")) {
    const ip = req.socket.remoteAddress || "unknown";
    if (!allowAttempt(`${ip}:${pathname}`)) return json(res, 429, { error: "Too many attempts. Please wait a few minutes." });
    const body = await readBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!isEmail(email)) fail(400, "Enter a valid email address.");
    if (password.length > 128) fail(400, "Password is too long.");
    if (pathname === "/api/register") {
      const name = String(body.name || "").trim().slice(0, 60);
      if (!name) fail(400, "Enter your name.");
      if (password.length < 8) fail(400, "Use a password with at least 8 characters.");
      if (getUserByEmail.get(email)) fail(409, "An account with this email already exists. Try signing in.");
      const salt = crypto.randomBytes(16);
      const passwordHash = await scrypt(password, salt, 64);
      const id = crypto.randomUUID();
      try {
        db.prepare("INSERT INTO users(id,name,email,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?)").run(id, name, email, salt, passwordHash, new Date().toISOString());
      } catch { fail(409, "An account with this email already exists. Try signing in."); }
      createSession(id, res, req);
      return json(res, 201, { user: { id, name, email } });
    }
    const user = getUserByEmail.get(email);
    if (!user) fail(401, "Email or password is incorrect.");
    const passwordHash = await scrypt(password, user.password_salt, 64);
    if (!crypto.timingSafeEqual(passwordHash, user.password_hash)) fail(401, "Email or password is incorrect.");
    createSession(user.id, res, req);
    return json(res, 200, { user: { id: user.id, name: user.name, email: user.email } });
  }

  if (req.method === "POST" && pathname === "/api/logout") {
    const token = cookieValue(req, COOKIE_NAME);
    if (token) deleteSession.run(hashToken(token));
    clearSessionCookie(res, req);
    return json(res, 200, { ok: true });
  }

  const user = requireUser(req);
  if (req.method === "GET" && pathname === "/api/me") return json(res, 200, { user: { id: user.id, name: user.name, email: user.email } });
  if (req.method === "GET" && pathname === "/api/habits") return json(res, 200, { habits: toClientHabits(user.id) });
  if (req.method === "PUT" && pathname === "/api/habits") {
    const body = await readBody(req);
    replaceHabits(user.id, body.habits);
    return json(res, 200, { habits: toClientHabits(user.id) });
  }
  if (req.method === "POST" && pathname === "/api/coach") {
    const body = await readBody(req);
    const question = String(body.question || "").trim().slice(0, 500);
    const today = validDay(body.today) ? body.today : new Date().toISOString().slice(0, 10);
    const habits = toClientHabits(user.id);
    let answer;
    try { answer = await openAiCoachAnswer(question, habits, today); } catch (error) { console.error(error.message); }
    return json(res, 200, { answer: answer || localCoachAnswer(question, habits, today), aiEnabled: Boolean(process.env.OPENAI_API_KEY) });
  }
  return json(res, 404, { error: "API route not found." });
}

function serveStatic(req, res, url) {
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return json(res, 400, { error: "Invalid path." }); }
  if (pathname === "/") pathname = "/index.html";
  if (pathname === "/js/backend-config.js") {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
    return res.end("window.THE_GRIND_API_ENABLED = true;");
  }
  const target = path.resolve(PUBLIC_DIR, `.${pathname}`);
  const relative = path.relative(PUBLIC_DIR, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return json(res, 403, { error: "Not allowed." });
  fs.stat(target, (error, stat) => {
    if (error || !stat.isFile()) return json(res, 404, { error: "Page not found." });
    res.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(target).toLowerCase()] || "application/octet-stream", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin" });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(target).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Method not allowed." });
    return serveStatic(req, res, url);
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    return json(res, status, { error: status >= 500 ? "Something went wrong on the server." : error.message });
  }
});

setInterval(() => db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now()), 60 * 60 * 1000).unref();
server.listen(PORT, "0.0.0.0", () => console.log(`The Grind is running on http://localhost:${PORT}`));
