const landingPage = document.querySelector("#landing-page");
const authPage = document.querySelector("#auth-page");
const appPage = document.querySelector("#app-page");
const statusBox = document.querySelector("#auth-status");
const loginForm = document.querySelector("#login-form");
const signupForm = document.querySelector("#signup-form");
const forgotForm = document.querySelector("#forgot-form");
const resetForm = document.querySelector("#reset-form");
const oauthEmailForm = document.querySelector("#oauth-email-form");
const oauthArea = document.querySelector("#oauth-area");
let resetToken = "";
let oauthPendingToken = "";
let tasks = [];
let chatMessages = [];
let chatPending = false;
let aiConfigured = false;
let recentSources = [];
let recentSourceIndex = 0;
let recentRotationTimer = null;
let recentRotationPaused = false;
let editingTaskId = null;
let selectedCalendarDate = "";
let visibleCalendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let calendarSubjectColors = new Map();
const subjectColorCount = 10;

document.querySelector("#year").textContent = new Date().getFullYear();

function startFloatingCaps() {
  const field = Array.from(document.querySelectorAll(".floating-cap-field"))
    .find((candidate) => !candidate.closest("main")?.hidden);
  if (!field) return;
  const starts = [
    { x: .08, y: .16, vx: 54, vy: 39, rotation: -10 },
    { x: .72, y: .23, vx: -47, vy: 34, rotation: 8 },
    { x: .18, y: .62, vx: 41, vy: -43, rotation: -4 },
    { x: .82, y: .68, vx: -52, vy: -36, rotation: 12 },
    { x: .48, y: .43, vx: 36, vy: 48, rotation: -13 },
  ];
  const caps = Array.from(field.querySelectorAll(".bouncing-cap")).map((element, index) => {
    const start = starts[index % starts.length];
    const rect = element.getBoundingClientRect();
    return {
      element,
      width: rect.width || 40,
      height: rect.height || 30,
      x: (window.innerWidth - (rect.width || 40)) * start.x,
      y: (window.innerHeight - (rect.height || 30)) * start.y,
      vx: start.vx,
      vy: start.vy,
      rotation: start.rotation,
      hue: index * 36,
    };
  });
  let lastFrame = performance.now();
  const placeCaps = () => {
    for (const cap of caps) {
      cap.x = Math.min(Math.max(cap.x, 0), Math.max(0, window.innerWidth - cap.width));
      cap.y = Math.min(Math.max(cap.y, 0), Math.max(0, window.innerHeight - cap.height));
      cap.element.style.transform = `translate3d(${cap.x}px, ${cap.y}px, 0) rotate(${cap.rotation}deg)`;
      cap.element.style.filter = `hue-rotate(${cap.hue}deg) drop-shadow(0 3px 4px rgba(53, 78, 118, .13))`;
    }
  };
  const resizeCaps = () => placeCaps();
  window.addEventListener("resize", resizeCaps);
  placeCaps();
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const animate = (now) => {
    const elapsed = Math.min((now - lastFrame) / 1000, .05);
    lastFrame = now;
    for (const cap of caps) {
      let bounced = false;
      cap.x += cap.vx * elapsed;
      cap.y += cap.vy * elapsed;
      const maxX = Math.max(0, window.innerWidth - cap.width);
      const maxY = Math.max(0, window.innerHeight - cap.height);
      if (cap.x <= 0 || cap.x >= maxX) {
        cap.x = Math.min(Math.max(cap.x, 0), maxX);
        cap.vx *= -1;
        bounced = true;
      }
      if (cap.y <= 0 || cap.y >= maxY) {
        cap.y = Math.min(Math.max(cap.y, 0), maxY);
        cap.vy *= -1;
        bounced = true;
      }
      if (bounced) cap.hue = (cap.hue + 48) % 360;
    }
    placeCaps();
    requestAnimationFrame(animate);
  };
  requestAnimationFrame(animate);
}

function showStatus(message, type = "success") {
  statusBox.textContent = message;
  statusBox.classList.toggle("error", type === "error");
  statusBox.hidden = false;
}

function clearStatus() {
  statusBox.hidden = true;
  statusBox.textContent = "";
  statusBox.classList.remove("error");
}

function showAuthMode(mode) {
  authPage.dataset.page = mode;
  clearStatus();
  loginForm.hidden = mode !== "login";
  signupForm.hidden = mode !== "signup";
  forgotForm.hidden = mode !== "forgot";
  resetForm.hidden = mode !== "reset";
  oauthEmailForm.hidden = mode !== "oauth-email";
  oauthArea.hidden = !["login", "signup"].includes(mode);
  const isSignup = mode === "signup";
  const oauthCopy = document.querySelector("#oauth-copy");
  if (oauthCopy) oauthCopy.textContent = isSignup ? "or sign up with" : "or log in with";
  document.querySelector("#auth-title").textContent = {
    login: "Welcome back",
    signup: "Create your account",
    forgot: "Forgot your password?",
    reset: "Choose a new password",
    "oauth-email": "Confirm your email",
  }[mode];
  document.querySelector("#auth-subtitle").textContent = {
    login: "Log in to pick up where you left off.",
    signup: "Make a little room for your next big idea.",
    forgot: "We’ll send a reset link if there’s a verified account for that email.",
    reset: "Use at least 10 characters to secure your account.",
    "oauth-email": "X does not share your email address. Enter it so we can send a sign-in confirmation.",
  }[mode];
  document.querySelector("#auth-aside-title").innerHTML = isSignup
    ? "A little help<br><em>starts here.</em>"
    : mode === "login"
      ? "Good things<br>start <em>here.</em>"
      : "Your space<br>is <em>yours.</em>";
  document.querySelector("#auth-aside-copy").textContent = isSignup
    ? "Create your AcademicBuddy account and make school feel a little more manageable."
    : "A little more focus, a lot more you. Your study space is ready when you are.";
}

async function requestJson(url, payload, method = "POST") {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Something went wrong. Please try again.");
  return result;
}

function setBusy(form, busy) {
  const button = form.querySelector('button[type="submit"]');
  if (button) {
    button.disabled = busy;
    button.setAttribute("aria-busy", String(busy));
  }
}

function updateProfile(user) {
  const initial = [...user.name.trim()][0]?.toUpperCase() || "A";
  const avatarId = /^avatar-[1-9]$/.test(user.avatarId) ? user.avatarId : "avatar-1";
  document.querySelector("#user-name").textContent = user.name;
  document.querySelector("#user-avatar").src = `/avatars/${avatarId}.svg`;
  document.querySelector("#greeting-name").textContent = user.name;
  document.querySelector("#greeting-avatar").src = `/avatars/${avatarId}.svg`;
  document.querySelector("#greeting-avatar").alt = `${user.name}'s profile picture`;
  document.querySelector("#dashboard-chat-greeting").textContent = `Hi ${user.name.split(/\s+/)[0]}!`;
}

