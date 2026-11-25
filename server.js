import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomInt, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import bcrypt from "bcryptjs";
import nodemailer from "nodemailer";

const root = path.dirname(fileURLToPath(import.meta.url));

function loadEnvFile() {
  const file = path.join(root, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadEnvFile();

const port = Number(process.env.PORT || 3000);
const databasePath = path.resolve(root, process.env.DATABASE_PATH || "./data/academicbuddy.sqlite");
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const db = new DatabaseSync(databasePath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    avatar_id TEXT NOT NULL DEFAULT 'avatar-1',
    email_verified_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS verification_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    login_on_verify INTEGER NOT NULL DEFAULT 0,
    provider TEXT,
    provider_user_id TEXT
  );
  CREATE TABLE IF NOT EXISTS oauth_accounts (
    provider TEXT NOT NULL,
    provider_user_id TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (provider, provider_user_id)
  );
  CREATE TABLE IF NOT EXISTS oauth_states (
    state_hash TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    code_verifier TEXT,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS oauth_pending (
    token_hash TEXT PRIMARY KEY,
    provider_user_id TEXT NOT NULL,
    full_name TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    due_date TEXT,
    completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tasks_user_due_date ON tasks(user_id, due_date, completed);
  CREATE TABLE IF NOT EXISTS grades (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    assessment TEXT NOT NULL,
    score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 10000),
    max_score INTEGER NOT NULL DEFAULT 100 CHECK (max_score BETWEEN 1 AND 10000),
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS grades_user_created_at ON grades(user_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS grade_subjects (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject TEXT NOT NULL COLLATE NOCASE,
    max_score INTEGER NOT NULL CHECK (max_score BETWEEN 1 AND 10000),
    PRIMARY KEY (user_id, subject)
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS reset_expiry ON password_reset_tokens(expires_at);
`);
if (!db.prepare("PRAGMA table_info(users)").all().some((column) => column.name === "avatar_id")) {
  db.exec("ALTER TABLE users ADD COLUMN avatar_id TEXT NOT NULL DEFAULT 'avatar-1'");
}
if (!db.prepare("PRAGMA table_info(tasks)").all().some((column) => column.name === "criteria")) {
  db.exec("ALTER TABLE tasks ADD COLUMN criteria TEXT NOT NULL DEFAULT ''");
}
if (!db.prepare("PRAGMA table_info(grades)").all().some((column) => column.name === "max_score")) {
  db.exec("ALTER TABLE grades ADD COLUMN max_score INTEGER NOT NULL DEFAULT 100 CHECK (max_score BETWEEN 1 AND 100)");
}
const gradeSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'grades'").get().sql;
if (/score\s+BETWEEN\s+0\s+AND\s+100\b/i.test(gradeSchema)) {
  db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE grades_new (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subject TEXT NOT NULL,
      assessment TEXT NOT NULL,
      score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 10000),
      max_score INTEGER NOT NULL DEFAULT 100 CHECK (max_score BETWEEN 1 AND 10000),
      created_at TEXT NOT NULL
    );
    INSERT INTO grades_new (id, user_id, subject, assessment, score, max_score, created_at)
      SELECT id, user_id, subject, assessment, score, max_score, created_at FROM grades;
    DROP TABLE grades;
    ALTER TABLE grades_new RENAME TO grades;
    CREATE INDEX grades_user_created_at ON grades(user_id, created_at DESC);
    COMMIT;
  `);
}
if (!db.prepare("PRAGMA table_info(grades)").all().some((column) => column.name === "criterion")) {
  db.exec("ALTER TABLE grades ADD COLUMN criterion TEXT NOT NULL DEFAULT ''");
}
if (!db.prepare("PRAGMA table_info(grades)").all().some((column) => column.name === "task_id")) {
  db.exec("ALTER TABLE grades ADD COLUMN task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL");
}
db.exec(`
  INSERT OR IGNORE INTO grade_subjects (user_id, subject, max_score)
  SELECT user_id, subject, max_score FROM grades ORDER BY created_at DESC, id DESC
`);
const verificationColumns = db.prepare("PRAGMA table_info(verification_tokens)").all().map((column) => column.name);
if (!verificationColumns.includes("login_on_verify")) {
  db.exec("ALTER TABLE verification_tokens ADD COLUMN login_on_verify INTEGER NOT NULL DEFAULT 0");
}
if (!verificationColumns.includes("provider")) {
  db.exec("ALTER TABLE verification_tokens ADD COLUMN provider TEXT");
}
if (!verificationColumns.includes("provider_user_id")) {
  db.exec("ALTER TABLE verification_tokens ADD COLUMN provider_user_id TEXT");
}

const smtpPort = Number(process.env.SMTP_PORT);
const mailReady = Boolean(
  process.env.SMTP_HOST &&
    Number.isInteger(smtpPort) &&
    smtpPort > 0 &&
    smtpPort <= 65535 &&
    process.env.EMAIL_FROM &&
    Boolean(process.env.SMTP_USER) === Boolean(process.env.SMTP_PASS)
);
const mailer = mailReady
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: smtpPort,
      secure: process.env.SMTP_SECURE === "true",
      requireTLS: Boolean(process.env.SMTP_USER && process.env.SMTP_PASS),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      disableFileAccess: true,
      disableUrlAccess: true,
      ...(process.env.SMTP_USER && process.env.SMTP_PASS
        ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } }
        : {}),
    })
  : null;
const aiProvider = process.env.AI_PROVIDER || "openai-compatible";
if (!["openai-compatible", "ollama"].includes(aiProvider)) {
  throw new Error("AI_PROVIDER must be openai-compatible or ollama.");
}
const isLocalAi = aiProvider === "ollama";
const aiApiUrl = new URL(isLocalAi
  ? process.env.AI_OLLAMA_URL || "http://127.0.0.1:11434/v1/chat/completions"
  : process.env.AI_API_URL || "https://api.openai.com/v1/chat/completions");
const aiApiKey = isLocalAi ? "" : process.env.AI_API_KEY || "";
const aiModel = process.env.AI_MODEL || "";
const aiReady = Boolean(aiModel && (isLocalAi || aiApiKey));
const crossrefWorksUrl = process.env.CROSSREF_API_URL || "https://api.crossref.org/works";
const crossrefEndpoint = new URL(crossrefWorksUrl);
if (crossrefEndpoint.protocol !== "https:" &&
    !(crossrefEndpoint.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(crossrefEndpoint.hostname) &&
      process.env.NODE_ENV !== "production")) {
  throw new Error("CROSSREF_API_URL must use HTTPS (HTTP is allowed for localhost development).");
}
const wikimediaApiUrl = process.env.NODE_ENV === "test" && process.env.WIKIMEDIA_API_URL
  ? new URL(process.env.WIKIMEDIA_API_URL)
  : new URL("https://commons.wikimedia.org/w/api.php");
if (wikimediaApiUrl.protocol !== "https:" &&
    !(process.env.NODE_ENV === "test" && wikimediaApiUrl.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(wikimediaApiUrl.hostname))) {
  throw new Error("WIKIMEDIA_API_URL must use HTTPS (HTTP is allowed for localhost tests).");
}
if (isLocalAi && !["localhost", "127.0.0.1", "::1"].includes(aiApiUrl.hostname)) {
  throw new Error("AI_OLLAMA_URL must point to a local Ollama server.");
}
if (aiApiUrl.protocol !== "https:" &&
    !(aiApiUrl.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(aiApiUrl.hostname))) {
  throw new Error("AI_API_URL must use HTTPS (HTTP is allowed for localhost development).");
}
const baseUrl = (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, "");
const isProduction = process.env.NODE_ENV === "production";
function oauthEndpoint(envKey, fallback) {
  const endpoint = new URL(process.env[envKey] || fallback);
  if (endpoint.protocol !== "https:" &&
      !(endpoint.protocol === "http:" && !isProduction && ["localhost", "127.0.0.1", "::1"].includes(endpoint.hostname))) {
    throw new Error(`${envKey} must use HTTPS (HTTP is allowed for localhost development).`);
  }
  return endpoint.toString();
}
const oauthProviders = {
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    authorizationUrl: oauthEndpoint("GOOGLE_AUTHORIZATION_URL", "https://accounts.google.com/o/oauth2/v2/auth"),
    tokenUrl: oauthEndpoint("GOOGLE_TOKEN_URL", "https://oauth2.googleapis.com/token"),
    userInfoUrl: oauthEndpoint("GOOGLE_USERINFO_URL", "https://openidconnect.googleapis.com/v1/userinfo"),
  },
  x: {
    clientId: process.env.X_CLIENT_ID || "",
    clientSecret: process.env.X_CLIENT_SECRET || "",
    authorizationUrl: oauthEndpoint("X_AUTHORIZATION_URL", "https://twitter.com/i/oauth2/authorize"),
    tokenUrl: oauthEndpoint("X_TOKEN_URL", "https://api.x.com/2/oauth2/token"),
    userInfoUrl: oauthEndpoint("X_USERINFO_URL", "https://api.x.com/2/users/me?user.fields=name,username"),
  },
};
for (const provider of Object.values(oauthProviders)) {
  provider.enabled = Boolean(provider.clientId && provider.clientSecret && mailReady);
}
const limits = new Map();
const maxBodyBytes = 16 * 1024;
const sessionCookie = "academicbuddy_session";
const dummyPasswordHash = "$2b$12$RSCldfVLGHRdU7zmWbG5c.p0MlDedaTZkJ2DON9iZLMibC8X4L9ke";

