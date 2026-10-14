/* The Grind: separate localStorage progress for every habit. */
const HABITS_KEY = "theGrindHabits";
const CHALLENGE_DAYS = 7;
const API_ENABLED = window.THE_GRIND_API_ENABLED === true;
let notificationActiveTimer = null;
let notificationMessageTimer = null;
let backendSaveQueue = Promise.resolve();

async function apiRequest(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    method: options.method || "GET",
    credentials: "same-origin",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "The server request failed.");
    error.status = response.status;
    throw error;
  }
  return data;
}
const HABIT_CHOICES = {
  "Study": { icon: "📚", image: "assets/study.svg?v=4", defaultGoal: 30, unit: "minutes", step: 10, category: "Career", reminder: "04:00" },
  "Exercise": { icon: "🏃", image: "assets/exercise.svg?v=4", defaultGoal: 20, unit: "minutes", step: 5, category: "Fitness", reminder: "06:30" },
  "Drink Water": { icon: "💧", image: "assets/water.svg?v=4", defaultGoal: 8, unit: "glasses", step: 1, category: "Health", reminder: "08:00" },
  "Meditation": { icon: "🧘", image: "assets/meditation.svg?v=4", defaultGoal: 10, unit: "minutes", step: 5, category: "Mindfulness", reminder: "07:00" },
  "Reading": { icon: "📖", image: "assets/reading.svg?v=4", defaultGoal: 20, unit: "minutes", step: 5, category: "Mindset", reminder: "21:00" },
  "Coding": { icon: "💻", image: "assets/coding.svg?v=4", defaultGoal: 30, unit: "minutes", step: 10, category: "Career", reminder: "17:00" }
};

// Use server accounts when served by server.js; retain the local demo for file:// use.
const registerForm = document.getElementById("registerForm");
if (registerForm) {
  registerForm.addEventListener("submit", async event => {
    event.preventDefault();
    const name = document.getElementById("registerName").value.trim();
    const email = document.getElementById("registerEmail").value.trim();
    const password = document.getElementById("registerPassword").value;
    const confirmation = document.getElementById("confirmPassword").value;
    if (password !== confirmation) { alert("Passwords do not match."); return; }
    if (API_ENABLED) {
      try {
        const result = await apiRequest("/register", { method: "POST", body: { name, email, password } });
        localStorage.removeItem(HABITS_KEY);
        localStorage.setItem("theGrindUser", JSON.stringify(result.user));
        localStorage.setItem("loggedIn", "true");
        window.location.href = "habits.html";
      } catch (error) { alert(error.message); }
      return;
    }
    // A newly registered account chooses its own habits from a clean slate.
    localStorage.removeItem(HABITS_KEY);
    localStorage.removeItem("selectedHabit");
    localStorage.removeItem("selectedHabitIcon");
    localStorage.removeItem("completedDays");
    localStorage.setItem("theGrindUser", JSON.stringify({ name, email, password }));
    localStorage.setItem("loggedIn", "true");
    window.location.href = "habits.html";
  });
}

const loginForm = document.getElementById("loginForm");
if (loginForm) {
  loginForm.addEventListener("submit", async event => {
    event.preventDefault();
    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;
    if (API_ENABLED) {
      try {
        const result = await apiRequest("/login", { method: "POST", body: { email, password } });
        const response = await apiRequest("/habits");
        localStorage.setItem("theGrindUser", JSON.stringify(result.user));
        localStorage.setItem(HABITS_KEY, JSON.stringify(response.habits));
        localStorage.setItem("loggedIn", "true");
        window.location.href = Object.keys(response.habits).length ? "dashboard.html" : "habits.html";
      } catch (error) { alert(error.message); }
      return;
    }
    let user;
    try { user = JSON.parse(localStorage.getItem("theGrindUser")); } catch { user = null; }
    if (!user) { alert("No account found in this browser. Please register first."); return; }
    if (email !== user.email || password !== user.password) { alert("Email or password is incorrect."); return; }
    localStorage.setItem("loggedIn", "true");
    window.location.href = Object.keys(getHabits()).length ? "dashboard.html" : "habits.html";
  });
}

