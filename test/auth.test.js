import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { SMTPServer } from "smtp-server";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function availablePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startApp(port, databasePath, smtpPort, {
  production = false,
  baseUrl: configuredBaseUrl,
  aiProvider = "",
  aiOllamaUrl = "",
  aiApiUrl = "",
  aiApiKey = "",
  aiModel = "",
  crossrefApiUrl = "",
  wikimediaApiUrl = "",
  googleClientId = "",
  googleClientSecret = "",
  xClientId = "",
  xClientSecret = "",
  googleAuthorizationUrl = "",
  googleTokenUrl = "",
  googleUserInfoUrl = "",
  xAuthorizationUrl = "",
  xTokenUrl = "",
  xUserInfoUrl = "",
} = {}) {
  const requestUrl = `http://127.0.0.1:${port}`;
  const baseUrl = configuredBaseUrl || requestUrl;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: production ? "production" : "test",
      PORT: String(port),
      BASE_URL: baseUrl,
      DATABASE_PATH: databasePath,
      SMTP_HOST: smtpPort ? "127.0.0.1" : "",
      SMTP_PORT: smtpPort ? String(smtpPort) : "",
      SMTP_SECURE: "false",
      SMTP_USER: "",
      SMTP_PASS: "",
      EMAIL_FROM: smtpPort ? "AcademicBuddy test <noreply@example.test>" : "",
      AI_PROVIDER: aiProvider,
      AI_OLLAMA_URL: aiOllamaUrl,
      AI_API_URL: aiApiUrl,
      AI_API_KEY: aiApiKey,
      AI_MODEL: aiModel,
      CROSSREF_API_URL: crossrefApiUrl,
      WIKIMEDIA_API_URL: wikimediaApiUrl,
      GOOGLE_CLIENT_ID: googleClientId,
      GOOGLE_CLIENT_SECRET: googleClientSecret,
      X_CLIENT_ID: xClientId,
      X_CLIENT_SECRET: xClientSecret,
      GOOGLE_AUTHORIZATION_URL: googleAuthorizationUrl,
      GOOGLE_TOKEN_URL: googleTokenUrl,
      GOOGLE_USERINFO_URL: googleUserInfoUrl,
      X_AUTHORIZATION_URL: xAuthorizationUrl,
      X_TOKEN_URL: xTokenUrl,
      X_USERINFO_URL: xUserInfoUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`App did not start: ${output}`)), 10_000);
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("AcademicBuddy listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`App exited with ${code}: ${output}`));
    });
  });
  return {
    child,
    baseUrl,
    requestUrl,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

async function post(baseUrl, route, body, cookie) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  return {
    response,
    body: await response.json(),
    cookie: response.headers.get("set-cookie")?.split(";")[0],
  };
}

function tokenFromEmail(raw, kind) {
  const decoded = raw.replace(/=\r?\n/g, "").replace(/=3D/gi, "=");
  const match = decoded.match(new RegExp(`[?&]${kind}=([A-Za-z0-9_-]+)`));
  assert.ok(match, `expected a ${kind} link in SMTP message`);
  return match[1];
}