function setActiveNavigation(route) {
  const activeRoutes = {
    "/search-sources": "/search",
    "/source-information": "/sources",
  };
  const activeRoute = activeRoutes[route] || route;
  document.querySelectorAll(".top-nav-link").forEach((link) => {
    const active = link.dataset.route === activeRoute;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  document.querySelectorAll(".mobile-nav a").forEach((link) => {
    const active = new URL(link.href).pathname === activeRoute;
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

async function setupAuthPage(path, params) {
  authPage.hidden = false;
  let mode = path === "/signup" ? "signup" : "login";
  try {
    const config = await fetch("/api/config", { credentials: "same-origin" }).then((response) => response.json());
    document.querySelector("#email-setup-note").hidden = config.emailConfigured;
    document.querySelectorAll("[data-oauth-provider]").forEach((link) => {
      link.hidden = !config.socialProviders?.[link.dataset.oauthProvider];
    });
    const oauthNote = document.querySelector("#oauth-note");
    oauthNote.hidden = config.socialLoginAvailable;
    oauthNote.textContent = config.emailConfigured
      ? "Social sign-in will appear once Google or X credentials are configured."
      : "Social sign-in requires configured provider credentials and email delivery for confirmation.";
  } catch {
    document.querySelector("#email-setup-note").hidden = false;
  }

  if (params.has("oauth_pending")) {
    oauthPendingToken = params.get("oauth_pending");
    history.replaceState({}, "", "/login");
    showAuthMode("oauth-email");
    return;
  }
  if (params.has("oauth")) {
    history.replaceState({}, "", "/login");
    mode = "login";
    showAuthMode(mode);
    if (params.get("oauth") === "confirmation-sent") {
      showStatus("Check your email and click the confirmation link to finish signing in.");
    }
    return;
  }
  if (params.has("oauth_error")) {
    history.replaceState({}, "", "/login");
    mode = "login";
    showAuthMode(mode);
    const messages = {
      cancelled: "Sign-in was cancelled. You can try again.",
      invalid: "That sign-in link expired or could not be verified. Please try again.",
      email: "The provider did not return a usable email address. Please try another sign-in method.",
      provider: "Social sign-in is temporarily unavailable. Please try again.",
    };
    showStatus(messages[params.get("oauth_error")] || messages.provider, "error");
    return;
  }

  if (params.has("verify")) {
    try {
      const result = await requestJson("/api/auth/verify", { token: params.get("verify") });
      history.replaceState({}, "", "/login");
      if (result.redirectTo) {
        window.location.replace(result.redirectTo);
        return;
      }
      mode = "login";
      showAuthMode(mode);
      showStatus(result.message);
    } catch (error) {
      history.replaceState({}, "", "/login");
      mode = "login";
      showAuthMode(mode);
      showStatus(error.message, "error");
    }
    return;
  }
  if (params.has("reset")) {
    resetToken = params.get("reset");
    history.replaceState({}, "", "/login");
    mode = "reset";
  }
  showAuthMode(mode);
}

async function setupAppPage(path) {
  appPage.hidden = false;
  appPage.dataset.page = ({
    "/dashboard": "home",
    "/search": "search",
    "/search-sources": "search",
    "/sources": "source-information",
    "/source-information": "source-information",
    "/about": "about",
    "/chat-buddy": "chat-buddy",
    "/calendar": "calendar",
    "/grades": "grades",
    "/how-to-use": "how-to-use",
  })[path] || "home";
  setActiveNavigation(path);
  const views = {
    "/dashboard": "home-content",
    "/search-sources": "search-content",
    "/search": "search-content",
    "/source-information": "source-information-content",
    "/sources": "source-information-content",
    "/about": "about-content",
    "/chat-buddy": "chat-content",
    "/calendar": "calendar-content",
    "/grades": "grades-content",
    "/how-to-use": "how-to-use-content",
  };
  for (const id of ["home-content", "search-content", "source-information-content", "about-content", "chat-content", "calendar-content", "grades-content", "how-to-use-content"]) {
    document.getElementById(id).hidden = id !== views[path];
  }

  try {
    const response = await fetch("/api/me", { credentials: "same-origin" });
    if (!response.ok) {
      window.location.replace("/login");
      return;
    }
    const { user } = await response.json();
    updateProfile(user);
  } catch {
    window.location.replace("/login");
    return;
  }

  try {
    await loadTasks();
  } catch (error) {
    const alertBox = document.querySelector("#app-status");
    alertBox.textContent = error.message;
    alertBox.hidden = false;
  }
  if (path === "/source-information" || path === "/sources") await loadSourceDetails();
  if (path === "/grades") {
    try {
      await loadGradeSubjects();
      await loadGrades();
      prepareGradeTaskFromUrl();
    } catch (error) {
      const alertBox = document.querySelector("#app-status");
      alertBox.textContent = error.message;
      alertBox.hidden = false;
    }
  }
  if (path === "/dashboard" || path === "/calendar") {
    try {
      await loadGrades();
      renderTasks();
    } catch (error) {
      const alertBox = document.querySelector("#app-status");
      alertBox.textContent = error.message;
      alertBox.hidden = false;
    }
  }
  if (path === "/calendar") {
    const params = new URLSearchParams(window.location.search);
    const title = params.get("title");
    const subject = params.get("subject");
    if (title && subject && title.length <= 120 && subject.length <= 80) {
      document.querySelector("#task-title").value = title;
      document.querySelector("#task-subject").value = subject;
    }
  }
  if (path === "/search" || path === "/search-sources") void loadRecentSources();
  renderChat();
  await setupChat();
}

function formatDueDate(value) {
  if (!value) return "No due date";
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" })
    .format(new Date(year, month - 1, day));
}

function dateToCalendarValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function taskDueStatus(dueDate, today = dateToCalendarValue(new Date())) {
  if (!dueDate) return { key: "undated", label: "No due date" };
  if (dueDate < today) return { key: "overdue", label: "Overdue" };
  if (dueDate === today) return { key: "today", label: "Due today" };
  return { key: "upcoming", label: "Upcoming" };
}

function subjectColorClass(subject) {
  const key = (subject || "General").trim().toLowerCase() || "general";
  if (calendarSubjectColors.has(key)) return `subject-color-${calendarSubjectColors.get(key)}`;
  let hash = 0;
  for (const character of key) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return `subject-color-${hash % subjectColorCount}`;
}

function renderCalendar() {
  const label = document.querySelector("#calendar-month-label");
  const daysContainer = document.querySelector("#calendar-days");
  const legend = document.querySelector("#calendar-legend");
  if (!label || !daysContainer || !legend) return;

  const year = visibleCalendarMonth.getFullYear();
  const month = visibleCalendarMonth.getMonth();
  label.textContent = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" })
    .format(visibleCalendarMonth);
  daysContainer.replaceChildren();

  const subjectLabels = new Map();
  for (const task of tasks) {
    const label = task.subject?.trim() || "General";
    const key = label.toLowerCase();
    if (!subjectLabels.has(key)) subjectLabels.set(key, label);
  }
  const subjects = [...subjectLabels.entries()]
    .sort(([left], [right]) => left.localeCompare(right));
  calendarSubjectColors = new Map();
  const usedColors = new Set();
  for (const [key, label] of subjects) {
    let hash = 0;
    for (const character of label.toLowerCase()) {
      hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    }
    let colorIndex = hash % subjectColorCount;
    for (let attempt = 0; attempt < subjectColorCount && usedColors.has(colorIndex); attempt += 1) {
      colorIndex = (colorIndex + 1) % subjectColorCount;
    }
    calendarSubjectColors.set(key, colorIndex);
    usedColors.add(colorIndex);
  }
  legend.replaceChildren();
  if (!subjects.length) {
    const emptyLegend = document.createElement("span");
    emptyLegend.className = "calendar-legend-empty";
    emptyLegend.textContent = "Add a subject to give each task a consistent color.";
    legend.append(emptyLegend);
  } else {
    for (const [, subject] of subjects) {
      const item = document.createElement("span");
      item.className = `calendar-legend-item ${subjectColorClass(subject)}`;
      const swatch = document.createElement("span");
      swatch.className = "calendar-legend-swatch";
      swatch.setAttribute("aria-hidden", "true");
      const name = document.createElement("span");
      name.textContent = subject;
      item.append(swatch, name);
      legend.append(item);
    }
  }

  const firstWeekday = new Date(year, month, 1).getDay();
  const dayCount = new Date(year, month + 1, 0).getDate();
  for (let blank = 0; blank < firstWeekday; blank += 1) {
    const spacer = document.createElement("div");
    spacer.className = "calendar-day calendar-day-empty";
    spacer.setAttribute("aria-hidden", "true");
    daysContainer.append(spacer);
  }

  const todayValue = dateToCalendarValue(new Date());
  for (let dayNumber = 1; dayNumber <= dayCount; dayNumber += 1) {
    const date = new Date(year, month, dayNumber);
    const dateValue = dateToCalendarValue(date);
    const cell = document.createElement("div");
    cell.className = "calendar-day";
    cell.setAttribute("role", "gridcell");
    if (dateValue === todayValue) cell.classList.add("is-today");
    if (dateValue === selectedCalendarDate) cell.classList.add("is-selected");

    const dayButton = document.createElement("button");
    dayButton.className = "calendar-day-select";
    dayButton.type = "button";
    dayButton.textContent = String(dayNumber);
    dayButton.setAttribute("aria-label", `${formatDueDate(dateValue)}. Add a task for this date.`);
    dayButton.setAttribute("aria-pressed", String(dateValue === selectedCalendarDate));
    dayButton.addEventListener("click", () => beginNewTask(dateValue));
    cell.append(dayButton);

    const dayTasks = tasks.filter((task) => task.dueDate === dateValue);
    for (const task of dayTasks) {
      const linkedScores = savedGrades.filter((grade) => grade.taskId === task.id)
        .map((grade) => `${grade.criterion || "Score"}: ${grade.score}/${grade.maxScore}`).join(" · ");
      const event = document.createElement("button");
      event.className = `calendar-event ${subjectColorClass(task.subject)}${task.completed ? " is-completed" : ""}`;
      event.type = "button";
      event.title = `${task.subject || "General"}: ${task.title}${linkedScores ? ` · ${linkedScores}` : ""}`;
      event.setAttribute("aria-label", `Edit ${task.title}, ${task.subject || "General"}, due ${formatDueDate(dateValue)}${task.completed ? ", completed" : ""}${linkedScores ? `, ${linkedScores}` : ""}`);
      const subject = document.createElement("span");
      subject.className = "calendar-event-subject";
      subject.textContent = task.subject || "General";
      const title = document.createElement("span");
      title.className = "calendar-event-title";
      title.textContent = task.title;
      event.append(subject, title);
      if (linkedScores) {
        const score = document.createElement("span");
        score.className = "calendar-event-grade";
        score.textContent = linkedScores;
        event.append(score);
      }
      event.addEventListener("click", () => beginEditingTask(task.id));
      cell.append(event);
    }
    daysContainer.append(cell);
  }

  const unscheduledSection = document.querySelector("#unscheduled-section");
  const unscheduledList = document.querySelector("#unscheduled-task-list");
  const unscheduledTasks = tasks.filter((task) => !task.dueDate);
  if (unscheduledSection && unscheduledList) {
    unscheduledSection.hidden = !unscheduledTasks.length;
    unscheduledList.replaceChildren();
    for (const task of unscheduledTasks) {
      const item = document.createElement("button");
      item.className = `unscheduled-task ${subjectColorClass(task.subject)}${task.completed ? " is-completed" : ""}`;
      item.type = "button";
      const linkedScores = savedGrades.filter((grade) => grade.taskId === task.id)
        .map((grade) => `${grade.criterion || "Score"}: ${grade.score}/${grade.maxScore}`).join(" · ");
      item.textContent = `${task.subject || "General"} · ${task.title}${linkedScores ? ` · ${linkedScores}` : ""}`;
      item.addEventListener("click", () => beginEditingTask(task.id));
      unscheduledList.append(item);
    }
  }
}

function createTaskCard(task, compact = false) {
  const card = document.createElement("article");
  card.className = `school-task task-card${task.completed ? " task-completed" : ""}`;

  const icon = document.createElement("span");
  icon.className = `task-date-icon ${task.completed ? "task-icon-mint" : "task-icon-lavender"}`;
  icon.setAttribute("aria-hidden", "true");
  const subjectText = `${task.subject} ${task.title}`.toLowerCase();
  icon.textContent = task.completed ? "✓" :
    /math|algebra|number/.test(subjectText) ? "▦" :
      /english|language|essay|writing/.test(subjectText) ? "▤" :
        /physics|science|lab/.test(subjectText) ? "♧" : "✎";

  const details = document.createElement("div");
  details.className = "task-copy";
  const subject = document.createElement("small");
  subject.textContent = task.subject || "SCHOOL TASK";
  const title = document.createElement("strong");
  title.className = "task-title";
  title.textContent = task.title;
  const due = document.createElement("p");
  due.className = "task-due";
  due.textContent = task.dueDate ? `Due: ${formatDueDate(task.dueDate)}` : "No due date";
  details.append(subject, title, due);
  if (task.criteria?.length) {
    const criteria = document.createElement("p");
    criteria.className = "task-grade-summary";
    criteria.textContent = `Criteria: ${task.criteria.join(", ")}`;
    details.append(criteria);
  }
  const linkedGrades = savedGrades.filter((grade) => grade.taskId === task.id);
  if (linkedGrades.length) {
    const score = document.createElement("p");
    score.className = "task-grade-summary";
    score.textContent = linkedGrades.map((grade) => `${grade.criterion || "Score"}: ${grade.score}/${grade.maxScore}`).join(" · ");
    details.append(score);
  }

  const state = document.createElement("span");
  const dueStatus = taskDueStatus(task.dueDate);
  state.className = `task-status ${task.completed ? "status-started" : `due-${dueStatus.key}`}`;
  state.textContent = task.completed ? "Completed" : dueStatus.label;

  const toggle = document.createElement("button");
  toggle.className = "task-toggle";
  toggle.type = "button";
  toggle.textContent = task.completed ? "Done" : "Mark done";
  toggle.setAttribute("aria-pressed", String(task.completed));
  toggle.setAttribute("aria-label", `${task.completed ? "Reopen" : "Complete"} ${task.title}`);
  toggle.addEventListener("click", () => updateTask(task.id, { completed: !task.completed }));

  card.append(icon, details, state, toggle);
  if (compact && task.subject && task.subject.length <= 60) {
    const gradeLink = document.createElement("a");
    gradeLink.className = "task-grade-link";
    gradeLink.href = `/grades?taskId=${task.id}`;
    gradeLink.textContent = "Add score";
    card.append(gradeLink);
  }
  if (!compact) {
    const remove = document.createElement("button");
    remove.className = "task-delete";
    remove.type = "button";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${task.title}`);
    remove.addEventListener("click", () => deleteTask(task.id));
    card.append(remove);
  }
  return card;
}

function renderTasks() {
  const dashboardList = document.querySelector("#dashboard-task-list");
  dashboardList.replaceChildren();

  const upcoming = tasks.filter((task) => !task.completed).slice(0, 8);
  upcoming.forEach((task) => dashboardList.append(createTaskCard(task, true)));
  const taskIdeas = [
    { subject: "Math", title: "Math SA", icon: "▦" },
    { subject: "English", title: "English FA", icon: "▤" },
    { subject: "Physics", title: "Physics Lab Report", icon: "♧" },
    { subject: "Design", title: "Design Criterion B", icon: "✎" },
    { subject: "Science", title: "Review class notes", icon: "♧" },
    { subject: "History", title: "Research assignment", icon: "▤" },
    { subject: "Mathematics", title: "Practice questions", icon: "▦" },
    { subject: "English", title: "Reading reflection", icon: "✎" },
  ];
  for (const idea of taskIdeas.slice(0, 8 - upcoming.length)) {
    const card = document.createElement("article");
    card.className = "school-task task-card task-suggestion";
    const icon = document.createElement("span");
    icon.className = "task-date-icon task-icon-lavender";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = idea.icon;
    const details = document.createElement("div");
    details.className = "task-copy";
    const subject = document.createElement("small");
    subject.textContent = idea.subject;
    const title = document.createElement("strong");
    title.className = "task-title";
    title.textContent = idea.title;
    const due = document.createElement("p");
    due.className = "task-due";
    due.textContent = "Add your due date";
    details.append(subject, title, due);
    const status = document.createElement("span");
    status.className = "task-status status-started";
    status.textContent = "Suggested";
    const add = document.createElement("a");
    add.className = "task-suggestion-link";
    add.href = `/calendar?title=${encodeURIComponent(idea.title)}&subject=${encodeURIComponent(idea.subject)}`;
    add.textContent = "Add to calendar";
    card.append(icon, details, status, add);
    dashboardList.append(card);
  }

  renderCalendar();
}

async function loadTasks() {
  const response = await fetch("/api/tasks", { credentials: "same-origin" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Could not load your tasks.");
  tasks = result.tasks;
  renderTasks();
}

async function updateTask(id, changes) {
  try {
    await requestJson(`/api/tasks/${id}`, changes, "PATCH");
    await loadTasks();
  } catch (error) {
    showTaskStatus(error.message, "error");
  }
}

async function deleteTask(id) {
  try {
    await requestJson(`/api/tasks/${id}`, {}, "DELETE");
    await loadTasks();
    if (editingTaskId === id) resetTaskForm();
    showTaskStatus("Task removed.");
  } catch (error) {
    showTaskStatus(error.message, "error");
  }
}

function resetTaskForm(dateValue = selectedCalendarDate) {
  const form = document.querySelector("#task-form");
  if (!form) return;
  form.reset();
  editingTaskId = null;
  form.classList.remove("is-editing");
  selectedCalendarDate = dateValue || "";
  document.querySelector("#task-form-heading").textContent = "Add a task";
  document.querySelector("#task-submit-button").textContent = "Add task +";
  document.querySelector("#task-completed-label").hidden = true;
  document.querySelector("#task-cancel-edit").hidden = true;
  document.querySelector("#task-delete-edit").hidden = true;
  document.querySelector("#task-status").textContent = "";
  if (dateValue) document.querySelector("#task-due-date").value = dateValue;
  renderCalendar();
}

function beginNewTask(dateValue) {
  resetTaskForm(dateValue);
  document.querySelector("#task-title").focus();
}

function beginEditingTask(id) {
  const task = tasks.find((item) => item.id === id);
  if (!task) return;
  editingTaskId = task.id;
  document.querySelector("#task-form").classList.add("is-editing");
  selectedCalendarDate = task.dueDate || "";
  if (task.dueDate) {
    const [year, month] = task.dueDate.split("-").map(Number);
    visibleCalendarMonth = new Date(year, month - 1, 1);
  }
  document.querySelector("#task-title").value = task.title;
  document.querySelector("#task-subject").value = task.subject;
  document.querySelector("#task-due-date").value = task.dueDate || "";
  document.querySelector("#task-completed").checked = task.completed;
  document.querySelectorAll('#task-form input[name="criteria"]').forEach((input) => {
    input.checked = task.criteria.includes(input.value);
  });
  document.querySelector("#task-form-heading").textContent = "Edit task";
  document.querySelector("#task-submit-button").textContent = "Save changes";
  document.querySelector("#task-completed-label").hidden = false;
  document.querySelector("#task-cancel-edit").hidden = false;
  document.querySelector("#task-delete-edit").hidden = false;
  document.querySelector("#task-status").textContent = "";
  renderCalendar();
  document.querySelector("#task-title").focus();
}

let gradeSubjects = [];
let savedGrades = [];
let selectedGradeScale = 100;
const gradeSubjectSelect = document.querySelector("#grade-subject-select");
const gradeChartScales = new Map();

function renderGradeChart(grades) {
  const chart = document.querySelector("#grade-chart");
  chart.replaceChildren();
  const title = document.createElement("h2");
  title.textContent = "Assessment";
  chart.append(title);
  const subject = gradeSubjectSelect.value;
  const scales = [...new Set([selectedGradeScale, 8, 100])];
  const savedScale = gradeChartScales.get(subject);
  const chartScale = scales.includes(savedScale) ? savedScale : selectedGradeScale;
  const scaleField = document.createElement("div");
  scaleField.className = "task-field grade-chart-scale";
  const scaleLabel = document.createElement("label");
  scaleLabel.htmlFor = "grade-chart-scale";
  scaleLabel.textContent = "Choose graph scale";
  const scaleSelect = document.createElement("select");
  scaleSelect.id = "grade-chart-scale";
  for (const scale of scales) {
    const option = document.createElement("option");
    option.value = String(scale);
    option.textContent = scale === selectedGradeScale
      ? `Subject scale (out of ${scale})`
      : `Out of ${scale}`;
    scaleSelect.append(option);
  }
  scaleSelect.value = String(chartScale);
  scaleSelect.addEventListener("change", () => {
    gradeChartScales.set(subject, Number(scaleSelect.value));
    renderGradeChart(grades);
    document.querySelector("#grade-chart-scale").focus();
  });
  scaleField.append(scaleLabel, scaleSelect);
  chart.append(scaleField);
  const note = document.createElement("p");
  note.className = "grade-chart-note";
  note.textContent = `Scores are displayed out of ${chartScale}. Results on other scales are converted proportionally; original scores are shown below.`;
  if (!grades.length) {
    const empty = document.createElement("p");
    empty.className = "grade-summary-empty";
    empty.textContent = "Add a result to see it on your graph.";
    chart.append(empty);
  }
  const layout = document.createElement("div");
  layout.className = "grade-chart-layout";
  const axis = document.createElement("div");
  axis.className = "grade-chart-axis";
  const intervals = chartScale <= 10 ? chartScale : 5;
  for (let i = intervals; i >= 0; i--) {
    const tick = document.createElement("span");
    tick.textContent = String(Number((chartScale * i / intervals).toFixed(2)));
    tick.style.top = `${(intervals - i) / intervals * 100}%`;
    axis.append(tick);
  }
  const plot = document.createElement("div");
  plot.className = "grade-chart-plot";
  plot.style.setProperty("--grade-grid-step", `${100 / intervals}%`);
  const groups = new Map(["A", "B", "C", "D"].map((criterion) => [criterion, []]));
  grades.forEach((grade, index) => {
    const name = grade.criterion || "Unassigned";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push({ grade, index });
  });
  const legend = document.createElement("ul");
  legend.className = "grade-chart-legend";
  for (const [name, items] of groups) {
    const group = document.createElement("div");
    group.className = "grade-chart-group";
    const bars = document.createElement("div");
    bars.className = "grade-chart-bars";
    for (const { grade, index } of items) {
      if (name !== "Unassigned") {
        const bar = document.createElement("div");
        bar.className = `grade-chart-bar grade-chart-color-${index % 6}`;
        bar.style.height = `${grade.score / grade.maxScore * 100}%`;
        bar.title = `${grade.assessment}: ${grade.score}/${grade.maxScore}`;
        bar.setAttribute("role", "img");
        bar.setAttribute("aria-label", `Criterion ${name}, ${grade.assessment}: ${grade.score} out of ${grade.maxScore}`);
        bars.append(bar);
      }
      const item = document.createElement("li");
      const swatch = document.createElement("span");
      swatch.className = `grade-chart-swatch grade-chart-color-${index % 6}`;
      const label = document.createElement("span");
      label.textContent = `${name === "Unassigned" ? "No criterion: " : ""}${grade.assessment} (${grade.score}/${grade.maxScore})`;
      const remove = document.createElement("button");
      remove.className = "grade-delete";
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove ${grade.subject} ${grade.assessment} result`);
      remove.addEventListener("click", async () => {
        if (!window.confirm(`Remove ${grade.assessment} (${grade.score}/${grade.maxScore})?`)) return;
        try {
          await requestJson(`/api/grades/${grade.id}`, {}, "DELETE");
          await loadGrades();
          showGradeStatus("Assessment result removed.");
        } catch (error) {
          showGradeStatus(error.message, "error");
        }
      });
      item.append(swatch, label, remove);
      legend.append(item);
    }
    if (name !== "Unassigned") {
      const label = document.createElement("p");
      label.textContent = name;
      group.append(bars, label);
      plot.append(group);
    }
  }
  layout.append(axis, plot);
  chart.append(note, layout, legend);
}

function renderGrades() {
  const subject = gradeSubjectSelect.value;
  const grades = savedGrades.filter((grade) => grade.subject.toLowerCase() === subject.toLowerCase());
  renderGradeChart(grades);
  renderGradeSchedule(subject);
}

function renderGradeSchedule(subject) {
  const container = document.querySelector("#grade-scheduled-tasks");
  container.replaceChildren();
  const upcoming = tasks.filter((task) => !task.completed && task.subject.trim().toLowerCase() === subject.toLowerCase());
  if (!upcoming.length) {
    const empty = document.createElement("p");
    empty.className = "grade-summary-empty";
    empty.textContent = "No upcoming calendar tasks for this subject.";
    container.append(empty);
    return;
  }
  container.className = "grade-schedule-list";
  for (const task of upcoming) {
    const row = document.createElement("article");
    const dueStatus = taskDueStatus(task.dueDate);
    row.className = `grade-scheduled-task due-${dueStatus.key}`;
    const details = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = task.title;
    const info = document.createElement("small");
    const linkedGrades = savedGrades.filter((grade) => grade.taskId === task.id);
    const scores = linkedGrades.map((grade) => `${grade.criterion || "Score"}: ${grade.score}/${grade.maxScore}`).join(" · ");
    info.textContent = [
      task.dueDate ? `Due ${formatDueDate(task.dueDate)}` : "No due date",
      task.criteria.length ? `Criteria ${task.criteria.join(", ")}` : "No criteria selected",
      scores || "No scores yet",
    ].join(" · ");
    const add = document.createElement("button");
    add.type = "button";
    add.className = "grade-secondary-button";
    add.textContent = "Add score";
    add.setAttribute("aria-label", `Add score for ${task.title}`);
    add.addEventListener("click", () => openGradeEntry(task));
    const badge = document.createElement("span");
    badge.className = `grade-due-badge due-${dueStatus.key}`;
    badge.textContent = dueStatus.label;
    details.append(title, info);
    row.append(details, badge, add);
    container.append(row);
  }
}

async function loadGrades() {
  const response = await fetch("/api/grades", { credentials: "same-origin" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Could not load your grades.");
  savedGrades = result.grades;
  if (gradeSubjects.length) renderGrades();
}

function showGradeStatus(message, type = "success") {
  const status = document.querySelector("#grade-status");
  status.textContent = message;
  status.classList.toggle("error", type === "error");
}

const gradeScaleForm = document.querySelector("#grade-scale-form");
const gradeCustomScaleField = document.querySelector("#grade-custom-scale-field");
const gradeCustomScale = document.querySelector("#grade-custom-scale");
const gradeMaxScoreInput = document.querySelector("#grade-max-score");
const gradeScoreInput = document.querySelector("#grade-score");
const gradeScorePreview = document.querySelector("#grade-score-preview");
const gradeSetupSubject = document.querySelector("#grade-setup-subject");

async function loadGradeSubjects(selectedSubject = gradeSubjectSelect.value) {
  const response = await fetch("/api/grade-subjects", { credentials: "same-origin" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Could not load your subjects.");
  gradeSubjects = result.subjects;
  gradeSubjectSelect.replaceChildren();
  for (const subject of gradeSubjects) {
    const option = document.createElement("option");
    option.value = subject.subject;
    option.textContent = subject.subject;
    gradeSubjectSelect.append(option);
  }
  const selected = gradeSubjects.find((item) => item.subject.toLowerCase() === selectedSubject.toLowerCase());
  if (selected) gradeSubjectSelect.value = selected.subject;
  if (gradeSubjects.length) {
    gradeScaleForm.hidden = true;
    document.querySelector("#grade-tracker").hidden = false;
    selectGradeSubject();
  }
}

function selectGradeSubject() {
  const subject = gradeSubjects.find((item) => item.subject === gradeSubjectSelect.value);
  if (!subject) return;
  selectedGradeScale = subject.maxScore;
  gradeMaxScoreInput.value = String(selectedGradeScale);
  document.querySelector("#grade-scale-label").textContent = `Marked out of ${selectedGradeScale}`;
  populateGradeTaskOptions();
  updateGradeScorePreview();
  renderGrades();
}

gradeSubjectSelect.addEventListener("change", () => {
  document.querySelector("#grade-form").reset();
  document.querySelector("#grade-task-status").textContent = "";
  selectGradeSubject();
});

const gradeAddTaskButton = document.querySelector("#grade-add-task");
const gradeTaskEntry = document.querySelector("#grade-task-entry");
gradeAddTaskButton.addEventListener("click", () => {
  gradeTaskEntry.hidden = !gradeTaskEntry.hidden;
  gradeAddTaskButton.setAttribute("aria-expanded", String(!gradeTaskEntry.hidden));
  if (!gradeTaskEntry.hidden) document.querySelector("#grade-task-title").focus();
});

gradeTaskEntry.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const button = form.querySelector('button[type="submit"]');
  const status = document.querySelector("#grade-task-status");
  let saved = false;
  button.disabled = true;
  status.textContent = "";
  status.classList.remove("error");
  try {
    await requestJson("/api/tasks", {
      title: data.get("title"),
      subject: gradeSubjectSelect.value,
      dueDate: data.get("dueDate"),
      criteria: data.getAll("criteria"),
    });
    saved = true;
    form.reset();
    await loadTasks();
    const selectedTask = gradeTaskInput.value;
    const selectedCriterion = gradeCriterionInput.value;
    populateGradeTaskOptions();
    gradeTaskInput.value = selectedTask;
    const task = tasks.find((item) => String(item.id) === selectedTask);
    populateGradeCriteria(task);
    gradeCriterionInput.value = selectedCriterion;
    renderGrades();
    gradeTaskEntry.hidden = true;
    gradeAddTaskButton.setAttribute("aria-expanded", "false");
    status.textContent = "Assessment added to your calendar.";
    gradeAddTaskButton.focus();
  } catch (error) {
    if (saved) {
      gradeTaskEntry.hidden = true;
      gradeAddTaskButton.setAttribute("aria-expanded", "false");
      status.textContent = "Assessment saved, but the list could not refresh. Reload the page.";
    } else {
      status.textContent = error.message;
    }
    status.classList.add("error");
  } finally {
    button.disabled = false;
  }
});

gradeScaleForm.addEventListener("change", () => {
  const isCustom = gradeScaleForm.elements.scale.value === "custom";
  gradeCustomScaleField.hidden = !isCustom;
  gradeCustomScale.required = isCustom;
});

gradeScaleForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const choice = gradeScaleForm.elements.scale.value;
  const maximum = Number(choice === "custom" ? gradeCustomScale.value : choice);
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 10000) {
    gradeCustomScale.reportValidity();
    return;
  }
  const button = gradeScaleForm.querySelector('button[type="submit"]');
  const status = document.querySelector("#grade-scale-status");
  button.disabled = true;
  status.textContent = "";
  try {
    const result = await requestJson("/api/grade-subjects", { subject: gradeSetupSubject.value, maxScore: maximum });
    await loadGradeSubjects(result.subject.subject);
    if (pendingGradeTask && pendingGradeTask.subject.trim().toLowerCase() === result.subject.subject.toLowerCase()) {
      openGradeEntry(pendingGradeTask);
      pendingGradeTask = null;
    } else {
      document.querySelector("#grade-add-result").focus();
    }
  } catch (error) {
    status.textContent = error.message;
    status.classList.add("error");
  } finally {
    button.disabled = false;
  }
});

function openGradeSetup(edit) {
  gradeScaleForm.reset();
  gradeSetupSubject.value = edit ? gradeSubjectSelect.value : "";
  gradeSetupSubject.readOnly = edit;
  gradeCustomScaleField.hidden = true;
  gradeCustomScale.required = false;
  document.querySelector("#grade-scale-status").textContent = "";
  if (edit) {
    const choice = selectedGradeScale === 8 || selectedGradeScale === 100 ? String(selectedGradeScale) : "custom";
    gradeScaleForm.elements.scale.value = choice;
    if (choice === "custom") {
      gradeCustomScaleField.hidden = false;
      gradeCustomScale.required = true;
      gradeCustomScale.value = String(selectedGradeScale);
    }
  }
  document.querySelector("#grade-cancel-scale").hidden = !gradeSubjects.length;
  document.querySelector("#grade-tracker").hidden = true;
  gradeScaleForm.hidden = false;
  gradeSetupSubject.focus();
}
document.querySelector("#grade-change-scale").addEventListener("click", () => openGradeSetup(true));
document.querySelector("#grade-add-subject").addEventListener("click", () => openGradeSetup(false));
document.querySelector("#grade-cancel-scale").addEventListener("click", () => {
  pendingGradeTask = null;
  gradeScaleForm.hidden = true;
  document.querySelector("#grade-tracker").hidden = false;
  gradeSubjectSelect.focus();
});

const gradeEntry = document.querySelector("#grade-entry");
const gradeAddResult = document.querySelector("#grade-add-result");
const gradeTaskInput = document.querySelector("#grade-task");
const gradeCriterionInput = document.querySelector("#grade-criterion");
let pendingGradeTask = null;

function populateGradeCriteria(task) {
  const allowed = task?.criteria?.length ? task.criteria : ["A", "B", "C", "D"];
  gradeCriterionInput.value = "";
  for (const option of gradeCriterionInput.options) {
    if (option.value) option.hidden = !allowed.includes(option.value);
  }
}

function populateGradeTaskOptions() {
  gradeTaskInput.replaceChildren(new Option("No linked task", ""));
  for (const task of tasks.filter((item) => item.subject.trim().toLowerCase() === gradeSubjectSelect.value.toLowerCase())) {
    gradeTaskInput.add(new Option(`${task.title}${task.dueDate ? ` · ${formatDueDate(task.dueDate)}` : ""}`, String(task.id)));
  }
  document.querySelector("#grade-result-date-field").hidden = false;
  document.querySelector("#grade-result-date").disabled = false;
  populateGradeCriteria(null);
}

gradeTaskInput.addEventListener("change", () => {
  const task = tasks.find((item) => String(item.id) === gradeTaskInput.value);
  const dateField = document.querySelector("#grade-result-date-field");
  dateField.hidden = Boolean(task);
  document.querySelector("#grade-result-date").disabled = Boolean(task);
  populateGradeCriteria(task);
  if (task) document.querySelector("#grade-assessment").value = task.title;
});

function openGradeEntry(task) {
  gradeEntry.hidden = false;
  gradeAddResult.setAttribute("aria-expanded", "true");
  gradeTaskInput.value = String(task.id);
  gradeTaskInput.dispatchEvent(new Event("change"));
  gradeCriterionInput.focus();
}

function prepareGradeTaskFromUrl() {
  const id = new URLSearchParams(window.location.search).get("taskId");
  if (!id) return;
  const task = tasks.find((item) => String(item.id) === id);
  if (!task || !task.subject || task.subject.length > 60) {
    showGradeStatus("This task needs a subject (up to 60 characters) before you can add a score.", "error");
    return;
  }
  const subject = gradeSubjects.find((item) => item.subject.toLowerCase() === task.subject.trim().toLowerCase());
  if (subject) {
    gradeSubjectSelect.value = subject.subject;
    selectGradeSubject();
    openGradeEntry(task);
  } else {
    pendingGradeTask = task;
    openGradeSetup(false);
    gradeSetupSubject.value = task.subject;
    document.querySelector("#grade-scale-status").textContent = "Choose a grading scale for this task's subject.";
  }
}
gradeAddResult.addEventListener("click", () => {
  gradeEntry.hidden = !gradeEntry.hidden;
  gradeAddResult.setAttribute("aria-expanded", String(!gradeEntry.hidden));
  if (!gradeEntry.hidden) document.querySelector("#grade-assessment").focus();
});

function updateGradeScorePreview() {
  const maximum = Number(gradeMaxScoreInput.value);
  gradeScoreInput.max = Number.isInteger(maximum) && maximum >= 1 && maximum <= 10000
    ? String(maximum)
    : "10000";
  const score = Number(gradeScoreInput.value);
  if (!gradeScoreInput.value || !gradeMaxScoreInput.value || !gradeScoreInput.validity.valid ||
      !gradeMaxScoreInput.validity.valid || score > maximum) {
    gradeScorePreview.textContent = "Enter a valid score and maximum to see its percentage.";
    return;
  }
  const percentage = Math.round((score / maximum) * 10000) / 100;
  gradeScorePreview.textContent = `${score} out of ${maximum} = ${percentage}%`;
}

document.querySelector("#grade-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const data = new FormData(form);
  button.disabled = true;
  let saved = false;
  try {
    await requestJson("/api/grades", {
      subject: gradeSubjectSelect.value,
      assessment: data.get("assessment"),
      criterion: data.get("criterion"),
      taskId: data.get("taskId") ? Number(data.get("taskId")) : null,
      createCalendarTask: !data.get("taskId"),
      dueDate: data.get("dueDate") || null,
      score: Number(data.get("score")),
      maxScore: Number(data.get("maxScore")),
    });
    saved = true;
    form.reset();
    gradeMaxScoreInput.value = String(selectedGradeScale);
    document.querySelector("#grade-result-date-field").hidden = false;
    document.querySelector("#grade-result-date").disabled = false;
    await loadTasks();
    populateGradeTaskOptions();
    updateGradeScorePreview();
    await loadGrades();
    showGradeStatus("Assessment result added to Grades and Calendar.");
    gradeEntry.hidden = true;
    gradeAddResult.setAttribute("aria-expanded", "false");
    gradeAddResult.focus();
  } catch (error) {
    showGradeStatus(saved ? "Result saved, but the page could not refresh. Reload to see it." : error.message, "error");
  } finally {
    button.disabled = false;
  }
});

gradeMaxScoreInput.addEventListener("input", updateGradeScorePreview);
gradeScoreInput.addEventListener("input", updateGradeScorePreview);

function showTaskStatus(message, type = "success") {
  const status = document.querySelector("#task-status");
  status.textContent = message;
  status.classList.toggle("error", type === "error");
}

function cleanSourceText(value) {
  return String(value ?? "")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&ndash;/gi, "–")
    .replace(/&mdash;/gi, "—")
    .replace(/&rsquo;/gi, "’")
    .replace(/&lsquo;/gi, "‘")
    .replace(/&rdquo;/gi, "”")
    .replace(/&ldquo;/gi, "“")
    .replace(/\s+/g, " ")
    .trim();
}