function getHabits() {
  try {
    const saved = localStorage.getItem(HABITS_KEY);
    if (saved) {
      const habits = JSON.parse(saved) || {};
      Object.values(habits).forEach(habit => {
        if (!habit || typeof habit !== "object") return;
        const choice = HABIT_CHOICES[habit.name];
        const parsedTarget = Number(habit.target);
        habit.target = Number.isFinite(parsedTarget) && parsedTarget > 0 ? parsedTarget : (choice?.defaultGoal || 1);
        habit.unit = habit.unit || choice?.unit || "times";
        habit.step = Number(habit.step) || choice?.step || 1;
        habit.icon = habit.icon || choice?.icon || "🎯";
        habit.image = choice?.image || habit.image || "";
        habit.category = habit.category || choice?.category || "Personal";
        habit.reminder = habit.reminder ?? choice?.reminder ?? "";
        habit.dailyTotals = habit.dailyTotals || {};
        habit.completions = Array.isArray(habit.completions) ? habit.completions : [];
      });
      return habits;
    }
    // Keep a user's existing single-habit challenge when moving to this version.
    const oldName = localStorage.getItem("selectedHabit");
    if (oldName && HABIT_CHOICES[oldName]) {
      const oldCount = Math.min(CHALLENGE_DAYS, Number(localStorage.getItem("completedDays")) || 0);
      const today = dateKey();
      const migrated = {
        [oldName]: {
          name: oldName,
          icon: localStorage.getItem("selectedHabitIcon") || HABIT_CHOICES[oldName].icon,
          target: HABIT_CHOICES[oldName].defaultGoal,
          unit: HABIT_CHOICES[oldName].unit,
          image: HABIT_CHOICES[oldName].image,
          category: HABIT_CHOICES[oldName].category,
          reminder: HABIT_CHOICES[oldName].reminder,
          startedOn: today,
          // The old version had no dates, so keep its count without inventing a streak.
          totalCompleted: oldCount,
          completions: []
        }
      };
      localStorage.setItem(HABITS_KEY, JSON.stringify(migrated));
      return migrated;
    }
    return {};
  }
  catch { return {}; }
}
function saveHabits(habits) {
  const snapshot = JSON.parse(JSON.stringify(habits));
  localStorage.setItem(HABITS_KEY, JSON.stringify(snapshot));
  if (!API_ENABLED) return Promise.resolve(true);
  backendSaveQueue = backendSaveQueue.catch(() => {}).then(() => apiRequest("/habits", { method: "PUT", body: { habits: snapshot } })).then(() => true);
  backendSaveQueue = backendSaveQueue.catch(error => {
    console.error("Could not sync habit changes:", error);
    alert("Your change is saved in this browser, but couldn't reach the server. Check your connection before continuing.");
    return false;
  });
  return backendSaveQueue;
}
function dateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function shiftDate(key, amount) {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + amount);
  return dateKey(date);
}
function completedCount(habit) { return Math.min(CHALLENGE_DAYS, Number.isFinite(habit.totalCompleted) ? habit.totalCompleted : (habit.completions || []).length); }
function currentStreak(habit) {
  const days = new Set(habit.completions || []);
  let cursor = dateKey();
  if (!days.has(cursor)) cursor = shiftDate(cursor, -1);
  let streak = 0;
  while (days.has(cursor)) { streak++; cursor = shiftDate(cursor, -1); }
  return streak;
}
function bestStreak(habit) {
  const dates = [...new Set(habit.completions || [])].sort();
  let best = 0, run = 0, previous = "";
  dates.forEach(day => {
    run = previous && shiftDate(previous, 1) === day ? run + 1 : 1;
    best = Math.max(best, run);
    previous = day;
  });
  return best;
}
function formatReminder(time) {
  if (!time) return "No reminder";
  const [hour, minute] = time.split(":").map(Number);
  return `${hour % 12 || 12}:${String(minute || 0).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function safeJsArgument(value) { return escapeHtml(JSON.stringify(String(value))); }

function habitVisualMarkup(habit, className) {
  const image = habit.image || HABIT_CHOICES[habit.name]?.image;
  if (image) return `<img class="${className}" src="${image}" alt="">`;
  return `<span class="${className} habit-emoji" aria-hidden="true">${escapeHtml(habit.icon || "🎯")}</span>`;
}

async function createCustomHabit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const name = document.getElementById("customHabitName").value.trim();
  const category = document.getElementById("customHabitCategory").value.trim() || "Personal";
  const target = Math.max(1, Math.min(10000, Number(document.getElementById("customHabitTarget").value) || 1));
  const unit = document.getElementById("customHabitUnit").value;
  const icon = form.querySelector('input[name="customHabitIcon"]:checked')?.value || "🎯";
  if (!name) { alert("Enter a name for your habit."); return; }
  const habits = getHabits();
  const duplicate = [...Object.keys(habits), ...Object.keys(HABIT_CHOICES)].find(existing => existing.toLowerCase() === name.toLowerCase());
  if (duplicate) { alert("A habit with that name is already active. Choose a different name."); return; }
  document.querySelectorAll("#habitChoices input[type=checkbox]:checked").forEach(input => {
    const choice = HABIT_CHOICES[input.value];
    if (!choice) return;
    const targetInput = document.getElementById(`goal-${input.value.replaceAll(" ", "-")}`);
    const selectedTarget = Math.max(1, Number(targetInput?.value) || choice.defaultGoal);
    if (!habits[input.value]) {
      habits[input.value] = { name: input.value, icon: choice.icon, image: choice.image, category: choice.category, reminder: choice.reminder, target: selectedTarget, unit: choice.unit, step: choice.step, startedOn: dateKey(), completions: [], dailyTotals: {} };
    } else if (targetInput) habits[input.value].target = selectedTarget;
  });
  const step = unit === "minutes" ? 5 : 1;
  habits[name] = { name, icon, category, target, unit, step, image: "", reminder: "", startedOn: dateKey(), completions: [], dailyTotals: {}, totalCompleted: 0 };
  if (!await saveHabits(habits)) return;
  window.location.href = "dashboard.html";
}
window.createCustomHabit = createCustomHabit;

async function startSelectedHabits() {
  const selected = [...document.querySelectorAll("#habitChoices input[type=checkbox]:checked")];
  if (!selected.length) { alert("Select at least one habit first."); return; }
  const habits = getHabits();
  selected.forEach(input => {
    if (!habits[input.value]) {
      const choice = HABIT_CHOICES[input.value];
      habits[input.value] = { name: input.value, icon: choice.icon, image: choice.image, category: choice.category, reminder: choice.reminder, target: Number(document.getElementById(`goal-${input.value.replaceAll(" ", "-")}`)?.value) || choice.defaultGoal, unit: choice.unit, step: choice.step, startedOn: dateKey(), completions: [], dailyTotals: {} };
    } else {
      const targetInput = document.getElementById(`goal-${input.value.replaceAll(" ", "-")}`);
      if (targetInput) habits[input.value].target = Math.max(1, Number(targetInput.value) || habits[input.value].target || HABIT_CHOICES[input.value].defaultGoal);
    }
  });
  if (!await saveHabits(habits)) return;
  window.location.href = "dashboard.html";
}

function logHabit(name) {
  const habits = getHabits();
  const habit = habits[name];
  if (!habit) return;
  const progressBefore = completedCount(habit);
  const today = dateKey();
  if (completedCount(habit) >= CHALLENGE_DAYS) { alert(`${name} challenge is complete! 🎉`); return; }
  if (!habit.dailyTotals) habit.dailyTotals = {};
  const before = Number(habit.dailyTotals[today]) || 0;
  const goal = Math.max(1, Number(habit.target) || 1);
  habit.dailyTotals[today] = Math.min(goal, before + (habit.step || 1));
  if (habit.dailyTotals[today] >= goal && !(habit.completions || []).includes(today)) {
    habit.completions = Array.isArray(habit.completions) ? habit.completions : [];
    habit.completions.push(today);
    habit.totalCompleted = progressBefore + 1;
  }
  saveHabits(habits);
  renderDashboard();
  renderProgress();
}
window.logHabit = logHabit;

function saveHabitGoal(name) {
  const habits = getHabits(), habit = habits[name];
  const input = document.getElementById(`goal-${name.replaceAll(" ", "-")}`);
  if (!habit || !input) return;
  habit.target = Math.max(1, Math.min(10000, Number(input.value) || 1));
  saveHabits(habits);
  renderDashboard();
}
window.saveHabitGoal = saveHabitGoal;

function renderDashboard() {
  const container = document.getElementById("activeHabits");
  if (!container) return;
  const habits = Object.values(getHabits());
  const nameEl = document.getElementById("userName");
  try {
    const user = JSON.parse(localStorage.getItem("theGrindUser"));
    if (nameEl && user?.name) nameEl.textContent = user.name;
    const avatar = document.getElementById("avatarInitial");
    if (avatar && user?.name) avatar.textContent = user.name.trim().charAt(0).toUpperCase();
  } catch { /* keep default greeting */ }
  const todayLabel = document.getElementById("todayLabel");
  if (todayLabel) todayLabel.textContent = new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const today = dateKey();
  const completedToday = habits.filter(habit => (habit.completions || []).includes(today)).length;
  const notificationButton = document.getElementById("notificationButton");
  if (notificationButton) notificationButton.classList.toggle("has-notifications", habits.some(habit => !(habit.completions || []).includes(today)));
  const longest = habits.reduce((maximum, habit) => Math.max(maximum, bestStreak(habit)), 0);
  const totalDays = habits.reduce((sum, habit) => sum + (habit.completions || []).length, 0);
  const put = (id, value) => { const element = document.getElementById(id); if (element) element.textContent = value; };
  put("currentStreak", `${habits.reduce((maximum, habit) => Math.max(maximum, currentStreak(habit)), 0)} Days`);
  put("todayComplete", `${completedToday} / ${habits.length}`);
  put("bestStreak", `${longest} Days`);
  put("allTimeHabits", totalDays);
  const consistencyRate = habits.length ? Math.round(completedToday / habits.length * 100) : 0;
  put("consistencyRate", `${consistencyRate}%`);
  const consistencyBar = document.getElementById("consistencyBar");
  if (consistencyBar) consistencyBar.style.width = `${consistencyRate}%`;
  put("consistencyHint", habits.length
    ? `Keep going! ${habits.length - completedToday} habit${habits.length - completedToday === 1 ? "" : "s"} left to reach today's goals.`
    : "Choose a habit to start building your streak.");
  put("coachGoalSummary", habits.length ? `Today: ${completedToday} of ${habits.length} goals complete` : "Add a habit to start tracking goals");
  if (!habits.length) {
    container.innerHTML = '<div class="empty-habits"><p>Your habit stack is ready when you are.</p><a class="primary-btn" href="habits.html">Choose Habits</a></div>';
    return;
  }
  container.innerHTML = habits.map(habit => {
    const today = dateKey(), goal = Math.max(1, Number(habit.target) || 1), todayTotal = Number(habit.dailyTotals?.[today]) || 0;
    const goalReached = todayTotal >= goal, finished = completedCount(habit) >= CHALLENGE_DAYS;
    const unit = habit.unit || "minutes";
    const details = `habit-detail.html?habit=${encodeURIComponent(habit.name)}`;
    return `<article class="habit-stack-item ${goalReached ? "is-complete" : ""}"><a class="habit-stack-link" href="${details}">${habitVisualMarkup(habit, "habit-stack-art")}<span class="habit-stack-copy"><strong>${escapeHtml(habit.name)}</strong><small>${escapeHtml(habit.category || "Daily habit")} · Target: ${goal} ${escapeHtml(unit)} · ${habit.reminder ? `⏰ ${formatReminder(habit.reminder)}` : "No reminder set"}</small><small class="habit-stack-today">Today: ${todayTotal} / ${goal} ${escapeHtml(unit)}</small></span></a><button type="button" class="stack-done-btn ${goalReached ? "is-done" : ""}" onclick="window.logHabit(${safeJsArgument(habit.name)})" ${finished || goalReached ? "disabled" : ""} aria-label="${goalReached ? "Daily goal complete" : `Log ${habit.step || 1} ${unit} for ${escapeHtml(habit.name)}`}">${goalReached ? "✓" : "+"}</button></article>`;
  }).join("");
}