if (!["http:", "https:"].includes(new URL(baseUrl).protocol) ||
    (isProduction && new URL(baseUrl).protocol !== "https:")) {
  throw new Error("BASE_URL must be an HTTP(S) URL and must use HTTPS in production.");
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function withTransaction(operation) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function newToken() {
  return randomBytes(32).toString("base64url");
}

function sendJson(res, status, value, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(value));
}

function setCookie(res, token, maxAge) {
  const age = maxAge ? `; Max-Age=${maxAge}` : "";
  const secure = isProduction ? "; Secure" : "";
  appendCookie(res, `${sessionCookie}=${token}; Path=/; HttpOnly; SameSite=Lax${age}${secure}`);
}

function clearCookie(res) {
  const secure = isProduction ? "; Secure" : "";
  appendCookie(res, `${sessionCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

function appendCookie(res, value) {
  const existing = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", existing ? [...(Array.isArray(existing) ? existing : [existing]), value] : value);
}

function oauthCookieName(provider) {
  return `academicbuddy_oauth_${provider}`;
}

function requestCookie(req, name) {
  const value = req.headers.cookie || "";
  const part = value.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
  return part ? part.slice(name.length + 1) : null;
}

function setOAuthCookie(res, provider, state) {
  const secure = isProduction ? "; Secure" : "";
  appendCookie(res, `${oauthCookieName(provider)}=${state}; Path=/auth/oauth/${provider}/callback; HttpOnly; SameSite=Lax; Max-Age=600${secure}`);
}

function clearOAuthCookie(res, provider) {
  const secure = isProduction ? "; Secure" : "";
  appendCookie(res, `${oauthCookieName(provider)}=; Path=/auth/oauth/${provider}/callback; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

function clientIp(req) {
  return req.socket.remoteAddress || "unknown";
}

function rateLimited(req, key, max, windowMs) {
  const now = Date.now();
  const bucketKey = `${key}:${clientIp(req)}`;
  const attempts = (limits.get(bucketKey) || []).filter((time) => now - time < windowMs);
  if (attempts.length >= max) {
    limits.set(bucketKey, attempts);
    return true;
  }
  attempts.push(now);
  limits.set(bucketKey, attempts);
  if (limits.size > 2000) {
    for (const [storedKey, storedAttempts] of limits) {
      if (!storedAttempts.length || now - storedAttempts.at(-1) > 60 * 60 * 1000) limits.delete(storedKey);
    }
  }
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        tooLarge = true;
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      if (tooLarge) return reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
      if (!body) return resolve({});
      if (!req.headers["content-type"]?.startsWith("application/json")) {
        return reject(Object.assign(new Error("Expected a JSON request."), { status: 415 }));
      }
      try {
        const parsed = JSON.parse(body);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error("Invalid JSON request."), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

function cookieToken(req) {
  const cookie = req.headers.cookie || "";
  const value = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${sessionCookie}=`));
  return value ? value.slice(sessionCookie.length + 1) : null;
}

function currentUser(req) {
  const token = cookieToken(req);
  if (!token || token.length > 200) return null;
  const session = db.prepare(`
    SELECT users.id, users.full_name, users.email, users.avatar_id, users.email_verified_at, sessions.expires_at
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?
  `).get(hashToken(token));
  if (!session) return null;
  if (session.expires_at <= Date.now() || !session.email_verified_at) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
    return null;
  }
  return { id: session.id, name: session.full_name, email: session.email, avatarId: session.avatar_id };
}

function validEmail(value) {
  if (typeof value !== "string" || value.length > 254) return false;
  const [local, domain, extra] = value.split("@");
  return !extra &&
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) &&
    !local.startsWith(".") &&
    !local.endsWith(".") &&
    !local.includes("..") &&
    /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(domain);
}

function validPassword(value) {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") >= 10 &&
    Buffer.byteLength(value, "utf8") <= 72;
}

function validAvatarId(value) {
  return typeof value === "string" && /^avatar-[1-9]$/.test(value);
}

function isCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function sourceRecord(item) {
  const doi = typeof item?.DOI === "string" ? item.DOI : "";
  const dateParts = item?.published?.["date-parts"]?.[0] || item?.issued?.["date-parts"]?.[0] || [];
  const authorNames = Array.isArray(item?.author)
    ? item.author.slice(0, 4).map((author) => [author.given, author.family].filter(Boolean).join(" ")).filter(Boolean)
    : [];
  return {
    title: Array.isArray(item?.title) ? item.title[0] || "Untitled work" : "Untitled work",
    authors: authorNames,
    year: Number.isInteger(dateParts[0]) ? dateParts[0] : null,
    publisher: typeof item?.publisher === "string" ? item.publisher : "",
    publication: Array.isArray(item?.["container-title"]) ? item["container-title"][0] || "" : "",
    type: typeof item?.type === "string" ? item.type.replaceAll("-", " ") : "work",
    doi,
    url: doi ? `https://doi.org/${encodeURIComponent(doi).replaceAll("%2F", "/")}` : "",
    abstract: typeof item?.abstract === "string" ? item.abstract.slice(0, 5000) : "",
  };
}

const ignoredSourceTerms = new Set([
    "about", "after", "also", "and", "are", "can", "does", "for", "from",
    "chat", "could", "explain", "good", "great", "hello", "hey", "help",
    "how", "into", "its", "just", "know", "me", "more", "need", "okay",
    "please", "really", "research", "search", "show", "some", "sources",
    "study", "tell", "thank", "thanks", "that", "the", "their", "there",
    "this", "through", "understand", "when", "where", "which", "who", "why",
    "will", "with", "would", "you", "your",
]);

function sourceQueryTerms(query) {
  return [...new Set(String(query).toLowerCase().match(/[a-z0-9]{3,}/g) || [])]
    .filter((term) => !ignoredSourceTerms.has(term));
}

function sourceCompatibility(query, source) {
  const terms = sourceQueryTerms(query);
  const titleWords = new Set(String(source.title).toLowerCase().match(/[a-z0-9]+/g) || []);
  const otherWords = new Set(
    `${source.abstract || ""} ${source.publication || ""} ${source.publisher || ""}`
      .toLowerCase().match(/[a-z0-9]+/g) || [],
  );
  const points = terms.reduce((total, term) =>
    total + (titleWords.has(term) ? 2 : otherWords.has(term) ? 1 : 0), 0);
  const score = terms.length ? Math.round(points / (terms.length * 2) * 100) : 0;
  return {
    level: score >= 60 ? "high" : score >= 30 ? "medium" : "low",
    score,
  };
}

const crossrefCache = new Map();
const crossrefPending = new Map();
async function fetchCrossref(url) {
  const cached = crossrefCache.get(url);
  if (cached?.expiresAt > Date.now()) return { data: cached.data };
  if (crossrefPending.has(url)) return crossrefPending.get(url);
  const request = fetchCrossrefUncached(url);
  crossrefPending.set(url, request);
  try {
    const result = await request;
    if (result.data) {
      if (crossrefCache.size >= 100) crossrefCache.delete(crossrefCache.keys().next().value);
      crossrefCache.set(url, { data: result.data, expiresAt: Date.now() + 2 * 60 * 1000 });
    }
    return result;
  } finally {
    crossrefPending.delete(url);
  }
}

async function fetchCrossrefUncached(url) {
  let response;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      response = await fetch(url, {
        headers: { "User-Agent": "AcademicBuddy/1.0 (student research search)" },
        signal: AbortSignal.timeout(8000),
      });
      if (attempt || ![429, 503].includes(response.status)) break;
      const retryAfter = response.headers.get("retry-after");
      const seconds = retryAfter === null ? 1 : Number(retryAfter);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 2) break;
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    }
  } catch (error) {
    console.error("Crossref request failed:", error.name);
    return { error: "Source search is temporarily unavailable. Please try again." };
  }
  if (!response.ok) {
    console.error("Crossref returned an unsuccessful response:", response.status);
    if (response.status === 429) return { error: "Crossref is receiving too many requests. Please wait a moment and try again." };
    return { error: "Source search is temporarily unavailable. Please try again." };
  }
  try {
    const data = await response.json();
    return { data };
  } catch (error) {
    console.error("Crossref returned invalid JSON:", error.message);
    return { error: "Source search returned an invalid response. Please try again." };
  }
}