function estimateReadingLevel(abstract) {
  const text = cleanSourceText(abstract);
  const words = text.match(/[A-Za-z]+(?:['’][A-Za-z]+)?/g) || [];
  if (words.length < 40) return null;

  const sentenceCount = Math.max(1, (text.match(/[.!?]+/g) || []).length);
  const syllables = words.reduce((total, word) => {
    let normalized = word.toLowerCase().replace(/[^a-z]/g, "");
    if (normalized.length <= 3) return total + 1;
    const groups = normalized.match(/[aeiouy]+/g) || [];
    let count = groups.length;
    if (normalized.endsWith("e") && !normalized.endsWith("le") && count > 1) count -= 1;
    return total + Math.max(1, count);
  }, 0);
  const ease = 206.835 - 1.015 * (words.length / sentenceCount) - 84.6 * (syllables / words.length);
  return ease >= 60 ? "Easy" : ease >= 30 ? "Medium" : "Hard";
}

function mediaSearchUrls(source) {
  const title = cleanSourceText(source.title);
  const author = cleanSourceText(source.authors?.[0] || "");
  const search = [title, author].filter(Boolean).join(" ");
  const imageParams = new URLSearchParams({ type: "image", search });
  return {
    images: `https://commons.wikimedia.org/wiki/Special:MediaSearch?${imageParams}`,
    videos: `https://www.youtube.com/results?search_query=${encodeURIComponent(search)}`,
  };
}

function createWikimediaPhoto(source, className, index = 0) {
  const unavailablePhoto = () => {
    const unavailable = document.createElement("div");
    unavailable.className = `${className}-placeholder`;
    unavailable.textContent = "Wikimedia Commons image unavailable.";
    return unavailable;
  };
  if (source.image?.url && source.image?.pageUrl) {
    const photo = document.createElement("img");
    photo.className = className;
    photo.alt = `Illustrative image from Wikimedia Commons: ${cleanSourceText(source.image.title)}`;
    photo.loading = index === 0 ? "eager" : "lazy";
    photo.decoding = "async";
    photo.addEventListener("error", () => {
      if (source.image.fallbackUrl && photo.src !== source.image.fallbackUrl) {
        photo.src = source.image.fallbackUrl;
      } else {
        photo.replaceWith(unavailablePhoto());
      }
    });
    photo.src = source.image.url;
    return photo;
  }
  return unavailablePhoto();
}

function createRecentSourceCard(source, index) {
  const card = document.createElement("article");
  card.className = "recent-source-card";
  card.setAttribute("aria-label", `Recent source ${index + 1}: ${cleanSourceText(source.title)}`);
  card.append(createWikimediaPhoto(source, "recent-source-thumbnail", index));
  const content = document.createElement("div");
  content.className = "recent-source-copy";
  const date = document.createElement("p");
  date.className = "recent-source-date";
  date.textContent = source.year ? `Published ${source.year}` : "Recent Crossref record";
  const title = document.createElement("h3");
  title.textContent = cleanSourceText(source.title);
  const authors = document.createElement("p");
  authors.className = "recent-source-authors";
  authors.textContent = source.authors?.length
    ? cleanSourceText(source.authors.slice(0, 2).join(", "))
    : cleanSourceText(source.publisher || "Author not listed");

  content.append(date, title, authors);
  if (source.image?.url && source.image?.pageUrl) {
    const attribution = document.createElement("p");
    attribution.className = "recent-source-image-attribution";
    attribution.append("Illustrative image · ");
    const imageSource = document.createElement("a");
    imageSource.href = source.image.pageUrl;
    imageSource.target = "_blank";
    imageSource.rel = "noopener noreferrer";
    imageSource.textContent = "Wikimedia Commons source and license ↗";
    attribution.append(imageSource);
    content.append(attribution);
  }

  const links = document.createElement("div");
  links.className = "recent-source-links";
  const mediaUrls = mediaSearchUrls(source);
  const videoLink = document.createElement("a");
  videoLink.href = mediaUrls.videos;
  videoLink.target = "_blank";
  videoLink.rel = "noopener noreferrer";
  videoLink.textContent = "Related videos ↗";
  videoLink.title = "Search YouTube for videos about this source";
  links.append(videoLink);
  if (source.doi) {
    const details = document.createElement("a");
    details.href = `/source-information?doi=${encodeURIComponent(source.doi)}`;
    details.textContent = "Read record →";
    links.append(details);
  }
  content.append(links);
  card.append(content);
  return card;
}

function createSourceExampleCard(source, index) {
  const card = document.createElement("article");
  card.className = "source-example-card";
  card.append(createWikimediaPhoto(source, "source-example-photo", index));
  const content = document.createElement("div");
  content.className = "source-example-copy";
  const date = document.createElement("p");
  date.className = "recent-source-date";
  date.textContent = source.year ? `Published ${source.year}` : "Recent Crossref record";
  const title = document.createElement("h3");
  title.textContent = cleanSourceText(source.title);
  const authors = document.createElement("p");
  authors.textContent = source.authors?.length
    ? cleanSourceText(source.authors.slice(0, 2).join(", "))
    : cleanSourceText(source.publisher || "Author not listed");
  content.append(date, title, authors);
  if (source.image?.pageUrl) {
    const attribution = document.createElement("a");
    attribution.className = "source-example-attribution";
    attribution.href = source.image.pageUrl;
    attribution.target = "_blank";
    attribution.rel = "noopener noreferrer";
    attribution.textContent = "Image & license ↗";
    content.append(attribution);
  }
  if (source.doi) {
    const details = document.createElement("a");
    details.className = "source-example-link";
    details.href = `/source-information?doi=${encodeURIComponent(source.doi)}`;
    details.textContent = "Explore this record →";
    content.append(details);
  }
  card.append(content);
  return card;
}

function renderSourceExamples(
  sources,
  listSelector = "#source-example-list",
  statusSelector = "#source-examples-status",
) {
  const list = document.querySelector(listSelector);
  const status = document.querySelector(statusSelector);
  const examples = sources.slice(0, 3);
  list.replaceChildren(...examples.map((source, index) => createSourceExampleCard(source, index)));
  status.textContent = examples.length
    ? `A few of ${sources.length} recent Crossref records. Open a record to inspect its details.`
    : "No recent Crossref records are available to show as examples.";
}

function updateRecentSourcePosition() {
  document.querySelector("#recent-source-position").textContent = `${recentSourceIndex + 1} of ${recentSources.length}`;
  document.querySelector("#recent-sources-previous").disabled = recentSources.length < 2;
  document.querySelector("#recent-sources-next").disabled = recentSources.length < 2;
}

function renderRecentSource() {
  const display = document.querySelector("#recent-source-display");
  if (!display || !recentSources.length) return;
  display.hidden = false;
  display.scrollTo({
    top: display.children[recentSourceIndex]?.offsetTop || 0,
    behavior: recentRotationPaused ? "auto" : "smooth",
  });
  updateRecentSourcePosition();
}

function setRecentRotationPaused(paused, userInitiated = false) {
  recentRotationPaused = paused;
  const button = document.querySelector("#recent-sources-pause");
  button.textContent = paused ? "Play" : "Pause";
  button.setAttribute("aria-label", paused ? "Resume recent source rotation" : "Pause recent source rotation");
  button.setAttribute("aria-pressed", String(paused));
  if (recentRotationTimer !== null) window.clearInterval(recentRotationTimer);
  recentRotationTimer = null;
  if (!paused && recentSources.length > 1 &&
      (userInitiated || !window.matchMedia("(prefers-reduced-motion: reduce)").matches)) {
    recentRotationTimer = window.setInterval(() => {
      recentSourceIndex = (recentSourceIndex + 1) % recentSources.length;
      renderRecentSource();
    }, 7000);
  }
}

async function loadRecentSources() {
  const status = document.querySelector("#recent-sources-status");
  if (!status) return;
  status.textContent = "Loading recent publications…";
  try {
    const response = await fetch("/api/sources/recent", { credentials: "same-origin" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not load recent sources.");
    recentSources = result.sources;
    renderSourceExamples(recentSources);
    recentSourceIndex = 0;
    if (!recentSources.length) {
      status.textContent = "No recent publication records were returned. Try a topic search instead.";
      const display = document.querySelector("#recent-source-display");
      display.replaceChildren();
      display.hidden = true;
      document.querySelector("#recent-source-position").textContent = "0 of 0";
      setRecentRotationPaused(true);
      return;
    }
    const display = document.querySelector("#recent-source-display");
    display.replaceChildren(
      ...recentSources.map((source, index) => createRecentSourceCard(source, index)),
    );
    renderRecentSource();
    setRecentRotationPaused(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const photoCount = recentSources.filter((source) => source.image?.url).length;
    status.textContent = photoCount
      ? "Recent Crossref sources with general Wikimedia Commons illustrations."
      : "Crossref sources loaded, but no Wikimedia Commons images are available right now.";
  } catch (error) {
    status.textContent = error.message;
    renderSourceExamples([]);
    document.querySelector("#source-examples-status").textContent = "Real source examples could not be loaded right now.";
    const display = document.querySelector("#recent-source-display");
    display.replaceChildren();
    display.hidden = true;
    document.querySelector("#recent-source-position").textContent = "—";
    setRecentRotationPaused(true);
  }
}

function renderSources(sources, query = "", targetSelector = "#source-results") {
  const results = document.querySelector(targetSelector);
  results.replaceChildren();
  for (const [index, source] of sources.entries()) {
    const card = document.createElement("article");
    card.className = "source-card";
    const thumbnail = createWikimediaPhoto(source, "source-thumbnail", index);
    const content = document.createElement("div");
    content.className = "source-card-content";
    const title = document.createElement("h2");
    title.textContent = cleanSourceText(source.title);
    const authors = document.createElement("p");
    authors.className = "source-authors";
    authors.textContent = `Author: ${cleanSourceText(source.authors.join(", ")) || "Not listed"}`;
    const origin = document.createElement("p");
    origin.className = "source-origin";
    origin.textContent = `Publisher: ${cleanSourceText(source.publisher) || "Not listed"} · Journal / publication: ${cleanSourceText(source.publication) || "Not listed"} · Year: ${source.year || "Not listed"}`;
    const metadata = document.createElement("div");
    metadata.className = "source-tags";
    for (const label of [source.year].filter(Boolean)) {
      const tag = document.createElement("span");
      tag.textContent = label;
      metadata.append(tag);
    }
    const compatibilityTag = createSourceCompatibilityTag(source.compatibility);
    if (compatibilityTag) metadata.append(compatibilityTag);
    const readingLevel = estimateReadingLevel(source.abstract);
    const levelTag = document.createElement("span");
    levelTag.className = `source-level ${readingLevel ? `source-level-${readingLevel.toLowerCase()}` : "source-level-unavailable"}`;
    levelTag.textContent = readingLevel ? `Reading: ${readingLevel} (est.)` : "Reading level unavailable";
    levelTag.setAttribute(
      "aria-label",
      readingLevel ? `Estimated reading level: ${readingLevel}` : "Reading level unavailable: not enough abstract text",
    );
    levelTag.title = readingLevel
      ? "Approximate estimate based on the publisher abstract."
      : "The record does not have enough abstract text for an estimate.";
    metadata.append(levelTag);
    const actions = document.createElement("div");
    actions.className = "source-card-actions";
    if (source.doi) {
      const details = document.createElement("a");
      details.className = "source-details-link";
      const params = new URLSearchParams({ doi: source.doi });
      if (query) params.set("q", query);
      details.href = `/source-information?${params}`;
      details.textContent = "Source information →";
      actions.append(details);
    }
    if (source.url) {
      const original = document.createElement("a");
      original.className = "source-original-link";
      original.href = source.url;
      original.target = "_blank";
      original.rel = "noopener noreferrer";
      original.textContent = "Open original ↗";
      actions.append(original);
    }
    if (source.image?.pageUrl) {
      const photoSource = document.createElement("a");
      photoSource.className = "source-media-link";
      photoSource.href = source.image.pageUrl;
      photoSource.target = "_blank";
      photoSource.rel = "noopener noreferrer";
      photoSource.textContent = "Image source & license ↗";
      actions.append(photoSource);
    }
    const mediaUrls = mediaSearchUrls(source);
    const images = document.createElement("a");
    images.className = "source-media-link";
    images.href = mediaUrls.images;
    images.target = "_blank";
    images.rel = "noopener noreferrer";
    images.textContent = "Find images ↗";
    images.title = "Search Wikimedia Commons for open-license images about this source";
    const videos = document.createElement("a");
    videos.className = "source-media-link";
    videos.href = mediaUrls.videos;
    videos.target = "_blank";
    videos.rel = "noopener noreferrer";
    videos.textContent = "Find videos ↗";
    videos.title = "Search YouTube for videos about this source";
    actions.append(images, videos);
    const warning = document.createElement("p");
    warning.className = "source-evidence-warning";
    warning.textContent = "Check the original source and compare its evidence before trusting or citing it.";
    content.append(title, authors, origin, metadata, warning, actions);
    card.append(thumbnail, content);
    results.append(card);
  }
}

function sourceCompatibilityDetails(compatibility) {
  const level = ["high", "medium", "low"].includes(compatibility?.level)
    ? compatibility.level
    : null;
  if (!level) return null;
  const score = Number.isFinite(compatibility.score)
    ? Math.max(0, Math.min(100, Math.round(compatibility.score)))
    : null;
  return {
    level,
    label: level === "low" ? "Very low compatibility" : `${level[0].toUpperCase()}${level.slice(1)} compatibility`,
    score,
  };
}

function createSourceCompatibilityTag(compatibility) {
  const details = sourceCompatibilityDetails(compatibility);
  if (!details) return null;
  const tag = document.createElement("span");
  tag.className = `source-compatibility-tag source-compatibility-${details.level}`;
  tag.textContent = details.label;
  tag.title = `Estimated topic match${details.score === null ? "" : `: ${details.score}%`} based on record metadata and abstract. This is not a quality or reliability rating.`;
  return tag;
}

document.querySelector("#recent-sources-previous").addEventListener("click", () => {
  if (recentSources.length < 2) return;
  recentSourceIndex = (recentSourceIndex - 1 + recentSources.length) % recentSources.length;
  renderRecentSource();
});

document.querySelector("#recent-sources-next").addEventListener("click", () => {
  if (recentSources.length < 2) return;
  recentSourceIndex = (recentSourceIndex + 1) % recentSources.length;
  renderRecentSource();
});

document.querySelector("#recent-sources-pause").addEventListener("click", () => {
  setRecentRotationPaused(!recentRotationPaused, true);
});

document.querySelector("#recent-source-display").addEventListener("scroll", (event) => {
  const display = event.currentTarget;
  if (!display.clientHeight) return;
  const index = Math.max(0, Math.min(recentSources.length - 1, Math.round(display.scrollTop / display.clientHeight)));
  if (index !== recentSourceIndex) {
    recentSourceIndex = index;
    updateRecentSourcePosition();
  }
}, { passive: true });

async function searchSourceRecords(query, status, results, button, targetSelector) {
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  status.textContent = "Looking for scholarly works…";
  results.replaceChildren();
  try {
    const response = await fetch(`/api/sources?q=${encodeURIComponent(query)}`, { credentials: "same-origin" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not search sources.");
    renderSources(result.sources, query, targetSelector);
    status.textContent = result.sources.length
      ? `Found ${result.sources.length} scholarly records. Open a record to learn more.`
      : "No results found. Try a broader topic or different keywords.";
    if (result.sources.length && result.sources.some((source) => !source.image)) {
      status.append(" Some topic images are unavailable.");
    }
    if (!result.sources.length && result.suggestion) {
      const suggestion = document.createElement("button");
      suggestion.type = "button";
      suggestion.className = "source-suggestion";
      suggestion.textContent = `Search for “${result.suggestion}” instead`;
      suggestion.addEventListener("click", () => {
        const form = button.form;
        form.elements.q.value = result.suggestion;
        form.elements.q.dispatchEvent(new Event("input", { bubbles: true }));
        form.requestSubmit(button);
      });
      status.append(" ", suggestion);
    } else if (result.suggestionUnavailable) {
      status.append(" Spelling suggestions are unavailable right now.");
    }
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

document.querySelectorAll("[data-external-search]").forEach((container) => {
  const form = document.getElementById(container.dataset.externalSearch);
  const updateLinks = () => {
    const query = form.elements.q.value.trim();
    for (const link of container.querySelectorAll("[data-google-search]")) {
      const url = new URL("https://www.google.com/search");
      if (query) url.searchParams.set("q", query);
      if (link.dataset.googleSearch === "images") url.searchParams.set("udm", "2");
      link.href = url.toString();
    }
  };
  form.elements.q.addEventListener("input", updateLinks);
  form.addEventListener("submit", updateLinks);
  updateLinks();
});

document.querySelector("#source-search-form").addEventListener("submit", async (event) => {
  if (!event.submitter?.matches("[data-crossref-search]")) return;
  event.preventDefault();
  const form = event.currentTarget;
  const query = new FormData(form).get("q").trim();
  await searchSourceRecords(
    query,
    document.querySelector("#source-search-status"),
    document.querySelector("#source-results"),
    event.submitter,
    "#source-results",
  );
});

const sourceInformationSearchForm = document.querySelector("#source-information-search-form");
const sourceInformationGoogleLink = document.querySelector("#source-information-google-link");
function updateGoogleScholarSearch(query) {
  const searchUrl = new URL("https://scholar.google.com/scholar");
  if (query.trim()) searchUrl.searchParams.set("q", query.trim());
  sourceInformationGoogleLink.href = searchUrl.toString();
}

sourceInformationSearchForm.elements.q.addEventListener("input", (event) => {
  updateGoogleScholarSearch(event.currentTarget.value);
});
sourceInformationSearchForm.addEventListener("submit", async (event) => {
  if (!event.submitter?.matches("[data-crossref-search]")) return;
  event.preventDefault();
  const form = event.currentTarget;
  const query = new FormData(form).get("q").trim();
  await searchSourceRecords(
    query,
    document.querySelector("#source-information-search-status"),
    document.querySelector("#source-information-results"),
    event.submitter,
    "#source-information-results",
  );
});

async function loadSourceDetails() {
  const searchParams = new URLSearchParams(window.location.search);
  const doi = searchParams.get("doi");
  const query = searchParams.get("q") || "";
  const status = document.querySelector("#source-detail-status");
  const detail = document.querySelector("#source-detail");
  const examples = document.querySelector("#source-information-examples");
  if (query) {
    sourceInformationSearchForm.elements.q.value = query;
    updateGoogleScholarSearch(query);
    sourceInformationSearchForm.elements.q.dispatchEvent(new Event("input"));
  }
  if (!doi) {
    examples.hidden = false;
    status.textContent = "A few recent sources to explore. Search for your own topic to find more.";
    try {
      const response = await fetch("/api/sources/recent", { credentials: "same-origin" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not load recent sources.");
      renderSourceExamples(result.sources, "#source-information-example-list", "#source-information-examples-status");
    } catch (error) {
      const list = document.querySelector("#source-information-example-list");
      list.replaceChildren();
      document.querySelector("#source-information-examples-status").textContent =
        "Recent source records could not be loaded right now. You can still search Crossref for a topic.";
    }
    return;
  }
  examples.hidden = true;
  status.textContent = "Loading source information…";
  try {
    const params = new URLSearchParams({ doi });
    if (query) params.set("q", query);
    const response = await fetch(`/api/sources?${params}`, { credentials: "same-origin" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not load this source.");
    const source = result.source;
    const publisher = cleanSourceText(source.publisher);
    status.textContent = "";
    document.querySelector("#source-detail-kind").textContent = cleanSourceText(source.type);
    const workTitle = cleanSourceText(source.title);
    document.querySelector("#source-detail-title").textContent = query ? cleanSourceText(query) : workTitle;
    const workTitleElement = document.querySelector("#source-detail-work-title");
    workTitleElement.textContent = workTitle;
    workTitleElement.hidden = !query || query.toLocaleLowerCase() === workTitle.toLocaleLowerCase();
    document.querySelector("#source-detail-meta").textContent =
      [cleanSourceText(source.authors.join(", ")), publisher, source.year].filter(Boolean).join(" · ");
    const facts = document.querySelector("#source-detail-facts");
    facts.replaceChildren();
    for (const [label, value] of [
      ["Author", source.authors.join(", ")],
      ["Publisher", source.publisher],
      ["Journal / publication", source.publication],
      ["Publication year", source.year],
      ["Publication type", source.type],
      ["DOI", source.doi],
    ]) {
      const item = document.createElement("div");
      const term = document.createElement("dt");
      const description = document.createElement("dd");
      term.textContent = label;
      description.textContent = cleanSourceText(value) || "Not listed";
      item.append(term, description);
      facts.append(item);
    }
    const compatibility = sourceCompatibilityDetails(source.compatibility);
    const compatibilityPanel = document.querySelector("#source-detail-compatibility");
    const compatibilityTag = document.querySelector("#source-detail-compatibility-level");
    compatibilityPanel.hidden = false;
    compatibilityTag.className = compatibility
      ? `source-compatibility-tag source-compatibility-${compatibility.level}`
      : "source-compatibility-tag";
    compatibilityTag.textContent = compatibility?.label || "Relevance unavailable";
    document.querySelector("#source-detail-compatibility-explanation").textContent = compatibility
      ? `Estimated ${compatibility.score === null ? "" : `${compatibility.score}% `}keyword overlap with “${query},” based on this record’s title, abstract, publication and publisher. It is not a rating of source quality, accuracy, or reliability.`
      : "Search for a topic and open a result to see its estimated relevance.";
    document.querySelector("#source-detail-photo-slot").replaceChildren(
      createWikimediaPhoto(source, "source-detail-photo"),
    );
    const abstract = source.abstract
      ? cleanSourceText(source.abstract)
      : "This record does not include an abstract. Open the original source to read its summary and full text.";
    document.querySelector("#source-detail-abstract").textContent = abstract;
    const readingLevel = estimateReadingLevel(source.abstract);
    document.querySelector("#source-detail-reading-level").textContent = readingLevel
      ? `${readingLevel} (estimated from the publisher-provided abstract).`
      : "Unavailable: this record does not have enough abstract text for an estimate.";
    document.querySelector("#source-detail-reliability").textContent =
      publisher
        ? `${publisher} is listed as the publisher in Crossref. A publisher name alone does not establish credibility.`
        : "Publisher information is not listed in this Crossref record. A database record alone does not establish credibility.";
    const originalLink = document.querySelector("#source-detail-link");
    originalLink.href = source.url;
    originalLink.hidden = !source.url;
    const photoSourceLink = document.querySelector("#source-detail-photo-source-link");
    photoSourceLink.href = source.image?.pageUrl || "#";
    photoSourceLink.hidden = !source.image?.pageUrl;
    const mediaUrls = mediaSearchUrls(source);
    document.querySelector("#source-image-search-link").href = mediaUrls.images;
    document.querySelector("#source-video-search-link").href = mediaUrls.videos;
    document.querySelector("#source-chat-link").dataset.sourcePrompt = (
      `Explain this source in simple terms and help me decide what to check before citing it.\n\nTitle: ${source.title}\n\nPublisher-provided abstract: ${abstract.slice(0, 1400)}`
    ).slice(0, 1900);
    detail.hidden = false;
    document.querySelector("#source-information-content").classList.add("has-source-detail");
    document.querySelector("#source-detail-search-link").hidden = true;
  } catch (error) {
    status.textContent = error.message;
  }
}

document.querySelector("#task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = document.querySelector("#task-submit-button");
  const data = new FormData(form);
  button.disabled = true;
  try {
    const payload = {
      title: data.get("title"),
      subject: data.get("subject"),
      dueDate: data.get("dueDate"),
      criteria: data.getAll("criteria"),
    };
    if (editingTaskId !== null) payload.completed = document.querySelector("#task-completed").checked;
    await requestJson(
      editingTaskId === null ? "/api/tasks" : `/api/tasks/${editingTaskId}`,
      payload,
      editingTaskId === null ? "POST" : "PATCH",
    );
    const wasEditing = editingTaskId !== null;
    resetTaskForm(selectedCalendarDate);
    showTaskStatus(wasEditing ? "Task updated." : "Task added to your calendar.");
    await loadTasks();
  } catch (error) {
    showTaskStatus(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#calendar-previous").addEventListener("click", () => {
  visibleCalendarMonth = new Date(visibleCalendarMonth.getFullYear(), visibleCalendarMonth.getMonth() - 1, 1);
  selectedCalendarDate = "";
  renderCalendar();
});

document.querySelector("#calendar-next").addEventListener("click", () => {
  visibleCalendarMonth = new Date(visibleCalendarMonth.getFullYear(), visibleCalendarMonth.getMonth() + 1, 1);
  selectedCalendarDate = "";
  renderCalendar();
});

document.querySelector("#calendar-today").addEventListener("click", () => {
  const today = new Date();
  visibleCalendarMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  selectedCalendarDate = dateToCalendarValue(today);
  if (editingTaskId === null) document.querySelector("#task-due-date").value = selectedCalendarDate;
  renderCalendar();
});

document.querySelector("#task-cancel-edit").addEventListener("click", () => resetTaskForm());
document.querySelector("#task-delete-edit").addEventListener("click", () => {
  if (editingTaskId !== null) deleteTask(editingTaskId);
});

async function setupChat() {
  try {
    const response = await fetch("/api/config", { credentials: "same-origin" });
    const config = await response.json();
    aiConfigured = config.aiConfigured;
    document.querySelector("#chat-setup-note").hidden = aiConfigured;
    document.querySelector("#dashboard-chat-note").hidden = aiConfigured;
    document.querySelectorAll("[data-chat-form] button[type='submit']").forEach((button) => {
      button.disabled = !aiConfigured;
    });
    document.querySelectorAll("[data-chat-form] input").forEach((input) => {
      input.disabled = !aiConfigured;
      if (!aiConfigured) input.placeholder = "Chat Buddy setup required";
    });
    document.querySelectorAll("[data-chat-prompt]").forEach((button) => {
      button.disabled = !aiConfigured;
    });
    const pendingPrompt = sessionStorage.getItem("academicbuddy-chat-prompt");
    if (pendingPrompt && window.location.pathname === "/chat-buddy") {
      document.querySelector("#full-chat-input").value = pendingPrompt;
      sessionStorage.removeItem("academicbuddy-chat-prompt");
    }
  } catch {
    for (const id of ["#chat-setup-note", "#dashboard-chat-note"]) {
      const note = document.querySelector(id);
      note.textContent = "Could not check the Chat Buddy service configuration.";
      note.hidden = false;
    }
    document.querySelectorAll("[data-chat-form] button[type='submit'], [data-chat-form] input").forEach((control) => {
      control.disabled = true;
    });
    document.querySelectorAll("[data-chat-prompt]").forEach((button) => {
      button.disabled = true;
    });
  }
}

document.querySelector("#source-chat-link").addEventListener("click", (event) => {
  const prompt = event.currentTarget.dataset.sourcePrompt;
  if (!prompt) return;
  event.preventDefault();
  sessionStorage.setItem("academicbuddy-chat-prompt", prompt);
  window.location.assign("/chat-buddy");
});

function renderChat() {
  for (const container of [document.querySelector("#dashboard-chat-messages"), document.querySelector("#full-chat-messages")]) {
    container.replaceChildren();
    const empty = chatMessages.length === 0;
    container.classList.toggle("chat-empty-state", empty && container.id === "full-chat-messages");
    container.setAttribute("aria-busy", String(chatPending));
    const messages = chatMessages.length
      ? chatMessages
      : [{ role: "assistant", content: "Hi! Tell me what you are learning. We can take it one step at a time." }];
    for (const message of messages) {
      const isUser = message.role === "user";
      const line = document.createElement("div");
      line.className = `chat-line${isUser ? " chat-line-user" : " chat-line-buddy"}`;
      const bubble = document.createElement("div");
      bubble.className = `chat-message${isUser ? " chat-user" : ""}`;
      const heading = document.createElement("strong");
      heading.textContent = isUser ? "You" : "Chat Buddy";
      const copy = document.createElement("p");
      copy.className = "chat-response-copy";
      copy.textContent = message.content;
      bubble.append(heading, copy);
      line.append(bubble);
      container.append(line);
    }
    if (empty && container.id === "full-chat-messages") {
      const hint = document.createElement("p");
      hint.className = "chat-empty-hint";
      hint.textContent = "Choose a prompt below, or type what you are stuck on.";
      container.append(hint);
    }
    if (chatPending) {
      const line = document.createElement("div");
      line.className = "chat-line chat-line-buddy chat-typing";
      line.setAttribute("role", "status");
      line.setAttribute("aria-label", "Chat Buddy is thinking");
      const bubble = document.createElement("div");
      bubble.className = "chat-message chat-typing-bubble";
      const heading = document.createElement("strong");
      heading.textContent = "Chat Buddy";
      const dots = document.createElement("span");
      dots.className = "chat-typing-dots";
      dots.setAttribute("aria-hidden", "true");
      for (let index = 0; index < 3; index += 1) {
        dots.append(document.createElement("i"));
      }
      bubble.append(heading, dots);
      line.append(bubble);
      container.append(line);
    }
    container.scrollTop = container.scrollHeight;
  }
}

document.querySelectorAll("[data-chat-form]").forEach((form) => {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = form.elements.message;
    const message = input.value.trim();
    if (!message || !aiConfigured) return;
    const buttons = document.querySelectorAll("[data-chat-form] button[type='submit']");
    buttons.forEach((button) => { button.disabled = true; });
    chatMessages.push({ role: "user", content: message });
    chatPending = true;
    renderChat();
    input.value = "";
    try {
      const result = await requestJson("/api/chat", { messages: chatMessages.slice(-6) });
      chatPending = false;
      chatMessages.push({
        role: "assistant",
        content: result.reply,
      });
      chatMessages = chatMessages.slice(-24);
      renderChat();
    } catch (error) {
      chatPending = false;
      renderChat();
      const status = document.createElement("p");
      status.className = "chat-error";
      status.setAttribute("role", "status");
      status.textContent = error.message;
      document.querySelector("#full-chat-messages").append(status);
      document.querySelector("#dashboard-chat-messages").append(status.cloneNode(true));
    } finally {
      buttons.forEach((button) => { button.disabled = !aiConfigured; });
    }
  });
});

const dashboardChatPanel = document.querySelector("#dashboard-chat-panel");
const dashboardChatToggle = document.querySelector("#dashboard-chat-toggle");
const homeContent = document.querySelector("#home-content");

dashboardChatToggle.addEventListener("click", () => {
  const collapsed = dashboardChatToggle.getAttribute("aria-expanded") === "true";
  dashboardChatToggle.setAttribute("aria-expanded", String(!collapsed));
  dashboardChatToggle.setAttribute(
    "aria-label",
    collapsed ? "Expand Chat Buddy panel" : "Collapse Chat Buddy panel",
  );
  dashboardChatToggle.title = collapsed ? "Expand Chat Buddy panel" : "Collapse Chat Buddy panel";
  dashboardChatToggle.querySelector("span").textContent = collapsed ? "‹" : "›";
  homeContent.classList.toggle("chat-panel-collapsed", collapsed);
  for (const child of dashboardChatPanel.children) {
    if (child !== dashboardChatToggle) child.inert = collapsed;
  }
});

document.querySelectorAll("[data-chat-prompt]").forEach((button) => {
  button.addEventListener("click", () => {
    const input = document.querySelector("#full-chat-input");
    input.value = button.dataset.chatPrompt;
    input.focus();
  });
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearStatus();
  setBusy(loginForm, true);
  const data = new FormData(loginForm);
  try {
    await requestJson("/api/auth/login", {
      email: data.get("email"),
      password: data.get("password"),
      remember: data.get("remember") === "on",
    });
    window.location.assign("/dashboard");
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    setBusy(loginForm, false);
  }
});

oauthEmailForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearStatus();
  setBusy(oauthEmailForm, true);
  const email = new FormData(oauthEmailForm).get("email");
  try {
    const result = await requestJson("/api/auth/oauth/complete", {
      token: oauthPendingToken,
      email,
    });
    oauthPendingToken = "";
    oauthEmailForm.reset();
    showStatus(result.message);
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    setBusy(oauthEmailForm, false);
  }
});

signupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearStatus();
  const data = new FormData(signupForm);
  if (data.get("password") !== data.get("confirmPassword")) {
    showStatus("Your passwords do not match.", "error");
    return;
  }
  setBusy(signupForm, true);
  try {
    const result = await requestJson("/api/auth/signup", {
      fullName: data.get("fullName"),
      email: data.get("email"),
      password: data.get("password"),
      avatarId: data.get("avatarId"),
    });
    signupForm.reset();
    showStatus(result.message);
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    setBusy(signupForm, false);
  }
});

forgotForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearStatus();
  setBusy(forgotForm, true);
  try {
    const result = await requestJson("/api/auth/forgot-password", {
      email: new FormData(forgotForm).get("email"),
    });
    showStatus(result.message);
    forgotForm.reset();
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    setBusy(forgotForm, false);
  }
});

resetForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearStatus();
  const data = new FormData(resetForm);
  if (data.get("password") !== data.get("confirmPassword")) {
    showStatus("Your passwords do not match.", "error");
    return;
  }
  setBusy(resetForm, true);
  try {
    const result = await requestJson("/api/auth/reset-password", {
      token: resetToken,
      password: data.get("password"),
    });
    resetForm.reset();
    resetToken = "";
    history.replaceState({}, "", "/login");
    showAuthMode("login");
    showStatus(result.message);
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    setBusy(resetForm, false);
  }
});

document.querySelector("#resend-link").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const email = document.querySelector("#login-email").value;
  if (!email) {
    showStatus("Enter your email address above first.", "error");
    return;
  }
  button.disabled = true;
  try {
    const result = await requestJson("/api/auth/resend-verification", { email });
    showStatus(result.message);
  } catch (error) {
    showStatus(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#forgot-link").addEventListener("click", () => showAuthMode("forgot"));
document.querySelectorAll(".show-password").forEach((button) => {
  button.addEventListener("click", () => {
    const input = document.getElementById(button.dataset.toggle);
    const visible = input.type === "text";
    input.type = visible ? "password" : "text";
    button.textContent = visible ? "Show" : "Hide";
    button.setAttribute("aria-label", `${visible ? "Show" : "Hide"} password`);
  });
});

document.querySelector("#logout-button").addEventListener("click", async () => {
  const button = document.querySelector("#logout-button");
  button.disabled = true;
  try {
    await requestJson("/api/auth/logout", {});
    window.location.assign("/");
  } catch {
    const alertBox = document.querySelector("#app-status");
    alertBox.textContent = "We could not confirm logout. Check your connection and try again.";
    alertBox.hidden = false;
  } finally {
    button.disabled = false;
  }
});

async function initialize() {
  const path = window.location.pathname.replace(/\/$/, "") || "/";
  const params = new URLSearchParams(window.location.search);
  const appPaths = [
    "/dashboard",
    "/search",
    "/sources",
    "/search-sources",
    "/source-information",
    "/about",
    "/chat-buddy",
    "/calendar",
    "/grades",
    "/how-to-use",
  ];
  if (appPaths.includes(path)) {
    await setupAppPage(path);
    if (path === "/dashboard" || path === "/grades" || path === "/calendar") {
      const refresh = () => {
        renderTasks();
        if (path === "/grades" && gradeSubjects.length) renderGrades();
      };
      const scheduleRefresh = () => {
        const now = new Date();
        const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        setTimeout(() => {
          refresh();
          scheduleRefresh();
        }, midnight - now + 100);
      };
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) refresh();
      });
      scheduleRefresh();
    }
  } else if (path === "/login" || path === "/signup" || params.has("verify") || params.has("reset")) {
    await setupAuthPage(path, params);
  } else {
    landingPage.hidden = false;
    landingPage.dataset.page = "landing";
  }
  startFloatingCaps();
}

initialize();