function activityGraph(habit) {
  const today = dateKey();
  const goal = Math.max(1, Number(habit.target) || 1);
  const totals = habit.dailyTotals || {};
  const completions = new Set(habit.completions || []);
  const bars = Array.from({ length: 7 }, (_, index) => {
    const day = shiftDate(today, index - 6);
    const amount = Number(totals[day]) || 0;
    const height = Math.max(3, Math.round(Math.min(amount / goal, 1) * 74));
    const x = 36 + index * 53;
    const y = 104 - height;
    const color = completions.has(day) ? "#2f7657" : amount > 0 ? "#8bb796" : "#e5eee8";
    const [year, month, date] = day.split("-").map(Number);
    const label = index === 6 ? "Today" : new Date(year, month - 1, date).toLocaleDateString(undefined, { weekday: "short" });
    return `<g><title>${label}: ${amount} of ${goal} ${escapeHtml(habit.unit || "minutes")}</title><rect x="${x}" y="${y}" width="28" height="${height}" rx="6" fill="${color}"/><text x="${x + 14}" y="124" text-anchor="middle">${label}</text></g>`;
  }).join("");
  return `<div class="activity-graph"><svg viewBox="0 0 420 138" role="img" aria-label="${escapeHtml(habit.name)} activity over the last seven days"><line x1="24" y1="30" x2="395" y2="30" class="graph-target-line"/><text x="398" y="34" class="graph-target-label">Goal</text><line x1="24" y1="105" x2="395" y2="105" class="graph-axis"/>${bars}</svg><p>Each bar shows how much you logged against your daily goal.</p></div>`;
}