test("signup, verification, session, logout, reset, and unconfigured OAuth behavior work end-to-end", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "academicbuddy-auth-"));
  const databasePath = path.join(tempDir, "test.sqlite");
  const appPort = await availablePort();
  const smtpMessages = [];
  let aiServer;
  const aiRequests = [];
  const crossrefQueries = [];
  let biologyAttempts = 0;
  const wikimediaQueries = [];
  const smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS"],
    onData(stream, _session, callback) {
      let raw = "";
      stream.on("data", (chunk) => { raw += chunk.toString(); });
      stream.on("end", () => {
        smtpMessages.push(raw);
        callback(null, "Message accepted");
      });
    },
  });
  await new Promise((resolve, reject) => smtp.listen(0, "127.0.0.1", resolve).once("error", reject));
  const smtpPort = smtp.server.address().port;
  let app;
  t.after(async () => {
    await app?.stop();
    if (aiServer) await new Promise((resolve) => aiServer.close(resolve));
    await new Promise((resolve) => smtp.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  app = await startApp(appPort, databasePath, null);
  const noMailConfig = await fetch(`${app.baseUrl}/api/config`).then((response) => response.json());
  assert.equal(noMailConfig.emailConfigured, false);
  const unavailableSignup = await post(app.baseUrl, "/api/auth/signup", {
    fullName: "Ada Researcher",
    email: "ada@example.test",
    password: "A-good-password-123",
  });
  assert.equal(unavailableSignup.response.status, 503);
  await app.stop();

  app = await startApp(appPort, databasePath, smtpPort);
  const config = await fetch(`${app.baseUrl}/api/config`).then((response) => response.json());
  assert.equal(config.emailConfigured, true);
  assert.equal(config.socialLoginAvailable, false);

  const home = await fetch(app.baseUrl);
  assert.equal(home.status, 200);
  const landingMarkup = await home.text();
  assert.match(landingMarkup, /href="\/signup"/);
  assert.match(landingMarkup, /href="\/login"/);
  for (const illustration of ["article", "book", "report", "mission", "graduation-cap"]) {
    const response = await fetch(`${app.baseUrl}/source-art/${illustration}.svg`);
    assert.equal(response.status, 200, `${illustration} illustration should be served`);
    assert.match(response.headers.get("content-type"), /^image\/svg\+xml/);
    assert.match(await response.text(), /<svg\b/);
  }
  for (const route of ["/dashboard", "/grades", "/how-to-use", "/search", "/sources", "/search-sources", "/source-information", "/about", "/chat-buddy", "/calendar"]) {
    const response = await fetch(`${app.baseUrl}${route}`, { redirect: "manual" });
    assert.equal(response.status, 303, `${route} should require an authenticated session`);
    assert.equal(response.headers.get("location"), "/login");
  }
  assert.equal((await fetch(`${app.baseUrl}/login`)).status, 200);
  assert.equal((await fetch(`${app.baseUrl}/signup`)).status, 200);
  const protectedDashboard = await fetch(`${app.baseUrl}/dashboard`, { redirect: "manual" });
  assert.equal(protectedDashboard.status, 303);
  assert.equal(protectedDashboard.headers.get("location"), "/login");

  const crossOriginRequest = await fetch(`${app.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
    body: JSON.stringify({ email: "ada@example.test", password: "A-good-password-123" }),
  });
  assert.equal(crossOriginRequest.status, 403);

  const invalidSignup = await fetch(`${app.baseUrl}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: app.baseUrl },
    body: JSON.stringify({
      fullName: "Ada Researcher",
      email: "ada@localhost",
      password: "short",
    }),
  });
  assert.equal(invalidSignup.status, 400);
  const invalidAvatarSignup = await post(app.baseUrl, "/api/auth/signup", {
    fullName: "Ada Researcher",
    email: "ada@example.test",
    password: "A-good-password-123",
    avatarId: "avatar-10",
  });
  assert.equal(invalidAvatarSignup.response.status, 400);

  const signup = await post(app.baseUrl, "/api/auth/signup", {
    fullName: "Ada Researcher",
    email: "ADA@example.test",
    password: "A-good-password-123",
    avatarId: "avatar-8",
  });
  assert.equal(signup.response.status, 201);
  assert.match(signup.body.message, /verify your account/i);
  assert.equal(smtpMessages.length, 1);
  const testDb = new DatabaseSync(databasePath);
  const storedPasswordHash = testDb.prepare("SELECT password_hash, avatar_id FROM users WHERE email = ?").get("ada@example.test");
  assert.match(storedPasswordHash.password_hash, /^\$2[aby]\$12\$/);
  assert.notEqual(storedPasswordHash.password_hash, "A-good-password-123");
  assert.equal(storedPasswordHash.avatar_id, "avatar-8");
  testDb.close();
  for (const avatar of ["avatar-7", "avatar-8", "avatar-9"]) {
    const avatarResponse = await fetch(`${app.baseUrl}/avatars/${avatar}.svg`);
    assert.match(avatarResponse.headers.get("content-type"), /^image\/svg\+xml/);
    assert.equal(avatarResponse.status, 200);
  }
  const firstVerifyToken = tokenFromEmail(smtpMessages[0], "verify");

  const resend = await post(app.baseUrl, "/api/auth/resend-verification", { email: "ada@example.test" });
  assert.equal(resend.response.status, 200);
  assert.equal(smtpMessages.length, 2);
  const verifyToken = tokenFromEmail(smtpMessages[1], "verify");
  assert.equal((await post(app.baseUrl, "/api/auth/verify", { token: firstVerifyToken })).response.status, 400);

  const unverifiedLogin = await post(app.baseUrl, "/api/auth/login", {
    email: "ada@example.test",
    password: "A-good-password-123",
  });
  assert.equal(unverifiedLogin.response.status, 403);

  const verified = await post(app.baseUrl, "/api/auth/verify", { token: verifyToken });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.body.welcomeEmailSent, true);
  assert.equal(smtpMessages.length, 3);
  assert.equal((await post(app.baseUrl, "/api/auth/verify", { token: verifyToken })).response.status, 400);

  const duplicate = await post(app.baseUrl, "/api/auth/signup", {
    fullName: "Ada Researcher",
    email: "ada@example.test",
    password: "A-good-password-123",
  });
  assert.equal(duplicate.response.status, 409);

  const login = await post(app.baseUrl, "/api/auth/login", {
    email: "ada@example.test",
    password: "A-good-password-123",
    remember: true,
  });
  assert.equal(login.response.status, 200);
  assert.equal(login.body.user.name, "Ada Researcher");
  assert.equal(login.body.user.avatarId, "avatar-8");
  assert.match(login.cookie, /academicbuddy_session=/);
  assert.match(login.response.headers.get("set-cookie"), /Max-Age=2592000/);

  const calendarPage = await fetch(`${app.baseUrl}/calendar`, { headers: { Cookie: login.cookie } });
  assert.equal(calendarPage.status, 200);
  const calendarMarkup = await calendarPage.text();
  assert.match(calendarMarkup, /id="calendar-days"/);
  assert.match(calendarMarkup, /id="calendar-month-label"/);
  assert.match(calendarMarkup, /id="task-cancel-edit"/);

  const me = await fetch(`${app.baseUrl}/api/me`, { headers: { Cookie: login.cookie } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.name, "Ada Researcher");
  assert.equal((await fetch(`${app.baseUrl}/api/me`, { headers: { Cookie: login.cookie } }).then((response) => response.json())).user.avatarId, "avatar-8");
  assert.equal((await fetch(`${app.baseUrl}/api/tasks`)).status, 401);
  assert.equal((await fetch(`${app.baseUrl}/api/grades`)).status, 401);
  assert.equal((await fetch(`${app.baseUrl}/api/grade-subjects`)).status, 401);
  assert.equal((await fetch(`${app.baseUrl}/api/sources/recent`)).status, 401);
  const taskOriginCheck = await fetch(`${app.baseUrl}/api/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: login.cookie,
      Origin: "https://attacker.example",
    },
    body: JSON.stringify({ title: "Research essay" }),
  });
  assert.equal(taskOriginCheck.status, 403);
  const invalidTask = await fetch(`${app.baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: login.cookie },
    body: JSON.stringify({ title: "Research essay", dueDate: "2026-02-31" }),
  });
  assert.equal(invalidTask.status, 400);
  const createTask = await fetch(`${app.baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: login.cookie },
    body: JSON.stringify({ title: "Research essay", subject: "History", dueDate: "2026-11-20", criteria: ["A", "C"] }),
  });
  assert.equal(createTask.status, 201);
  const savedTask = (await createTask.json()).task;
  assert.equal(savedTask.title, "Research essay");
  assert.equal(savedTask.completed, false);
  const completeTask = await fetch(`${app.baseUrl}/api/tasks/${savedTask.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: login.cookie },
    body: JSON.stringify({ completed: true }),
  });
  assert.equal(completeTask.status, 200);
  assert.equal((await completeTask.json()).completed, true);
  const editTask = await fetch(`${app.baseUrl}/api/tasks/${savedTask.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: login.cookie },
    body: JSON.stringify({ title: "Revised research essay", subject: "Biology", dueDate: "2026-11-21" }),
  });
  assert.equal(editTask.status, 200);
  assert.deepEqual((await editTask.json()).task, {
    id: savedTask.id,
    title: "Revised research essay",
    subject: "Biology",
    dueDate: "2026-11-21",
    completed: true,
    criteria: ["A", "C"],
  });
  const invalidTaskEdit = await fetch(`${app.baseUrl}/api/tasks/${savedTask.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: login.cookie },
    body: JSON.stringify({ dueDate: "2026-02-31" }),
  });
  assert.equal(invalidTaskEdit.status, 400);
  const taskList = await fetch(`${app.baseUrl}/api/tasks`, { headers: { Cookie: login.cookie } });
  assert.deepEqual((await taskList.json()).tasks, [{
    id: savedTask.id,
    title: "Revised research essay",
    subject: "Biology",
    dueDate: "2026-11-21",
    completed: true,
    criteria: ["A", "C"],
  }]);
  const biologySubject = await post(app.baseUrl, "/api/grade-subjects", { subject: "Biology", maxScore: 8 }, login.cookie);
  assert.equal(biologySubject.response.status, 200);
  const historySubject = await post(app.baseUrl, "/api/grade-subjects", { subject: "History", maxScore: 100 }, login.cookie);
  assert.equal(historySubject.response.status, 200);
  const invalidSubject = await post(app.baseUrl, "/api/grade-subjects", { subject: "Art", maxScore: 0 }, login.cookie);
  assert.equal(invalidSubject.response.status, 400);
  const addGrade = await fetch(`${app.baseUrl}/api/grades`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: login.cookie },
    body: JSON.stringify({ subject: "Biology", assessment: "Cell quiz", score: 86 }),
  });
  assert.equal(addGrade.status, 201);
  const savedGrade = (await addGrade.json()).grade;
  assert.deepEqual((await fetch(`${app.baseUrl}/api/grades`, { headers: { Cookie: login.cookie } }).then((response) => response.json())).grades, [savedGrade]);
  const scaledGradeResponse = await fetch(`${app.baseUrl}/api/grades`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: login.cookie },
    body: JSON.stringify({ subject: "Biology", assessment: "Lab report", criterion: "A", score: 7, maxScore: 8, taskId: savedTask.id }),
  });
  assert.equal(scaledGradeResponse.status, 201);
  const scaledGrade = (await scaledGradeResponse.json()).grade;
  assert.equal(scaledGrade.score, 7);
  assert.equal(scaledGrade.maxScore, 8);
  assert.equal(scaledGrade.criterion, "A");
  assert.equal(scaledGrade.taskId, savedTask.id);
  for (const invalid of [
    { subject: "Biology", assessment: "Essay", criterion: "B", score: 7, maxScore: 8, taskId: savedTask.id },
    { subject: "Biology", assessment: "Essay", criterion: "E", score: 7, maxScore: 8 },
    { subject: "History", assessment: "Essay", criterion: "A", score: 7, maxScore: 8, taskId: savedTask.id },
    { subject: "Biology", assessment: "Essay", criterion: "A", score: 7, maxScore: 8, taskId: 999999 },
  ]) {
    assert.equal((await post(app.baseUrl, "/api/grades", invalid, login.cookie)).response.status, 400);
  }
  const invalidCriteria = await post(app.baseUrl, "/api/tasks", { title: "Invalid", criteria: ["A", "E"] }, login.cookie);
  assert.equal(invalidCriteria.response.status, 400);
  const gradeList = (await fetch(`${app.baseUrl}/api/grades`, { headers: { Cookie: login.cookie } }).then((response) => response.json())).grades;
  assert.equal(gradeList.length, 2);
  assert.ok(gradeList.some((grade) => grade.id === savedGrade.id && grade.maxScore === 100));
  assert.ok(gradeList.some((grade) => grade.id === scaledGrade.id && grade.maxScore === 8));
  const invalidGrade = await fetch(`${app.baseUrl}/api/grades`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: login.cookie },
    body: JSON.stringify({ subject: "Biology", assessment: "Cell quiz", score: 101 }),
  });
  assert.equal(invalidGrade.status, 400);
  const scoreOverScale = await fetch(`${app.baseUrl}/api/grades`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: login.cookie },
    body: JSON.stringify({ subject: "Biology", assessment: "Lab report", score: 9, maxScore: 8 }),
  });
  assert.equal(scoreOverScale.status, 400);
  const largerScaleResponse = await fetch(`${app.baseUrl}/api/grades`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: login.cookie },
    body: JSON.stringify({ subject: "Biology", assessment: "Exam", score: 150, maxScore: 200 }),
  });
  assert.equal(largerScaleResponse.status, 201);
  const largerScaleGrade = (await largerScaleResponse.json()).grade;
  assert.equal(largerScaleGrade.score, 150);
  assert.equal(largerScaleGrade.maxScore, 200);
  const tooLargeScale = await fetch(`${app.baseUrl}/api/grades`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: login.cookie },
    body: JSON.stringify({ subject: "Biology", assessment: "Exam", score: 150, maxScore: 10001 }),
  });
  assert.equal(tooLargeScale.status, 400);

  const featureConfig = await fetch(`${app.baseUrl}/api/config`).then((response) => response.json());
  assert.equal(featureConfig.aiConfigured, false);
  const unavailableChat = await fetch(`${app.baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: login.cookie },
    body: JSON.stringify({ messages: [{ role: "user", content: "Help me study" }] }),
  });
  assert.equal(unavailableChat.status, 503);
  const invalidSearch = await fetch(`${app.baseUrl}/api/sources?q=`, { headers: { Cookie: login.cookie } });
  assert.equal(invalidSearch.status, 400);

  const dashboard = await fetch(`${app.baseUrl}/dashboard`, { headers: { Cookie: login.cookie } });
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.headers.get("cache-control"), /no-store/);
  const dashboardMarkup = await dashboard.text();
  assert.match(dashboardMarkup, /Hi there!/);
  assert.match(dashboardMarkup, /id="greeting-avatar"[^>]+profile illustration/);
  assert.match(dashboardMarkup, /id="dashboard-task-list"/);
  assert.match(dashboardMarkup, /id="dashboard-chat-input"/);
  assert.match(dashboardMarkup, /class="chat-panel"/);
  assert.match(dashboardMarkup, /id="recent-source-display" class="recent-source-feed"/);
  assert.match(dashboardMarkup, /id="source-example-list"/);
  assert.match(dashboardMarkup, /id="grade-max-score"/);
  assert.match(dashboardMarkup, /id="grade-chart"/);
  assert.match(dashboardMarkup, /id="grade-scale-form"/);
  for (const route of ["/grades", "/chat-buddy", "/how-to-use", "/calendar", "/search", "/sources", "/about"]) {
    assert.match(dashboardMarkup, new RegExp(`href="${route.replaceAll("/", "\\/")}"`));
  }
  for (const route of ["/grades", "/how-to-use", "/search", "/sources", "/search-sources", "/source-information", "/about", "/chat-buddy", "/calendar"]) {
    const response = await fetch(`${app.baseUrl}${route}`, { headers: { Cookie: login.cookie } });
    assert.equal(response.status, 200, `${route} should exist for authenticated navigation`);
  }

  await app.stop();
  app = await startApp(appPort, databasePath, smtpPort);
  assert.equal((await fetch(`${app.baseUrl}/api/me`, { headers: { Cookie: login.cookie } })).status, 200);
  assert.equal((await fetch(`${app.baseUrl}/dashboard`, { headers: { Cookie: login.cookie } })).status, 200);
  const persistedTasks = await fetch(`${app.baseUrl}/api/tasks`, { headers: { Cookie: login.cookie } });
  assert.equal((await persistedTasks.json()).tasks[0].title, "Revised research essay");
  const persistedGrades = await fetch(`${app.baseUrl}/api/grades`, { headers: { Cookie: login.cookie } });
  const persistedGradeList = (await persistedGrades.json()).grades;
  assert.ok(persistedGradeList.some((grade) => grade.assessment === "Cell quiz" && grade.maxScore === 100));
  assert.ok(persistedGradeList.some((grade) => grade.assessment === "Lab report" && grade.score === 7 && grade.maxScore === 8));
  assert.ok(persistedGradeList.some((grade) => grade.assessment === "Exam" && grade.score === 150 && grade.maxScore === 200));
  assert.ok(persistedGradeList.some((grade) => grade.id === scaledGrade.id && grade.taskId === savedTask.id && grade.criterion === "A"));
  const persistedSubjects = await fetch(`${app.baseUrl}/api/grade-subjects`, { headers: { Cookie: login.cookie } }).then((response) => response.json());
  assert.deepEqual(persistedSubjects.subjects, [{ subject: "Biology", maxScore: 8 }, { subject: "History", maxScore: 100 }]);
  const removeTask = await fetch(`${app.baseUrl}/api/tasks/${savedTask.id}`, {
    method: "DELETE",
    headers: { Cookie: login.cookie },
  });
  assert.equal(removeTask.status, 200);
  const afterTaskRemoval = await fetch(`${app.baseUrl}/api/grades`, { headers: { Cookie: login.cookie } }).then((response) => response.json());
  assert.equal(afterTaskRemoval.grades.find((grade) => grade.id === scaledGrade.id).taskId, null);
  for (const grade of [savedGrade, scaledGrade, largerScaleGrade]) {
    const deleteGrade = await fetch(`${app.baseUrl}/api/grades/${grade.id}`, {
      method: "DELETE",
      headers: { Cookie: login.cookie },
    });
    assert.equal(deleteGrade.status, 200);
  }
  assert.equal((await fetch(`${app.baseUrl}/api/tasks`, { headers: { Cookie: login.cookie } }).then((response) => response.json())).tasks.length, 0);

  const datedResult = await post(app.baseUrl, "/api/grades", {
    subject: "Biology", assessment: "Experiment", criterion: "A", score: 7, maxScore: 8,
    createCalendarTask: true, dueDate: "2026-11-25",
  }, login.cookie);
  assert.equal(datedResult.response.status, 201);
  const undatedResult = await post(app.baseUrl, "/api/grades", {
    subject: "Biology", assessment: "Reflection", criterion: "C", score: 5, maxScore: 8,
    createCalendarTask: true,
  }, login.cookie);
  assert.equal(undatedResult.response.status, 201);
  const calendarTasks = (await fetch(`${app.baseUrl}/api/tasks`, { headers: { Cookie: login.cookie } }).then((response) => response.json())).tasks;
  assert.deepEqual(calendarTasks.map(({ id, title, dueDate, criteria }) => ({ id, title, dueDate, criteria })), [
    { id: datedResult.body.grade.taskId, title: "Experiment", dueDate: "2026-11-25", criteria: ["A"] },
    { id: undatedResult.body.grade.taskId, title: "Reflection", dueDate: null, criteria: ["C"] },
  ]);
  for (const invalid of [
    { createCalendarTask: true, dueDate: "2026-02-31" },
    { createCalendarTask: true, taskId: datedResult.body.grade.taskId },
    { createCalendarTask: true, criterion: "" },
  ]) {
    const response = await post(app.baseUrl, "/api/grades", {
      subject: "Biology", assessment: "Invalid", criterion: "A", score: 6, maxScore: 8, ...invalid,
    }, login.cookie);
    assert.equal(response.response.status, 400);
  }
  assert.equal((await fetch(`${app.baseUrl}/api/tasks`, { headers: { Cookie: login.cookie } }).then((response) => response.json())).tasks.length, 2);

  aiServer = createServer((request, response) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);
    const requestPath = requestUrl.pathname;
    if (request.method === "GET" && requestPath === "/works") {
      const query = requestUrl.searchParams.get("query.bibliographic");
      crossrefQueries.push(query);
      if (query === "biology" && ++biologyAttempts === 1) {
        response.writeHead(429, { "Retry-After": "0" });
        response.end();
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        message: {
          items: [1, 2, 3].map((number) => ({
            title: [`Photosynthesis in plants ${number}`],
            author: [{ given: "R. A.", family: "Scholar" }],
            published: { "date-parts": [[2024]] },
            DOI: `10.1234/plant-study-${number}`,
            publisher: "Test Science Press",
            "container-title": ["Plant Studies"],
          })),
        },
      }));
      return;
    }
    if (request.method === "GET" && requestPath === "/commons") {
      wikimediaQueries.push(requestUrl.searchParams.get("gcmtitle") || requestUrl.searchParams.get("gsrsearch"));
      const count = requestUrl.searchParams.has("gcmtitle") ? 3 : 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        query: { pages: Array.from({ length: count }, (_, index) => ({
          title: `File:Illustration-${index}.jpg`,
          imageinfo: [{
            mime: "image/jpeg",
            url: `https://upload.wikimedia.org/Illustration-${index}.jpg`,
            thumburl: `https://thumb.wikimedia.org/Illustration-${index}.jpg`,
            descriptionurl: `https://commons.wikimedia.org/wiki/File:Illustration-${index}.jpg`,
            size: 1000,
          }],
        })) },
      }));
      return;
    }
    let raw = "";
    request.on("data", (chunk) => { raw += chunk.toString(); });
    request.on("end", () => {
      aiRequests.push({ authorization: request.headers.authorization, body: JSON.parse(raw) });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "Let’s work through it one step at a time." } }] }));
    });
  });
  await new Promise((resolve, reject) => aiServer.listen(0, "127.0.0.1", resolve).once("error", reject));
  const aiPort = aiServer.address().port;
  const crossrefApiUrl = `http://127.0.0.1:${aiPort}/works`;
  await app.stop();
  app = await startApp(appPort, databasePath, smtpPort, {
    aiApiUrl: `http://127.0.0.1:${aiPort}/v1/chat/completions`,
    aiApiKey: "test-provider-key",
    aiModel: "test-model",
    crossrefApiUrl,
    wikimediaApiUrl: `http://127.0.0.1:${aiPort}/commons`,
  });
  const configuredChat = await post(app.baseUrl, "/api/chat", {
    messages: [{ role: "user", content: "Help me understand photosynthesis." }],
  }, login.cookie);
  assert.equal(configuredChat.response.status, 200);
  assert.equal(configuredChat.body.reply, "Let’s work through it one step at a time.");
  assert.deepEqual(configuredChat.body, { reply: "Let’s work through it one step at a time." });
  assert.equal(aiRequests[0].authorization, "Bearer test-provider-key");
  assert.equal(aiRequests[0].body.model, "test-model");
  assert.equal(aiRequests[0].body.messages.at(-1).content, "Help me understand photosynthesis.");
  assert.match(aiRequests[0].body.messages[0].content, /one or two concise paragraphs/);
  assert.match(aiRequests[0].body.messages[0].content, /usually under 80 words/);
  assert.match(aiRequests[0].body.messages[0].content, /Do not include source lists, citations, references, or URLs/);
  assert.equal(aiRequests[0].body.max_tokens, 600);

  const greetingChat = await post(app.baseUrl, "/api/chat", {
    messages: [
      { role: "user", content: "Help me understand photosynthesis." },
      { role: "assistant", content: "Photosynthesis helps plants make food." },
      { role: "user", content: "Hi!" },
    ],
  }, login.cookie);
  assert.equal(greetingChat.response.status, 200);
  assert.deepEqual(greetingChat.body, { reply: "Let’s work through it one step at a time." });

  const unrelatedChat = await post(app.baseUrl, "/api/chat", {
    messages: [{ role: "user", content: "Tell me about black holes." }],
  }, login.cookie);
  assert.equal(unrelatedChat.response.status, 200);
  assert.deepEqual(unrelatedChat.body, { reply: "Let’s work through it one step at a time." });
  assert.deepEqual(crossrefQueries, [], "chat messages should not be sent to Crossref");

  const search = await fetch(`${app.baseUrl}/api/sources?q=biology`, { headers: { Cookie: login.cookie } });
  assert.equal(search.status, 200);
  const searchResults = (await search.json()).sources;
  assert.equal(searchResults.length, 3);
  assert.equal(biologyAttempts, 2, "a temporary Crossref rate limit should be retried");
  assert.ok(searchResults[0].image);
  assert.equal(searchResults[1].image, null, "scarce images should not be repeated");
  assert.equal(searchResults[2].image, null);
  const cachedSearch = await fetch(`${app.baseUrl}/api/sources?q=biology`, { headers: { Cookie: login.cookie } });
  assert.equal(cachedSearch.status, 200);
  assert.equal(biologyAttempts, 2, "repeated searches should use the short-lived cache");
  const recent = await fetch(`${app.baseUrl}/api/sources/recent`, { headers: { Cookie: login.cookie } });
  const recentSources = (await recent.json()).sources;
  assert.equal(recent.status, 200);
  assert.equal(new Set(recentSources.map((source) => source.image?.url)).size, 3);
  assert.ok(wikimediaQueries.includes("Category:Featured pictures on Wikimedia Commons"));

  await app.stop();
  app = await startApp(appPort, databasePath, smtpPort, {
    aiProvider: "ollama",
    aiOllamaUrl: `http://127.0.0.1:${aiPort}/v1/chat/completions`,
    aiApiKey: "test-openai-key-must-not-be-forwarded",
    aiModel: "qwen2.5:3b",
    crossrefApiUrl,
  });
  const localAiConfig = await fetch(`${app.baseUrl}/api/config`).then((response) => response.json());
  assert.equal(localAiConfig.aiConfigured, true);
  assert.equal(localAiConfig.aiProvider, "ollama");
  const localChat = await post(app.baseUrl, "/api/chat", {
    messages: [{ role: "user", content: "Help me study." }],
  }, login.cookie);
  assert.equal(localChat.response.status, 200);
  assert.equal(localChat.body.reply, "Let’s work through it one step at a time.");
  assert.equal(aiRequests.at(-1).authorization, undefined);
  assert.equal(aiRequests.at(-1).body.model, "qwen2.5:3b");

  const resetRequest = await post(app.baseUrl, "/api/auth/forgot-password", { email: "ada@example.test" });
  assert.equal(resetRequest.response.status, 200);
  assert.equal(smtpMessages.length, 4);
  const resetToken = tokenFromEmail(smtpMessages[3], "reset");

  const resetAttempts = await Promise.all([
    post(app.baseUrl, "/api/auth/reset-password", {
      token: resetToken,
      password: "An-even-better-password-456",
    }),
    post(app.baseUrl, "/api/auth/reset-password", {
      token: resetToken,
      password: "An-even-better-password-456",
    }),
  ]);
  assert.deepEqual(resetAttempts.map((attempt) => attempt.response.status).sort(), [200, 400]);
  assert.equal((await fetch(`${app.baseUrl}/api/me`, { headers: { Cookie: login.cookie } })).status, 401);

  const oldPassword = await post(app.baseUrl, "/api/auth/login", {
    email: "ada@example.test",
    password: "A-good-password-123",
  });
  assert.equal(oldPassword.response.status, 401);
  const newPassword = await post(app.baseUrl, "/api/auth/login", {
    email: "ada@example.test",
    password: "An-even-better-password-456",
  });
  assert.equal(newPassword.response.status, 200);

  const oauthPlaceholder = await fetch(`${app.baseUrl}/auth/oauth/google`);
  assert.equal(oauthPlaceholder.status, 501);
  assert.match(await oauthPlaceholder.text(), /not configured/i);

  const logout = await post(app.baseUrl, "/api/auth/logout", {}, newPassword.cookie);
  assert.equal(logout.response.status, 200);
  assert.equal((await fetch(`${app.baseUrl}/api/me`, { headers: { Cookie: newPassword.cookie } })).status, 401);

  await app.stop();
  app = await startApp(appPort, databasePath, null, {
    production: true,
    baseUrl: "https://academicbuddy.example.test",
  });
  const productionLogin = await post(app.requestUrl, "/api/auth/login", {
    email: "ada@example.test",
    password: "An-even-better-password-456",
  });
  assert.equal(productionLogin.response.status, 200);
  assert.match(productionLogin.response.headers.get("set-cookie"), /; Secure(?:;|$)/);
  assert.match((await fetch(app.requestUrl)).headers.get("strict-transport-security"), /max-age=31536000/);
});