async function fetchSearchSuggestion(query) {
  const params = new URLSearchParams({
    action: "query",
    list: "search",
    srsearch: query,
    srinfo: "suggestion",
    srlimit: "1",
    format: "json",
    formatversion: "2",
  });
  try {
    const response = await fetch(`https://en.wikipedia.org/w/api.php?${params}`, {
      headers: { "User-Agent": "AcademicBuddy/1.0 (student research website)" },
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const suggestion = data?.query?.searchinfo?.suggestion;
    return {
      suggestion: typeof suggestion === "string" && suggestion.length <= 200 &&
        suggestion.trim().toLowerCase() !== query.toLowerCase() ? suggestion.trim() : null,
      suggestionUnavailable: false,
    };
  } catch (error) {
    console.error("Wikipedia spelling suggestion request failed:", error.message);
    return { suggestion: null, suggestionUnavailable: true };
  }
}

const wikimediaPhotoCache = new Map();
async function fetchWikimediaPhotos(limit = 8, searchQuery = "") {
  if (limit <= 0) return [];
  const query = String(searchQuery).trim().replace(/\s+/g, " ").slice(0, 200);
  const cacheKey = query.toLowerCase() || "__recent_featured_photos__";
  const cached = wikimediaPhotoCache.get(cacheKey);
  if (cached?.expiresAt > Date.now()) {
    wikimediaPhotoCache.delete(cacheKey);
    wikimediaPhotoCache.set(cacheKey, cached);
    return cached.photos.slice(0, limit);
  }
  const params = new URLSearchParams(query ? {
    action: "query",
    generator: "search",
    gsrsearch: `${query} filetype:bitmap`,
    gsrnamespace: "6",
    gsrlimit: String(Math.min(50, Math.max(10, limit * 5))),
    prop: "imageinfo",
    iiprop: "url|mime|size",
    iiurlwidth: "1200",
    format: "json",
    formatversion: "2",
  } : {
    action: "query",
    generator: "categorymembers",
    gcmtitle: "Category:Featured pictures on Wikimedia Commons",
    gcmnamespace: "6",
    gcmtype: "file",
    gcmlimit: "50",
    prop: "imageinfo",
    iiprop: "url|mime|size",
    iiurlwidth: "1200",
    format: "json",
    formatversion: "2",
  });
  let response;
  try {
    const url = new URL(wikimediaApiUrl);
    url.search = params;
    response = await fetch(url, {
      headers: { "User-Agent": "AcademicBuddy/1.0 (student research website)" },
      signal: AbortSignal.timeout(6000),
    });
  } catch (error) {
    console.error("Wikimedia Commons request failed:", error.name);
    return [];
  }
  if (!response.ok) {
    console.error("Wikimedia Commons returned an unsuccessful response:", response.status);
    return [];
  }
  let data;
  try {
    data = await response.json();
  } catch (error) {
    console.error("Wikimedia Commons returned invalid JSON:", error.message);
    return [];
  }
  const pages = Array.isArray(data?.query?.pages) ? data.query.pages : [];
  const seenPhotoUrls = new Set();
  const photos = pages
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .flatMap((page) => {
      const image = page.imageinfo?.[0];
      if (!image || !["image/jpeg", "image/webp"].includes(image.mime)) return [];
      try {
        const thumbnailUrl = new URL(image.thumburl || image.url);
        const pageUrl = new URL(image.descriptionurl);
        if (thumbnailUrl.protocol !== "https:" ||
            !["thumb.wikimedia.org", "upload.wikimedia.org"].includes(thumbnailUrl.hostname) ||
            pageUrl.protocol !== "https:" || pageUrl.hostname !== "commons.wikimedia.org") {
          return [];
        }
        if (seenPhotoUrls.has(thumbnailUrl.toString())) return [];
        seenPhotoUrls.add(thumbnailUrl.toString());
        const originalUrl = new URL(image.url);
        const fallbackUrl = originalUrl.protocol === "https:" &&
          originalUrl.hostname === "upload.wikimedia.org" &&
          Number.isFinite(image.size) && image.size <= 8 * 1024 * 1024 &&
          originalUrl.toString() !== thumbnailUrl.toString()
          ? originalUrl.toString()
          : null;
        return [{
          url: thumbnailUrl.toString(),
          fallbackUrl,
          pageUrl: pageUrl.toString(),
          title: typeof page.title === "string" ? page.title.replace(/^File:/, "") : "Wikimedia Commons photo",
        }];
      } catch {
        return [];
      }
    });
  if (wikimediaPhotoCache.size >= 24) {
    wikimediaPhotoCache.delete(wikimediaPhotoCache.keys().next().value);
  }
  wikimediaPhotoCache.set(cacheKey, { expiresAt: Date.now() + 6 * 60 * 60 * 1000, photos });
  return photos.slice(0, limit);
}

function attachWikimediaPhotos(sources, photos) {
  return sources.map((source, index) => ({
    ...source,
    image: photos[index] || null,
  }));
}

function shuffledPhotos(photos) {
  const shuffled = [...photos];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function issueSession(userId, remember) {
  const token = newToken();
  const duration = remember ? 30 * 24 * 60 * 60 * 1000 : 8 * 60 * 60 * 1000;
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(hashToken(token), userId, Date.now() + duration);
  return { token, maxAge: remember ? duration / 1000 : null };
}

async function sendEmail({ to, subject, text }) {
  if (!mailer) throw new Error("SMTP email delivery is not configured.");
  await mailer.sendMail({ from: process.env.EMAIL_FROM, to, subject, text });
}

function redirect(res, location) {
  res.writeHead(303, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

async function fetchOAuthJson(url, options) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    console.error("OAuth provider request failed:", error.name);
    throw new Error("The sign-in provider is temporarily unavailable.");
  }
  if (!response.ok) {
    console.error("OAuth provider returned an unsuccessful response:", response.status);
    throw new Error("The sign-in provider could not complete the request.");
  }
  try {
    return await response.json();
  } catch (error) {
    console.error("OAuth provider returned invalid JSON:", error.message);
    throw new Error("The sign-in provider returned an invalid response.");
  }
}

async function sendOAuthVerification(user, provider, providerUserId) {
  const token = newToken();
  const tokenHash = hashToken(token);
  withTransaction(() => {
    db.prepare("DELETE FROM verification_tokens WHERE user_id = ?").run(user.id);
    db.prepare(`
      INSERT INTO verification_tokens
        (token_hash, user_id, expires_at, login_on_verify, provider, provider_user_id)
      VALUES (?, ?, ?, 1, ?, ?)
    `).run(tokenHash, user.id, Date.now() + 24 * 60 * 60 * 1000, provider, providerUserId);
  });
  try {
    await sendEmail({
      to: user.email,
      subject: "Confirm your AcademicBuddy sign-in",
      text: `Hi ${user.full_name},\n\nConfirm your email and finish signing in to AcademicBuddy within 24 hours:\n${baseUrl}/login?verify=${token}\n\nIf you did not try to sign in, you can ignore this email.`,
    });
  } catch (error) {
    db.prepare("DELETE FROM verification_tokens WHERE token_hash = ?").run(tokenHash);
    console.error("Social sign-in confirmation email failed:", error.message);
    throw new Error("We could not send the confirmation email. Please check the email configuration and try again.");
  }
}

async function findOrCreateOAuthUser(fullName, email) {
  let user = db.prepare("SELECT id, full_name, email, email_verified_at FROM users WHERE email = ?").get(email);
  if (user) return user;
  const passwordHash = await bcrypt.hash(newToken(), 12);
  try {
    const result = db.prepare(`
      INSERT INTO users (full_name, email, password_hash, avatar_id, created_at)
      VALUES (?, ?, ?, 'avatar-1', ?)
    `).run(fullName, email, passwordHash, new Date().toISOString());
    user = db.prepare("SELECT id, full_name, email, email_verified_at FROM users WHERE id = ?")
      .get(Number(result.lastInsertRowid));
    return user;
  } catch (error) {
    if (!String(error.message).includes("UNIQUE")) throw error;
    user = db.prepare("SELECT id, full_name, email, email_verified_at FROM users WHERE email = ?").get(email);
    if (!user) throw error;
    return user;
  }
}

async function completeOAuthEmail(provider, providerUserId, fullName, email) {
  const user = await findOrCreateOAuthUser(fullName, email);
  await sendOAuthVerification(user, provider, providerUserId);
}

function oauthErrorRedirect(error) {
  const allowed = new Set(["cancelled", "invalid", "provider", "email"]);
  return `/login?oauth_error=${allowed.has(error) ? error : "provider"}`;
}

async function startOAuth(req, res, provider) {
  const config = oauthProviders[provider];
  if (!config?.enabled) {
    res.writeHead(501, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(`<!doctype html><title>Social sign-in unavailable</title><p>${provider === "x" ? "X" : "Google"} sign-in is not configured yet. Add provider credentials and email delivery settings to enable it.</p><p><a href="/login">Return to AcademicBuddy</a></p>`);
    return;
  }
  if (rateLimited(req, `oauth-${provider}`, 10, 15 * 60 * 1000)) {
    return redirect(res, oauthErrorRedirect("provider"));
  }
  const state = newToken();
  const verifier = newToken();
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  db.prepare("DELETE FROM oauth_states WHERE expires_at <= ?").run(Date.now());
  db.prepare("DELETE FROM oauth_pending WHERE expires_at <= ?").run(Date.now());
  db.prepare("INSERT INTO oauth_states (state_hash, provider, code_verifier, expires_at) VALUES (?, ?, ?, ?)")
    .run(hashToken(state), provider, verifier, Date.now() + 10 * 60 * 1000);
  setOAuthCookie(res, provider, state);

  const authorizationUrl = new URL(config.authorizationUrl);
  authorizationUrl.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: `${baseUrl}/auth/oauth/${provider}/callback`,
    response_type: "code",
    scope: provider === "google" ? "openid email profile" : "users.read",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(provider === "google" ? { prompt: "select_account" } : {}),
  }).toString();
  res.writeHead(302, { Location: authorizationUrl.toString(), "Cache-Control": "no-store" });
  res.end();
}

async function finishOAuth(req, res, url, provider) {
  const state = url.searchParams.get("state") || "";
  const oauthState = db.prepare(`
    SELECT state_hash, code_verifier FROM oauth_states
    WHERE state_hash = ? AND provider = ? AND expires_at > ?
  `).get(hashToken(state), provider, Date.now());
  const cookieState = requestCookie(req, oauthCookieName(provider));
  clearOAuthCookie(res, provider);
  if (!state || state.length > 200 || !oauthState || cookieState !== state) {
    if (oauthState) db.prepare("DELETE FROM oauth_states WHERE state_hash = ?").run(oauthState.state_hash);
    return redirect(res, oauthErrorRedirect("invalid"));
  }
  db.prepare("DELETE FROM oauth_states WHERE state_hash = ?").run(oauthState.state_hash);
  if (url.searchParams.has("error")) return redirect(res, oauthErrorRedirect("cancelled"));
  const code = url.searchParams.get("code") || "";
  if (!code || code.length > 2000) return redirect(res, oauthErrorRedirect("invalid"));

  const config = oauthProviders[provider];
  const redirectUri = `${baseUrl}/auth/oauth/${provider}/callback`;
  try {
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: oauthState.code_verifier,
      client_id: config.clientId,
      ...(provider === "google" ? { client_secret: config.clientSecret } : {}),
    });
    const tokenResponse = await fetchOAuthJson(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(provider === "x"
          ? { Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}` }
          : {}),
      },
      body: tokenBody,
    });
    if (typeof tokenResponse.access_token !== "string" || tokenResponse.access_token.length > 4000) {
      throw new Error("The sign-in provider returned an invalid access token.");
    }
    const profile = await fetchOAuthJson(config.userInfoUrl, {
      headers: { Authorization: `Bearer ${tokenResponse.access_token}` },
    });

    if (provider === "google") {
      const email = typeof profile.email === "string" ? profile.email.trim().toLowerCase() : "";
      if (typeof profile.sub !== "string" || !profile.sub || profile.sub.length > 200 ||
          profile.email_verified !== true ||
          !validEmail(email)) {
        return redirect(res, oauthErrorRedirect("email"));
      }
      const linked = db.prepare(`
        SELECT users.id, users.full_name, users.email, users.email_verified_at
        FROM oauth_accounts JOIN users ON users.id = oauth_accounts.user_id
        WHERE oauth_accounts.provider = 'google' AND oauth_accounts.provider_user_id = ?
      `).get(profile.sub);
      if (linked) {
        if (!linked.email_verified_at) {
          await sendOAuthVerification(linked, "google", profile.sub);
          return redirect(res, "/login?oauth=confirmation-sent");
        }
        const session = issueSession(linked.id, false);
        setCookie(res, session.token, session.maxAge);
        return redirect(res, "/dashboard");
      }
      const fullName = typeof profile.name === "string" && profile.name.trim()
        ? profile.name.trim().slice(0, 100)
        : "AcademicBuddy student";
      await completeOAuthEmail("google", profile.sub, fullName, email);
      return redirect(res, "/login?oauth=confirmation-sent");
    }

    const providerUserId = typeof profile?.data?.id === "string" ? profile.data.id : "";
    const fullName = typeof profile?.data?.name === "string"
      ? profile.data.name.slice(0, 100)
      : typeof profile?.data?.username === "string"
        ? profile.data.username.slice(0, 100)
        : "";
    if (!providerUserId || !fullName || providerUserId.length > 200) {
      throw new Error("The sign-in provider returned an invalid profile.");
    }
    const linked = db.prepare(`
      SELECT users.id, users.full_name, users.email, users.email_verified_at
      FROM oauth_accounts JOIN users ON users.id = oauth_accounts.user_id
      WHERE oauth_accounts.provider = 'x' AND oauth_accounts.provider_user_id = ?
    `).get(providerUserId);
    if (linked) {
      if (!linked.email_verified_at) {
        await sendOAuthVerification(linked, "x", providerUserId);
        return redirect(res, "/login?oauth=confirmation-sent");
      }
      const session = issueSession(linked.id, false);
      setCookie(res, session.token, session.maxAge);
      return redirect(res, "/dashboard");
    }
    const pendingToken = newToken();
    db.prepare("INSERT INTO oauth_pending (token_hash, provider_user_id, full_name, expires_at) VALUES (?, ?, ?, ?)")
      .run(hashToken(pendingToken), providerUserId, fullName, Date.now() + 10 * 60 * 1000);
    return redirect(res, `/login?oauth_pending=${encodeURIComponent(pendingToken)}`);
  } catch (error) {
    console.error("OAuth sign-in failed:", error.message);
    return redirect(res, oauthErrorRedirect(error.message.includes("email") ? "email" : "provider"));
  }
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  if (route === "GET /api/config") {
    return sendJson(res, 200, {
      emailConfigured: mailReady,
      aiConfigured: aiReady,
      aiProvider,
      socialProviders: { google: oauthProviders.google.enabled, x: oauthProviders.x.enabled },
      socialLoginAvailable: Object.values(oauthProviders).some((provider) => provider.enabled),
    });
  }
  if (route === "GET /api/me") {
    const user = currentUser(req);
    return user ? sendJson(res, 200, { user }) : sendJson(res, 401, { error: "Please log in to continue." });
  }

  if (url.pathname === "/api/tasks") {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: "Please log in to continue." });
    if (req.method === "GET") {
      const tasks = db.prepare(`
        SELECT id, title, subject, due_date AS dueDate, completed, criteria
        FROM tasks WHERE user_id = ?
        ORDER BY completed ASC, due_date IS NULL ASC, due_date ASC, id DESC
      `).all(user.id).map((task) => ({ ...task, completed: Boolean(task.completed), criteria: task.criteria ? task.criteria.split(",") : [] }));
      return sendJson(res, 200, { tasks });
    }
    if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed." }, { Allow: "GET, POST" });
    if (!checkOrigin(req)) return sendJson(res, 403, { error: "Request origin was not accepted." });
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      return sendJson(res, error.status || 400, { error: error.message || "Invalid request." });
    }
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const subject = typeof body.subject === "string" ? body.subject.trim() : "";
    const dueDate = body.dueDate === "" || body.dueDate == null ? null : body.dueDate;
    const criteria = body.criteria === undefined ? [] : body.criteria;
    if (!Array.isArray(criteria) || criteria.some((value) => !["A", "B", "C", "D"].includes(value)) ||
        new Set(criteria).size !== criteria.length) {
      return sendJson(res, 400, { error: "Select each assessment criterion only once: A, B, C, or D." });
    }
    if (!title || title.length > 120 || subject.length > 80 ||
        (dueDate !== null && !isCalendarDate(dueDate))) {
      return sendJson(res, 400, { error: "Enter a task title up to 120 characters, a subject up to 80 characters, and a valid due date." });
    }
    const result = db.prepare(`
      INSERT INTO tasks (user_id, title, subject, due_date, criteria, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(user.id, title, subject, dueDate, criteria.join(","), new Date().toISOString());
    return sendJson(res, 201, {
      task: {
        id: Number(result.lastInsertRowid),
        title,
        subject,
        dueDate,
        completed: false,
        criteria,
      },
    });
  }

  if (url.pathname === "/api/grade-subjects") {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: "Please log in to continue." });
    if (req.method === "GET") {
      const subjects = db.prepare("SELECT subject, max_score AS maxScore FROM grade_subjects WHERE user_id = ? ORDER BY subject COLLATE NOCASE").all(user.id);
      return sendJson(res, 200, { subjects });
    }
    if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed." }, { Allow: "GET, POST" });
    if (!checkOrigin(req)) return sendJson(res, 403, { error: "Request origin was not accepted." });
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      return sendJson(res, error.status || 400, { error: error.message || "Invalid request." });
    }
    const subject = typeof body.subject === "string" ? body.subject.trim() : "";
    const maxScore = body.maxScore;
    if (!subject || subject.length > 60 || !Number.isInteger(maxScore) || maxScore < 1 || maxScore > 10000) {
      return sendJson(res, 400, { error: "Enter a subject and a whole-number maximum from 1 to 10000." });
    }
    db.prepare(`
      INSERT INTO grade_subjects (user_id, subject, max_score) VALUES (?, ?, ?)
      ON CONFLICT(user_id, subject) DO UPDATE SET max_score = excluded.max_score
    `).run(user.id, subject, maxScore);
    const saved = db.prepare("SELECT subject, max_score AS maxScore FROM grade_subjects WHERE user_id = ? AND subject = ?").get(user.id, subject);
    return sendJson(res, 200, { subject: saved });
  }

  if (url.pathname === "/api/grades") {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: "Please log in to continue." });
    if (req.method === "GET") {
      const grades = db.prepare(`
        SELECT id, subject, assessment, score, max_score AS maxScore, criterion, task_id AS taskId
        FROM grades WHERE user_id = ? ORDER BY created_at DESC, id DESC
      `).all(user.id);
      return sendJson(res, 200, { grades });
    }
    if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed." }, { Allow: "GET, POST" });
    if (!checkOrigin(req)) return sendJson(res, 403, { error: "Request origin was not accepted." });
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      return sendJson(res, error.status || 400, { error: error.message || "Invalid request." });
    }
    const subject = typeof body.subject === "string" ? body.subject.trim() : "";
    const assessment = typeof body.assessment === "string" ? body.assessment.trim() : "";
    const criterion = typeof body.criterion === "string" ? body.criterion.trim() : "";
    let taskId = body.taskId == null ? null : body.taskId;
    const createCalendarTask = body.createCalendarTask === true;
    const dueDate = body.dueDate == null || body.dueDate === "" ? null : body.dueDate;
    const score = typeof body.score === "number"
      ? body.score
      : typeof body.score === "string" && /^\d{1,5}$/.test(body.score)
        ? Number(body.score)
        : NaN;
    const maxScore = typeof body.maxScore === "number"
      ? body.maxScore
      : typeof body.maxScore === "string" && /^\d{1,5}$/.test(body.maxScore)
        ? Number(body.maxScore)
        : body.maxScore == null
          ? 100
          : NaN;
    if (criterion !== "" && !["A", "B", "C", "D"].includes(criterion)) {
      return sendJson(res, 400, { error: "Choose criterion A, B, C, or D." });
    }
    if ((body.createCalendarTask !== undefined && typeof body.createCalendarTask !== "boolean") ||
        (createCalendarTask && (taskId !== null || !criterion)) ||
        (dueDate !== null && (!createCalendarTask || !isCalendarDate(dueDate)))) {
      return sendJson(res, 400, { error: "Enter a valid calendar date for a new assessment, or link an existing task." });
    }
    if (!subject || subject.length > 60 || !assessment || assessment.length > 120 ||
        !Number.isInteger(maxScore) || maxScore < 1 || maxScore > 10000 ||
        !Number.isInteger(score) || score < 0 || score > maxScore ||
        (taskId !== null && (!Number.isSafeInteger(taskId) || taskId < 1))) {
      return sendJson(res, 400, { error: "Enter a subject, assessment, and a whole-number score from 0 up to the selected maximum (1–10000)." });
    }
    if (taskId !== null) {
      const task = db.prepare("SELECT subject, criteria FROM tasks WHERE id = ? AND user_id = ?").get(taskId, user.id);
      if (!task || task.subject.trim().toLowerCase() !== subject.toLowerCase()) {
        return sendJson(res, 400, { error: "Choose one of your tasks for this subject." });
      }
      if (task.criteria && !task.criteria.split(",").includes(criterion)) {
        return sendJson(res, 400, { error: "Choose a criterion selected for this task." });
      }
    }
    const createdAt = new Date().toISOString();
    let result;
    db.exec("BEGIN");
    try {
      if (createCalendarTask) {
        const task = db.prepare(`
          INSERT INTO tasks (user_id, title, subject, due_date, criteria, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(user.id, assessment, subject, dueDate, criterion, createdAt);
        taskId = Number(task.lastInsertRowid);
      }
      result = db.prepare(`
        INSERT INTO grades (user_id, subject, assessment, score, max_score, criterion, task_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(user.id, subject, assessment, score, maxScore, criterion, taskId, createdAt);
      db.prepare("INSERT OR IGNORE INTO grade_subjects (user_id, subject, max_score) VALUES (?, ?, ?)").run(user.id, subject, maxScore);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return sendJson(res, 201, {
      grade: { id: Number(result.lastInsertRowid), subject, assessment, score, maxScore, criterion, taskId },
    });
  }

  const gradeRoute = url.pathname.match(/^\/api\/grades\/(\d+)$/);
  if (gradeRoute) {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: "Please log in to continue." });
    if (req.method !== "DELETE") {
      return sendJson(res, 405, { error: "Method not allowed." }, { Allow: "DELETE" });
    }
    if (!checkOrigin(req)) return sendJson(res, 403, { error: "Request origin was not accepted." });
    const result = db.prepare("DELETE FROM grades WHERE id = ? AND user_id = ?").run(Number(gradeRoute[1]), user.id);
    return result.changes ? sendJson(res, 200, { deleted: true }) : sendJson(res, 404, { error: "Grade not found." });
  }

  const taskRoute = url.pathname.match(/^\/api\/tasks\/(\d+)$/);
  if (taskRoute) {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: "Please log in to continue." });
    if (!["PATCH", "DELETE"].includes(req.method)) {
      return sendJson(res, 405, { error: "Method not allowed." }, { Allow: "PATCH, DELETE" });
    }
    if (!checkOrigin(req)) return sendJson(res, 403, { error: "Request origin was not accepted." });
    const taskId = Number(taskRoute[1]);
    if (req.method === "DELETE") {
      const result = db.prepare("DELETE FROM tasks WHERE id = ? AND user_id = ?").run(taskId, user.id);
      return result.changes ? sendJson(res, 200, { deleted: true }) : sendJson(res, 404, { error: "Task not found." });
    }
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      return sendJson(res, error.status || 400, { error: error.message || "Invalid request." });
    }
    const allowedFields = new Set(["title", "subject", "dueDate", "completed", "criteria"]);
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).length === 0 || Object.keys(body).some((field) => !allowedFields.has(field))) {
      return sendJson(res, 400, { error: "Update the task title, subject, due date, or completion status." });
    }
    const task = db.prepare(`
      SELECT id, title, subject, due_date AS dueDate, completed, criteria
      FROM tasks WHERE id = ? AND user_id = ?
    `).get(taskId, user.id);
    if (!task) return sendJson(res, 404, { error: "Task not found." });

    const title = Object.hasOwn(body, "title")
      ? typeof body.title === "string" ? body.title.trim() : ""
      : task.title;
    const subject = Object.hasOwn(body, "subject")
      ? typeof body.subject === "string" ? body.subject.trim() : null
      : task.subject;
    const dueDate = Object.hasOwn(body, "dueDate")
      ? body.dueDate === "" || body.dueDate === null ? null : body.dueDate
      : task.dueDate;
    const completed = Object.hasOwn(body, "completed") ? body.completed : Boolean(task.completed);
    const criteria = Object.hasOwn(body, "criteria") ? body.criteria : task.criteria ? task.criteria.split(",") : [];
    if (!Array.isArray(criteria) || criteria.some((value) => !["A", "B", "C", "D"].includes(value)) ||
        new Set(criteria).size !== criteria.length) {
      return sendJson(res, 400, { error: "Select each assessment criterion only once: A, B, C, or D." });
    }
    if (!title || title.length > 120 || subject === null || subject.length > 80 ||
        (dueDate !== null && !isCalendarDate(dueDate)) ||
        (Object.hasOwn(body, "completed") && typeof body.completed !== "boolean")) {
      return sendJson(res, 400, { error: "Enter a task title up to 120 characters, a subject up to 80 characters, and a valid due date." });
    }
    db.prepare(`
      UPDATE tasks SET title = ?, subject = ?, due_date = ?, completed = ?, criteria = ?
      WHERE id = ? AND user_id = ?
    `).run(title, subject, dueDate, Number(completed), criteria.join(","), taskId, user.id);
    return sendJson(res, 200, {
      completed,
      task: { id: taskId, title, subject, dueDate, completed, criteria },
    });
  }

  if (url.pathname === "/api/sources/recent" && req.method === "GET") {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: "Please log in to continue." });
    if (rateLimited(req, "source-recent", 60, 15 * 60 * 1000)) {
      return sendJson(res, 429, { error: "Too many recent-source requests. Please try again later." });
    }
    const today = new Date();
    const since = new Date(today.valueOf() - 30 * 24 * 60 * 60 * 1000);
    const params = new URLSearchParams({
      filter: `from-pub-date:${since.toISOString().slice(0, 10)},until-pub-date:${today.toISOString().slice(0, 10)}`,
      sort: "published",
      order: "desc",
      rows: "8",
      select: "title,author,published,issued,DOI,URL,publisher,type,container-title,abstract",
    });
    const contact = process.env.CROSSREF_MAILTO?.trim() || "";
    if (validEmail(contact)) params.set("mailto", contact);
    const result = await fetchCrossref(`${crossrefWorksUrl}?${params}`);
    if (result.error) return sendJson(res, 502, { error: result.error });
    const items = result.data?.message?.items;
    if (!Array.isArray(items)) {
      return sendJson(res, 502, { error: "Recent sources returned an invalid response. Please try again." });
    }
    const photos = shuffledPhotos(await fetchWikimediaPhotos(50));
    const sources = attachWikimediaPhotos(items.map(sourceRecord), photos);
    return sendJson(res, 200, {
      sources,
      photoCount: sources.filter((source) => source.image).length,
    });
  }

  if (url.pathname === "/api/sources" && req.method === "GET") {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: "Please log in to continue." });
    if (rateLimited(req, "source-search", 60, 15 * 60 * 1000)) {
      return sendJson(res, 429, { error: "Too many searches. Please try again later." });
    }
    const doi = url.searchParams.get("doi")?.trim() || "";
    const query = url.searchParams.get("q")?.trim() || "";
    let crossrefUrl;
    if (doi) {
      if (!/^10\.\d{4,9}\/\S{1,200}$/i.test(doi)) {
        return sendJson(res, 400, { error: "Enter a valid DOI." });
      }
      if (query.length > 200) {
        return sendJson(res, 400, { error: "Search topic must be 200 characters or fewer." });
      }
      const params = new URLSearchParams();
      const contact = process.env.CROSSREF_MAILTO?.trim() || "";
      if (validEmail(contact)) params.set("mailto", contact);
      crossrefUrl = `${crossrefWorksUrl}/${encodeURIComponent(doi)}${params.size ? `?${params}` : ""}`;
    } else {
      if (!query || query.length > 200) {
        return sendJson(res, 400, { error: "Enter a search topic up to 200 characters." });
      }
      const params = new URLSearchParams({
        "query.bibliographic": query,
        rows: "10",
        select: "title,author,published,issued,DOI,URL,publisher,type,container-title,abstract",
      });
      const contact = process.env.CROSSREF_MAILTO?.trim() || "";
      if (validEmail(contact)) params.set("mailto", contact);
      crossrefUrl = `${crossrefWorksUrl}?${params}`;
    }
    const result = await fetchCrossref(crossrefUrl);
    if (result.error) return sendJson(res, 502, { error: result.error });
    if (doi) {
      const item = result.data?.message;
      if (!item) return sendJson(res, 404, { error: "That source was not found in Crossref." });
      const sourceRecordItem = sourceRecord(item);
      if (query) sourceRecordItem.compatibility = sourceCompatibility(query, sourceRecordItem);
      const source = attachWikimediaPhotos(
        [sourceRecordItem],
        await fetchWikimediaPhotos(1, sourceRecordItem.title),
      )[0];
      return sendJson(res, 200, { source });
    }
    const items = result.data?.message?.items;
    if (!Array.isArray(items)) return sendJson(res, 502, { error: "Source search returned an invalid response. Please try again." });
    if (!items.length) {
      return sendJson(res, 200, { sources: [], ...await fetchSearchSuggestion(query) });
    }
    const sources = attachWikimediaPhotos(items.map((item) => {
      const source = sourceRecord(item);
      source.compatibility = sourceCompatibility(query, source);
      return source;
    }), await fetchWikimediaPhotos(items.length, query));
    return sendJson(res, 200, { sources });
  }

  if (route === "POST /api/chat") {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: "Please log in to continue." });
    if (rateLimited(req, "chat", 30, 15 * 60 * 1000)) {
      return sendJson(res, 429, { error: "Too many messages. Please take a break and try again later." });
    }
    if (!checkOrigin(req)) return sendJson(res, 403, { error: "Request origin was not accepted." });
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      return sendJson(res, error.status || 400, { error: error.message || "Invalid request." });
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!aiReady) return sendJson(res, 503, { error: "Chat Buddy is not configured yet. Ask your site administrator to set up the AI service." });
    if (messages.length < 1 || messages.length > 12 || messages.some((message) =>
      !message || !["user", "assistant"].includes(message.role) ||
      typeof message.content !== "string" || !message.content.trim() || message.content.length > 2000
    ) || messages.at(-1)?.role !== "user") {
      return sendJson(res, 400, { error: "Send a study question up to 2,000 characters." });
    }
    let response;
    try {
      response = await fetch(aiApiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(aiApiKey ? { Authorization: `Bearer ${aiApiKey}` } : {}),
        },
        body: JSON.stringify({
          model: aiModel,
          temperature: 0.5,
          max_tokens: 600,
          messages: [
            {
              role: "system",
              content: "You are AcademicBuddy, a warm, patient study coach for students aged 11–18. Answer directly in one or two concise paragraphs, usually under 80 words. Use simple, age-appropriate language and avoid repetition or filler. For a learning question, explain the key idea and offer one useful example, hint, or next step. If a request is unclear, ask one focused question; respond to greetings naturally and briefly. Do not write assignments for students or request personal information. Do not include source lists, citations, references, or URLs; when asked for sources, direct the student to Search / Sources.",
            },
            ...messages,
          ],
        }),
        signal: AbortSignal.timeout(isLocalAi ? 90_000 : 20_000),
      });
    } catch (error) {
      console.error("AI provider request failed:", error.name);
      const timedOut = error.name === "TimeoutError";
      return sendJson(res, timedOut ? 504 : 502, {
        error: timedOut
          ? "Chat Buddy took too long to reply. Please try again."
          : isLocalAi
            ? "Ollama could not be reached. Start the Ollama app and try again."
            : "Chat Buddy is temporarily unavailable. Please try again.",
      });
    }
    if (!response.ok) {
      console.error("AI provider returned an unsuccessful response:", response.status);
      if (isLocalAi && response.status === 404) {
        return sendJson(res, 502, { error: `The local model is not downloaded yet. Run: ollama pull ${aiModel}` });
      }
      if (isLocalAi && response.status === 429) {
        return sendJson(res, 502, { error: "Ollama is busy loading the local model. Wait a moment and try again." });
      }
      return sendJson(res, 502, { error: "Chat Buddy could not reply right now. Please try again." });
    }
    try {
      const result = await response.json();
      const reply = result?.choices?.[0]?.message?.content;
      if (typeof reply !== "string" || !reply.trim() || reply.length > 8000) {
        console.error("AI provider returned an invalid chat response.");
        return sendJson(res, 502, { error: "Chat Buddy returned an invalid reply. Please try again." });
      }
      return sendJson(res, 200, { reply: reply.trim() });
    } catch (error) {
      console.error("Could not read the AI provider response:", error.message);
      return sendJson(res, 502, { error: "Chat Buddy returned an invalid reply. Please try again." });
    }
  }

  if (!route.startsWith("POST /api/auth/")) return false;
  if (!checkOrigin(req)) return sendJson(res, 403, { error: "Request origin was not accepted." });
  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    return sendJson(res, error.status || 400, { error: error.message || "Invalid request." });
  }

  if (route === "POST /api/auth/oauth/complete") {
    if (rateLimited(req, "oauth-email", 5, 15 * 60 * 1000)) {
      return sendJson(res, 429, { error: "Too many attempts. Please try again later." });
    }
    const token = typeof body.token === "string" ? body.token : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (token.length > 200 || !validEmail(email)) {
      return sendJson(res, 400, { error: "Enter a valid email address to continue." });
    }
    const pending = db.prepare("SELECT provider_user_id, full_name FROM oauth_pending WHERE token_hash = ? AND expires_at > ?")
      .get(hashToken(token), Date.now());
    if (!pending) return sendJson(res, 400, { error: "This sign-in has expired. Please start again." });
    try {
      await completeOAuthEmail("x", pending.provider_user_id, pending.full_name, email);
      db.prepare("DELETE FROM oauth_pending WHERE token_hash = ?").run(hashToken(token));
      return sendJson(res, 200, { message: "Check your email to confirm your X sign-in." });
    } catch (error) {
      console.error("Could not complete X sign-in:", error.message);
      return sendJson(res, 503, { error: "We could not send the confirmation email. Please try again." });
    }
  }

  if (route === "POST /api/auth/signup") {
    if (rateLimited(req, "signup", 20, 60 * 60 * 1000)) {
      return sendJson(res, 429, { error: "Too many signup attempts. Please try again later." });
    }
    if (!mailReady) {
      return sendJson(res, 503, { error: "Email delivery is not configured. Signup is unavailable until SMTP is set up." });
    }
    const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const avatarId = body.avatarId === undefined ? "avatar-1" : body.avatarId;
    if (fullName.length < 2 || fullName.length > 100 || !validEmail(email) ||
        !validPassword(body.password) || !validAvatarId(avatarId)) {
      return sendJson(res, 400, { error: "Enter a name, valid email, password of 10 to 72 bytes, and choose one of the available profile pictures." });
    }
    const confirmationToken = newToken();
    let userId;
    const passwordHash = await bcrypt.hash(body.password, 12);
    try {
      userId = withTransaction(() => {
        const result = db.prepare(`
          INSERT INTO users (full_name, email, password_hash, avatar_id, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(fullName, email, passwordHash, avatarId, new Date().toISOString());
        const createdUserId = Number(result.lastInsertRowid);
        db.prepare("INSERT INTO verification_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
          .run(hashToken(confirmationToken), createdUserId, Date.now() + 24 * 60 * 60 * 1000);
        return createdUserId;
      });
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) {
        return sendJson(res, 409, { error: "An account with that email already exists." });
      }
      console.error("Could not create account:", error);
      return sendJson(res, 500, { error: "We could not create your account. Please try again." });
    }
    try {
      await sendEmail({
        to: email,
        subject: "Verify your AcademicBuddy email",
        text: `Hi ${fullName},\n\nVerify your email within 24 hours:\n${baseUrl}/login?verify=${confirmationToken}\n\nIf you did not create an account, you can ignore this email.`,
      });
    } catch (error) {
      db.prepare("DELETE FROM users WHERE id = ? AND email_verified_at IS NULL").run(userId);
      console.error("Verification email delivery failed:", error.message);
      return sendJson(res, 503, { error: "We could not send the verification email. Check the email configuration and try again." });
    }
    return sendJson(res, 201, { message: "Account created. Check your email to verify your account before logging in." });
  }

  if (route === "POST /api/auth/login") {
    if (rateLimited(req, "login", 10, 15 * 60 * 1000)) {
      return sendJson(res, 429, { error: "Too many login attempts. Please try again later." });
    }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const user = validEmail(email)
      ? db.prepare("SELECT id, full_name, email, avatar_id, password_hash, email_verified_at FROM users WHERE email = ?").get(email)
      : null;
    const passwordMatches = await bcrypt.compare(
      typeof body.password === "string" && Buffer.byteLength(body.password, "utf8") <= 72 ? body.password : "invalid-password",
      user?.password_hash || dummyPasswordHash
    ).catch(() => false);
    if (!user || !passwordMatches) return sendJson(res, 401, { error: "Email or password is incorrect." });
    if (!user.email_verified_at) return sendJson(res, 403, { error: "Please verify your email before logging in." });
    const session = issueSession(user.id, body.remember === true);
    setCookie(res, session.token, session.maxAge);
    return sendJson(res, 200, { user: { name: user.full_name, email: user.email, avatarId: user.avatar_id } });
  }

  if (route === "POST /api/auth/logout") {
    const token = cookieToken(req);
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
    clearCookie(res);
    return sendJson(res, 200, { message: "You have been logged out." });
  }

  if (route === "POST /api/auth/verify") {
    const token = typeof body.token === "string" ? body.token : "";
    if (token.length > 200) return sendJson(res, 400, { error: "This verification link is invalid or has expired." });
    const pending = db.prepare(`
      SELECT users.id, users.full_name, users.email, verification_tokens.token_hash,
        verification_tokens.login_on_verify, verification_tokens.provider, verification_tokens.provider_user_id
      FROM verification_tokens JOIN users ON users.id = verification_tokens.user_id
      WHERE verification_tokens.token_hash = ? AND verification_tokens.expires_at > ?
    `).get(hashToken(token), Date.now());
    if (!pending) return sendJson(res, 400, { error: "This verification link is invalid or has expired." });
    try {
      withTransaction(() => {
        if (pending.provider && pending.provider_user_id) {
          db.prepare(`
            INSERT INTO oauth_accounts (provider, provider_user_id, user_id, created_at)
            VALUES (?, ?, ?, ?)
          `).run(pending.provider, pending.provider_user_id, pending.id, new Date().toISOString());
        }
        db.prepare("UPDATE users SET email_verified_at = ? WHERE id = ?")
          .run(new Date().toISOString(), pending.id);
        db.prepare("DELETE FROM verification_tokens WHERE user_id = ?").run(pending.id);
      });
    } catch (error) {
      console.error("Could not verify account or link OAuth identity:", error.message);
      return sendJson(res, 400, { error: "This verification link is invalid or the sign-in is already connected to another account." });
    }
    if (pending.login_on_verify) {
      const session = issueSession(pending.id, false);
      setCookie(res, session.token, session.maxAge);
    }
    let welcomeEmailSent = false;
    try {
      await sendEmail({
        to: pending.email,
        subject: "Welcome to AcademicBuddy",
        text: `Hi ${pending.full_name},\n\nYour email is verified and your AcademicBuddy account is ready. Welcome!`,
      });
      welcomeEmailSent = true;
    } catch (error) {
      console.error("Welcome email delivery failed:", error.message);
    }
    return sendJson(res, 200, {
      message: welcomeEmailSent
        ? "Your email is verified. Welcome to AcademicBuddy!"
        : "Your email is verified. We could not deliver the welcome email, but you can now log in.",
      welcomeEmailSent,
      redirectTo: pending.login_on_verify ? "/dashboard" : undefined,
    });
  }

  if (route === "POST /api/auth/resend-verification") {
    if (rateLimited(req, "resend-verification", 5, 60 * 60 * 1000)) {
      return sendJson(res, 429, { error: "Too many requests. Please try again later." });
    }
    if (!mailReady) return sendJson(res, 503, { error: "Email delivery is not configured. Verification email is unavailable." });
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!validEmail(email)) return sendJson(res, 400, { error: "Enter a valid email address." });
    const user = db.prepare("SELECT id, full_name, email FROM users WHERE email = ? AND email_verified_at IS NULL").get(email);
    if (user) {
      const token = newToken();
      const tokenHash = hashToken(token);
      db.prepare("INSERT INTO verification_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
        .run(tokenHash, user.id, Date.now() + 24 * 60 * 60 * 1000);
      try {
        await sendEmail({
          to: email,
          subject: "Verify your AcademicBuddy email",
          text: `Hi ${user.full_name},\n\nVerify your email within 24 hours:\n${baseUrl}/login?verify=${token}\n\nIf you did not create an account, you can ignore this email.`,
        });
        db.prepare("DELETE FROM verification_tokens WHERE user_id = ? AND token_hash != ?").run(user.id, tokenHash);
      } catch (error) {
        db.prepare("DELETE FROM verification_tokens WHERE token_hash = ?").run(tokenHash);
        console.error("Verification email delivery failed:", error.message);
        return sendJson(res, 503, { error: "We could not send the verification email. Check the email configuration and try again." });
      }
    }
    return sendJson(res, 200, { message: "If an unverified account matches that email, a verification link has been sent." });
  }

  if (route === "POST /api/auth/forgot-password") {
    if (rateLimited(req, "forgot-password", 5, 60 * 60 * 1000)) {
      return sendJson(res, 429, { error: "Too many requests. Please try again later." });
    }
    if (!mailReady) return sendJson(res, 503, { error: "Password reset is unavailable until email delivery is configured." });
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!validEmail(email)) return sendJson(res, 400, { error: "Enter a valid email address." });
    const user = db.prepare("SELECT id, full_name, email FROM users WHERE email = ? AND email_verified_at IS NOT NULL").get(email);
    if (user) {
      const token = newToken();
      withTransaction(() => {
        db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(user.id);
        db.prepare("INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
          .run(hashToken(token), user.id, Date.now() + 60 * 60 * 1000);
      });
      try {
        await sendEmail({
          to: email,
          subject: "Reset your AcademicBuddy password",
          text: `Hi ${user.full_name},\n\nReset your password within one hour:\n${baseUrl}/login?reset=${token}\n\nIf you did not request this, you can ignore this email.`,
        });
      } catch (error) {
        db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(user.id);
        console.error("Password reset email delivery failed:", error.message);
        return sendJson(res, 503, { error: "We could not send a password-reset email. Please try again later." });
      }
    }
    return sendJson(res, 200, { message: "If a verified account matches that email, a password-reset link has been sent." });
  }

  if (route === "POST /api/auth/reset-password") {
    if (rateLimited(req, "reset-password", 10, 60 * 60 * 1000)) {
      return sendJson(res, 429, { error: "Too many password-reset attempts. Please try again later." });
    }
    const token = typeof body.token === "string" ? body.token : "";
    if (token.length > 200 || !validPassword(body.password)) {
      return sendJson(res, 400, { error: "Choose a password of 10 to 72 bytes and use a valid reset link." });
    }
    const passwordHash = await bcrypt.hash(body.password, 12);
    const reset = db.prepare("SELECT user_id FROM password_reset_tokens WHERE token_hash = ? AND expires_at > ?")
      .get(hashToken(token), Date.now());
    if (!reset) return sendJson(res, 400, { error: "This password-reset link is invalid or has expired." });
    withTransaction(() => {
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, reset.user_id);
      db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(reset.user_id);
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(reset.user_id);
    });
    return sendJson(res, 200, { message: "Password updated. You can now log in with your new password." });
  }

  return false;
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(res, 405, { error: "Method not allowed." }, { Allow: "GET, HEAD" });
  }
  const protectedPaths = new Set([
    "/dashboard",
    "/grades",
    "/how-to-use",
    "/search",
    "/sources",
    "/search-sources",
    "/source-information",
    "/about",
    "/chat-buddy",
    "/calendar",
  ]);
  const isProtectedPage = protectedPaths.has(url.pathname);
  if (isProtectedPage && !currentUser(req)) {
    res.writeHead(303, { Location: "/login", "Cache-Control": "no-store" });
    res.end();
    return;
  }
  const appRoute = url.pathname === "/" ||
    url.pathname === "/login" ||
    url.pathname === "/signup" ||
    isProtectedPage;
  const requested = appRoute ? "/index.html" : url.pathname;
  const isAvatar = /^\/avatars\/avatar-[1-9]\.svg$/.test(requested);
  const isSourceArt = /^\/source-art\/(?:article|book|report|mission|graduation-cap|chat-buddy|about-research|about-thinking|about-planning)\.svg$/.test(requested);
  if (!["/index.html", "/style.css", "/script.js"].includes(requested) && !isAvatar && !isSourceArt) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end("Not found");
    return;
  }
  const file = path.join(root, requested.slice(1));
  res.writeHead(200, {
    "Content-Type": mimeTypes[path.extname(file)],
    "Cache-Control": isProtectedPage ? "no-store" : "no-cache",
  });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data: https://thumb.wikimedia.org https://upload.wikimedia.org; connect-src 'self'; base-uri 'none'; form-action 'self' https://www.google.com; frame-ancestors 'none'");
  if (isProduction) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    return sendJson(res, 400, { error: "Invalid request URL." });
  }
  try {
    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, url);
      if (handled === false && !res.headersSent) sendJson(res, 404, { error: "Not found." });
      return;
    }
    const oauth = url.pathname.match(/^\/auth\/oauth\/(google|x)(\/callback)?$/);
    if (oauth && req.method === "GET") {
      if (oauth[2]) await finishOAuth(req, res, url, oauth[1]);
      else await startOAuth(req, res, oauth[1]);
      return;
    }
    serveStatic(req, res, url);
  } catch (error) {
    console.error("Request failed:", error);
    if (!res.headersSent) sendJson(res, 500, { error: "An unexpected error occurred. Please try again." });
    else res.destroy();
  }
});

db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
db.prepare("DELETE FROM verification_tokens WHERE expires_at <= ?").run(Date.now());
db.prepare("DELETE FROM password_reset_tokens WHERE expires_at <= ?").run(Date.now());
db.prepare("DELETE FROM oauth_states WHERE expires_at <= ?").run(Date.now());
db.prepare("DELETE FROM oauth_pending WHERE expires_at <= ?").run(Date.now());

server.listen(port, () => {
  const address = server.address();
  console.log(`AcademicBuddy listening on http://localhost:${typeof address === "object" ? address.port : port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