function renderWeeklyOverview() {
  const chart = document.getElementById("weeklyPerformanceChart");
  if (!chart) return;
  const habits = Object.values(getHabits());
  const today = new Date();
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const points = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + index);
    const key = dateKey(day);
    const rate = habits.length ? Math.round(habits.filter(habit => (habit.completions || []).includes(key)).length / habits.length * 100) : 0;
    return { key, day, rate };
  });
  const average = Math.round(points.reduce((sum, point) => sum + point.rate, 0) / 7);
  const avgEl = document.getElementById("weeklyAverage");
  if (avgEl) avgEl.textContent = `Weekly Avg: ${average}%`;
  const top = 36, bottom = 236, height = bottom - top;
  const grid = [0, 25, 50, 75, 100].map(value => {
    const y = bottom - height * value / 100;
    return `<g><line x1="56" y1="${y}" x2="730" y2="${y}" class="week-grid-line"/><text x="42" y="${y + 4}" text-anchor="end" class="week-axis-label">${value}%</text></g>`;
  }).join("");
  const bars = points.map((point, index) => {
    const x = 82 + index * 92, barHeight = Math.max(3, height * point.rate / 100), y = bottom - barHeight;
    const label = point.day.toLocaleDateString(undefined, { weekday: "short" });
    return `<g><title>${label}: ${point.rate}% of active habits completed</title><text x="${x + 24}" y="${y - 9}" text-anchor="middle" class="week-bar-value">${point.rate}%</text><rect x="${x}" y="${y}" width="48" height="${barHeight}" rx="9" class="week-bar"/><text x="${x + 24}" y="264" text-anchor="middle" class="week-day-label">${label}</text></g>`;
  }).join("");
  chart.innerHTML = `<svg viewBox="0 0 760 280" role="img" aria-label="Weekly habit completion by day">${grid}${bars}</svg>`;
}