test("Google and X OAuth require state and email confirmation before first sign-in", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "academicbuddy-oauth-"));
  const databasePath = path.join(tempDir, "oauth.sqlite");
  const appPort = await availablePort();
  const smtpMessages = [];
  const providerRequests = [];
  const smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS"],
    onData(stream, _session, callback) {
      let raw = "";
      stream.on("data", (chunk) => { raw += chunk.toString(); });
      stream.on("end", () => {
        smtpMessages.push(raw);
        callback(null, "Message accepted");
      });
    },
  });
  await new Promise((resolve, reject) => smtp.listen(0, "127.0.0.1", resolve).once("error", reject));
  const smtpPort = smtp.server.address().port;
  const providerServer = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.endsWith("/token")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      providerRequests.push({ path: url.pathname, body: new URLSearchParams(body), authorization: req.headers.authorization });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: url.pathname.startsWith("/google") ? "google-access" : "x-access" }));
      return;
    }
    if (url.pathname === "/google/userinfo" || url.pathname === "/x/userinfo") {
      providerRequests.push({ path: url.pathname, authorization: req.headers.authorization });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(url.pathname === "/google/userinfo"
        ? { sub: "google-student-1", email: "google.student@example.test", email_verified: true, name: "Google Student" }
        : { data: { id: "x-student-1", name: "X Student", username: "xstudent" } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve, reject) => providerServer.listen(0, "127.0.0.1", resolve).once("error", reject));
  const providerPort = providerServer.address().port;
  let app;
  t.after(async () => {
    await app?.stop();
    await new Promise((resolve) => providerServer.close(resolve));
    await new Promise((resolve) => smtp.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  app = await startApp(appPort, databasePath, smtpPort, {
    googleClientId: "google-test-client",
    googleClientSecret: "google-test-secret",
    xClientId: "x-test-client",
    xClientSecret: "x-test-secret",
    googleAuthorizationUrl: `http://127.0.0.1:${providerPort}/google/authorize`,
    googleTokenUrl: `http://127.0.0.1:${providerPort}/google/token`,
    googleUserInfoUrl: `http://127.0.0.1:${providerPort}/google/userinfo`,
    xAuthorizationUrl: `http://127.0.0.1:${providerPort}/x/authorize`,
    xTokenUrl: `http://127.0.0.1:${providerPort}/x/token`,
    xUserInfoUrl: `http://127.0.0.1:${providerPort}/x/userinfo`,
  });
  const config = await fetch(`${app.baseUrl}/api/config`).then((response) => response.json());
  assert.deepEqual(config.socialProviders, { google: true, x: true });
  assert.equal(config.socialLoginAvailable, true);

  const csrfStart = await fetch(`${app.baseUrl}/auth/oauth/google`, { redirect: "manual" });
  const csrfCookie = csrfStart.headers.getSetCookie()
    .find((cookie) => cookie.startsWith("academicbuddy_oauth_google=")).split(";")[0];
  const rejectedState = await fetch(`${app.baseUrl}/auth/oauth/google/callback?code=should-not-be-used&state=wrong-state`, {
    headers: { Cookie: csrfCookie },
    redirect: "manual",
  });
  assert.equal(rejectedState.headers.get("location"), "/login?oauth_error=invalid");
  assert.equal(providerRequests.length, 0);

  async function beginOAuth(provider, code) {
    const start = await fetch(`${app.baseUrl}/auth/oauth/${provider}`, { redirect: "manual" });
    assert.equal(start.status, 302);
    const authorizationUrl = new URL(start.headers.get("location"));
    assert.ok(authorizationUrl.searchParams.get("code_challenge"));
    const state = authorizationUrl.searchParams.get("state");
    const cookies = start.headers.getSetCookie();
    const stateCookie = cookies.find((cookie) => cookie.startsWith(`academicbuddy_oauth_${provider}=`));
    assert.ok(stateCookie);
    return fetch(`${app.baseUrl}/auth/oauth/${provider}/callback?code=${code}&state=${state}`, {
      headers: { Cookie: stateCookie.split(";")[0] },
      redirect: "manual",
    });
  }

  const googleCallback = await beginOAuth("google", "google-code");
  assert.equal(googleCallback.status, 303);
  assert.equal(googleCallback.headers.get("location"), "/login?oauth=confirmation-sent");
  assert.equal(smtpMessages.length, 1);
  let testDb = new DatabaseSync(databasePath);
  assert.equal(testDb.prepare("SELECT COUNT(*) AS count FROM oauth_accounts").get().count, 0);
  const googleVerify = tokenFromEmail(smtpMessages[0], "verify");
  const googleConfirmation = await post(app.baseUrl, "/api/auth/verify", { token: googleVerify });
  assert.equal(googleConfirmation.response.status, 200);
  assert.equal(googleConfirmation.body.redirectTo, "/dashboard");
  const googleCookie = googleConfirmation.response.headers.getSetCookie()
    .find((cookie) => cookie.startsWith("academicbuddy_session=")).split(";")[0];
  assert.equal((await fetch(`${app.baseUrl}/api/me`, { headers: { Cookie: googleCookie } })).status, 200);
  assert.equal(testDb.prepare("SELECT provider FROM oauth_accounts WHERE provider_user_id = ?").get("google-student-1").provider, "google");
  testDb.close();

  const existingGoogleLogin = await beginOAuth("google", "google-again");
  assert.equal(existingGoogleLogin.headers.get("location"), "/dashboard");
  assert.ok(existingGoogleLogin.headers.getSetCookie().some((cookie) => cookie.startsWith("academicbuddy_session=")));
  assert.equal(smtpMessages.length, 2);

  const xCallback = await beginOAuth("x", "x-code");
  assert.equal(xCallback.status, 303);
  const pendingToken = new URL(xCallback.headers.get("location"), app.baseUrl).searchParams.get("oauth_pending");
  assert.ok(pendingToken);
  const xEmail = await post(app.baseUrl, "/api/auth/oauth/complete", {
    token: pendingToken,
    email: "x.student@example.test",
  });
  assert.equal(xEmail.response.status, 200);
  assert.match(xEmail.body.message, /check your email/i);
  assert.equal(smtpMessages.length, 3);
  const xVerify = tokenFromEmail(smtpMessages[2], "verify");
  const xConfirmation = await post(app.baseUrl, "/api/auth/verify", { token: xVerify });
  assert.equal(xConfirmation.response.status, 200);
  assert.equal(xConfirmation.body.redirectTo, "/dashboard");
  testDb = new DatabaseSync(databasePath);
  assert.equal(testDb.prepare("SELECT provider FROM oauth_accounts WHERE provider_user_id = ?").get("x-student-1").provider, "x");
  testDb.close();

  const googleTokenRequest = providerRequests.find((request) => request.path === "/google/token");
  assert.ok(googleTokenRequest.body.get("code_verifier"));
  assert.equal(providerRequests.find((request) => request.path === "/google/userinfo").authorization, "Bearer google-access");
  const xTokenRequest = providerRequests.find((request) => request.path === "/x/token");
  assert.ok(xTokenRequest.body.get("code_verifier"));
  assert.equal(xTokenRequest.authorization, `Basic ${Buffer.from("x-test-client:x-test-secret").toString("base64")}`);
});

test("legacy grade records migrate to the 100-point scale", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "academicbuddy-grade-migration-"));
  const databasePath = path.join(tempDir, "legacy.sqlite");
  const seed = new DatabaseSync(databasePath);
  seed.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      email_verified_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE grades (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subject TEXT NOT NULL,
      assessment TEXT NOT NULL,
      score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
      created_at TEXT NOT NULL
    );
    INSERT INTO users (id, full_name, email, password_hash, email_verified_at, created_at)
    VALUES (1, 'Legacy Student', 'legacy@example.test', 'unused-test-hash', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO grades (user_id, subject, assessment, score, created_at)
    VALUES (1, 'History', 'Essay', 7, '2026-01-02T00:00:00.000Z');
  `);
  seed.close();
  let app;
  t.after(async () => {
    await app?.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  app = await startApp(await availablePort(), databasePath, null);
  const sessionToken = "legacy-grade-migration-session";
  const migratedDb = new DatabaseSync(databasePath);
  migratedDb.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, 1, ?)").run(
    createHash("sha256").update(sessionToken).digest("hex"),
    Date.now() + 60_000,
  );
  migratedDb.close();
  const response = await fetch(`${app.baseUrl}/api/grades`, {
    headers: { Cookie: `academicbuddy_session=${sessionToken}` },
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).grades, [{
    id: 1,
    subject: "History",
    assessment: "Essay",
    score: 7,
    maxScore: 100,
    criterion: "",
    taskId: null,
  }]);
  const subjects = await fetch(`${app.baseUrl}/api/grade-subjects`, {
    headers: { Cookie: `academicbuddy_session=${sessionToken}` },
  }).then((result) => result.json());
  assert.deepEqual(subjects.subjects, [{ subject: "History", maxScore: 100 }]);
});