function renderHabitDetails() {
  const container = document.getElementById("habitDetail");
  if (!container) return;
  const name = new URLSearchParams(window.location.search).get("habit");
  const habit = getHabits()[name];
  if (!habit) { container.innerHTML = '<p class="empty-habits">This habit was not found. <a href="habits.html">Choose a habit</a>.</p>'; return; }
  const goal = Math.max(1, Number(habit.target) || 1), unit = habit.unit || "minutes";
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = shiftDate(dateKey(), index - 6);
    const [year, month, date] = day.split("-").map(Number);
    const dateObj = new Date(year, month - 1, date);
    const complete = (habit.completions || []).includes(day);
    return `<div class="consistency-day"><span>${dateObj.toLocaleDateString(undefined, { weekday: "short" })}</span><strong class="${complete ? "record-done" : ""}">${complete ? "✓" : "—"}</strong><small>${dateObj.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</small></div>`;
  }).join("");
  container.innerHTML = `<a class="back-link" href="dashboard.html">← Back to Dashboard</a><article class="habit-detail-card"><div class="detail-habit-heading">${habitVisualMarkup(habit, "detail-habit-icon")}<div><span class="detail-category">${escapeHtml(habit.category || "DAILY HABIT")}</span><h1>${escapeHtml(habit.name)}</h1></div></div><div class="detail-metrics"><div><strong>${goal} ${escapeHtml(unit)}</strong><span>Daily Goal Target</span></div><div><strong>${formatReminder(habit.reminder)}</strong><span>Daily Reminder</span></div></div><h2>7-Day Consistency Record</h2><div class="consistency-record">${days}</div><form id="habitSettingsForm" class="detail-settings"><label>Daily goal <input id="detailGoal" type="number" min="1" max="10000" value="${goal}"> <span>${escapeHtml(unit)}</span></label><label>Reminder <input id="detailReminder" type="time" value="${escapeHtml(habit.reminder || "08:00")}"></label><button class="primary-btn" type="submit">Save Settings</button></form><div class="detail-actions"><button class="danger-btn" type="button" onclick="window.deleteHabit(${safeJsArgument(habit.name)})">Delete Habit</button><a class="primary-btn" href="dashboard.html">Done Viewing</a></div></article>`;
  document.getElementById("habitSettingsForm").addEventListener("submit", event => {
    event.preventDefault();
    const habits = getHabits(), current = habits[name];
    if (!current) return;
    current.target = Math.max(1, Math.min(10000, Number(document.getElementById("detailGoal").value) || goal));
    current.reminder = document.getElementById("detailReminder").value || "08:00";
    saveHabits(habits);
    renderHabitDetails();
  });
}
async function deleteHabit(name) {
  if (!confirm(`Delete ${name} and its saved progress?`)) return;
  const habits = getHabits();
  delete habits[name];
  if (!await saveHabits(habits)) return;
  window.location.href = "dashboard.html";
}
window.deleteHabit = deleteHabit;

function toggleNotifications() {
  const panel = document.getElementById("notificationPanel");
  if (!panel) return;
  const button = document.getElementById("notificationButton");
  if (button) {
    button.classList.add("is-active");
    button.setAttribute("aria-pressed", "true");
    clearTimeout(notificationActiveTimer);
    notificationActiveTimer = setTimeout(() => {
      button.classList.remove("is-active");
      button.setAttribute("aria-pressed", "false");
    }, 3000);
  }
  const habits = Object.values(getHabits());
  const pending = habits.filter(habit => !(habit.completions || []).includes(dateKey()));
  panel.innerHTML = pending.length
    ? `<strong>Today's reminders</strong>${pending.map(habit => `<p>${escapeHtml(habit.name)} · ${formatReminder(habit.reminder)}</p>`).join("")}`
    : "<strong>You're all caught up today. ✓</strong>";
  panel.hidden = !panel.hidden;
  clearTimeout(notificationMessageTimer);
  if (!panel.hidden) {
    notificationMessageTimer = setTimeout(() => { panel.hidden = true; }, 3000);
  }
}
window.toggleNotifications = toggleNotifications;

function toggleCoach() {
  const panel = document.getElementById("coachPanel");
  if (panel) panel.hidden = !panel.hidden;
}
window.toggleCoach = toggleCoach;

async function sendCoachQuestion(question) {
  const history = document.getElementById("coachMessages");
  if (!history || !question.trim()) return;
  const userMessage = document.createElement("p");
  userMessage.className = "coach-user-message";
  userMessage.textContent = question.trim();
  history.appendChild(userMessage);
  const habits = Object.values(getHabits());
  const today = dateKey();
  const status = habits.map(habit => {
    const goal = Math.max(1, Number(habit.target) || 1);
    const amount = Math.min(goal, Number(habit.dailyTotals?.[today]) || 0);
    return { habit, goal, amount, remaining: Math.max(0, goal - amount), unit: habit.unit || "times" };
  });
  const done = status.filter(item => item.remaining === 0).length;
  const next = status.filter(item => item.remaining > 0).sort((a, b) => (b.amount / b.goal) - (a.amount / a.goal))[0];
  const leftText = item => `${item.remaining} ${item.unit} left for ${item.habit.name}`;
  let answer;
  if (!status.length) answer = "You haven't added any habits yet. Add a habit first, and I'll help you track its daily goal here.";
  else if (/miss|forgot|skip/i.test(question)) answer = `It's okay to miss a day; your progress isn't erased. Today you've completed ${done} of ${status.length} goals. ${next ? `A simple restart: ${leftText(next)}.` : "You've already reached all today's goals."}`;
  else if (/streak/i.test(question)) answer = `Your longest current habit streak is ${status.reduce((max, item) => Math.max(max, currentStreak(item.habit)), 0)} days. Today, ${done} of ${status.length} goals are complete${next ? `; ${leftText(next)}` : ". You're all caught up"}.`;
  else if (/progress|goal|how many|status|track/i.test(question)) answer = `Today's progress: ${done} of ${status.length} goals complete. ${status.map(item => item.remaining ? `${item.habit.name}: ${item.amount}/${item.goal} ${item.unit}` : `${item.habit.name}: complete`).join(" · ")}.`;
  else if (/motivat|encourag/i.test(question)) answer = `${done} of ${status.length} goals complete today. ${next ? `You're making progress—try ${leftText(next)} next.` : "You've reached all today's goals. Take a moment to enjoy that win."}`;
  else answer = next ? `You're ${Math.round(next.amount / next.goal * 100)}% through ${next.habit.name}. ${leftText(next)}. Log a small step now, then I'll update your progress.` : "You've completed all today's goals. Take a moment to enjoy that progress.";
  if (API_ENABLED) {
    try {
      const response = await apiRequest("/coach", { method: "POST", body: { question: question.trim(), today } });
      answer = response.answer || answer;
    } catch (error) { console.error("Coach request failed:", error); }
  }
  const coachMessage = document.createElement("p");
  coachMessage.className = "coach-reply";
  coachMessage.textContent = answer;
  history.appendChild(coachMessage);
  history.scrollTop = history.scrollHeight;
}
window.sendCoachQuestion = sendCoachQuestion;
function submitCoach(event) {
  event.preventDefault();
  const input = document.getElementById("coachInput");
  if (!input) return;
  sendCoachQuestion(input.value);
  input.value = "";
}
window.submitCoach = submitCoach;

function renderProgress() {
  const container = document.getElementById("habitProgressList");
  renderWeeklyOverview();
  if (!container) return;
  const habits = Object.values(getHabits());
  if (!habits.length) { container.innerHTML = '<p class="empty-habits">No active habits yet. <a href="habits.html">Choose a habit</a>.</p>'; return; }
  container.innerHTML = habits.map(habit => {
    const count = completedCount(habit), percent = Math.round(count / CHALLENGE_DAYS * 100), streak = currentStreak(habit);
    const days = Array.from({ length: CHALLENGE_DAYS }, (_, i) => `<div class="calendar-day">Day ${i + 1}</div>`).map((html, i) => i < count ? html.replace('class="calendar-day"', 'class="calendar-day completed"') : html).join("");
    return `<article class="habit-progress-card"><div class="progress-habit-heading">${habitVisualMarkup(habit, "progress-art")}<h2>${escapeHtml(habit.name)}</h2><strong>${percent}%</strong></div><p>Daily goal: ${Number(habit.target) || 0} ${escapeHtml(habit.unit || "minutes")} · ${count} of ${CHALLENGE_DAYS} days complete · 🔥 ${streak} day streak</p><div class="habit-progress-track"><div style="width:${percent}%"></div></div><div class="calendar-grid">${days}</div><h3 class="graph-title">Last 7 days of activity</h3>${activityGraph(habit)}</article>`;
  }).join("");
}

async function logout() {
  if (API_ENABLED) {
    try { await apiRequest("/logout", { method: "POST", body: {} }); }
    catch (error) { console.error("Sign out request failed:", error); }
  }
  localStorage.removeItem("loggedIn");
  localStorage.removeItem("theGrindUser");
  window.location.href = "index.html";
}

document.addEventListener("DOMContentLoaded", async () => {
  if (API_ENABLED && ["dashboard.html", "habits.html", "progress.html", "habit-detail.html"].includes(location.pathname.split("/").pop())) {
    try {
      const { user } = await apiRequest("/me");
      const { habits } = await apiRequest("/habits");
      localStorage.setItem("theGrindUser", JSON.stringify(user));
      localStorage.setItem(HABITS_KEY, JSON.stringify(habits));
      localStorage.setItem("loggedIn", "true");
    } catch (error) {
      if (error.status === 401) { window.location.href = "login.html"; return; }
      console.error("Could not refresh account data:", error);
    }
  }
  const choiceBox = document.getElementById("habitChoices");
  if (choiceBox) {
    const active = getHabits();
    choiceBox.querySelectorAll(".habit-card").forEach(card => {
      const name = card.dataset.habit;
      const checkbox = card.querySelector("input[type=checkbox]");
      const goalInput = card.querySelector("input[type=number]");
      if (active[name]) { checkbox.checked = true; card.classList.add("is-active"); }
      if (goalInput) goalInput.value = active[name]?.target || HABIT_CHOICES[name].defaultGoal;
      checkbox.addEventListener("change", () => card.classList.toggle("is-selected", checkbox.checked));
    });
    const message = document.getElementById("selectionMessage");
    const activeCount = Object.keys(active).length;
    if (message && activeCount) message.textContent = `${activeCount} habit${activeCount === 1 ? " is" : "s are"} already active. Select more to add them.`;
  }
  renderDashboard();
  renderProgress();
  renderHabitDetails();
});
