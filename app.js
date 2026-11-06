/* =============================================================
   Czech Mate — app logic
   ============================================================= */

// ---------- State ----------
const State = {
  name: localStorage.getItem("cz_name") || "",
  points: 0,
  mastered: new Set(),      // card ids this player has mastered
  review: {},               // spaced-repetition data per item: { b: box 0-5, d: due day, w: times wrong }
  answered: new Set(),      // ids answered at least once this session
  lesson: (() => {                // current lesson filter (remembered between visits)
    const s = localStorage.getItem("cz_lesson");
    return s && (s === "all" || LESSONS.some(l => l.id === s)) ? s : "all";
  })(),
  screen: "home"
};

// Build a flat list of all cards with a stable id per card.
const ALL_CARDS = [];
LESSONS.forEach(lesson => {
  lesson.vocab.forEach((v, i) => {
    ALL_CARDS.push({
      id: `${lesson.id}:${i}`,
      lessonId: lesson.id,
      lessonTitle: lesson.title,
      cz: v.cz, en: v.en, note: v.note || ""
    });
  });
});

// Grammar exercises with stable ids (integrate with scoring/mastery).
const GRAMMAR = (window.GRAMMAR_EXERCISES || []).map((g, i) => ({
  id: `gram:${g.lessonId}:${i}`,
  ...g
}));
function grammarForLesson() {
  return State.lesson === "all" ? GRAMMAR : GRAMMAR.filter(g => g.lessonId === State.lesson);
}

// All phrases flattened into sentence questions with stable ids.
const SENTENCES = [];
LESSONS.forEach(lesson => {
  lesson.phrases.forEach((p, i) => {
    SENTENCES.push({
      id: `sent:${lesson.id}:${i}`,
      lessonId: lesson.id,
      cz: p.cz, en: p.en
    });
  });
});
function sentencesForLesson() {
  return State.lesson === "all" ? SENTENCES : SENTENCES.filter(s => s.lessonId === State.lesson);
}

// Only vocabulary cards count as "words" (grammar & sentence answers don't).
const VOCAB_IDS = new Set(ALL_CARDS.map(c => c.id));
function vocabCount(ids) { let n = 0; for (const id of ids) if (VOCAB_IDS.has(id)) n++; return n; }
// Every practice item (word, sentence, grammar question) by id — used by Review.
const ITEM_BY_ID = new Map();
ALL_CARDS.forEach(c => ITEM_BY_ID.set(c.id, { kind: "vocab", item: c }));
SENTENCES.forEach(s => ITEM_BY_ID.set(s.id, { kind: "sent", item: s }));
GRAMMAR.forEach(g => ITEM_BY_ID.set(g.id, { kind: "gram", item: g }));

// Make any text safe to put inside HTML (player names, search text).
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, ch =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

// Every Czech answer accepted for a card when typing:
// the word itself, each side of "a / b", and synonyms with the same English meaning.
function acceptedAnswers(card) {
  const key = normalize(card.en);
  const forms = new Set();
  ALL_CARDS.filter(c => normalize(c.en) === key).forEach(c => {
    forms.add(normalize(c.cz));
    c.cz.split("/").forEach(part => forms.add(normalize(part)));
  });
  forms.delete("");
  return forms;
}

// Spell out grammar abbreviations for beginners: "F pl." → "feminine plural".
const ABBR = { M: "masculine", F: "feminine", N: "neuter", "pl.": "plural", "acc.": "accusative", "gen.": "genitive", "dat.": "dative" };
function prettyNote(n) {
  return String(n || "").replace(/(^|[\s(,;/—])(M|F|N|pl\.|acc\.|gen\.|dat\.)(?=$|[\s,;)\/—])/g, (m, pre, t) => pre + ABBR[t]);
}
// Note for the Typing challenge with any part that would reveal the answer removed
// (e.g. "F pl. — na hory" for "hory" becomes just "feminine plural").
function typingNote(card, accepted) {
  const answerWords = [...accepted].join(" ").split(" ").filter(w => w.length >= 3);
  const leaks = part => normalize(part).split(" ").some(nw => answerWords.some(aw => {
    const k = Math.min(4, aw.length);
    return nw.length >= k && nw.slice(0, k) === aw.slice(0, k);
  }));
  return prettyNote(card.note).split(/\s*[—;]\s*/).filter(p => p && !leaks(p)).join(" — ");
}

// Short lesson name: "Lesson 1 — Homework: Geography" → "Lesson 1 Homework", "Lesson 3 — Cases" → "Lesson 3".
function lessonLabel(title) {
  const [short, rest = ""] = String(title).split("—").map(s => s.trim());
  return /^homework/i.test(rest) ? short + " Homework" : short;
}

// Remember the chosen lesson between visits.
function setLesson(id) {
  State.lesson = id;
  try { localStorage.setItem("cz_lesson", id); } catch (e) { /* storage full/blocked: ignore */ }
}

// Delayed actions (auto-advance) only run if the user is still on the same screen.
let renderToken = 0;
function later(fn, ms) {
  const tok = renderToken;
  setTimeout(() => { if (tok === renderToken) fn(); }, ms);
}

// ---------- Scoring rules ----------
const PTS_FULL = 10;   // first time a card is mastered
const PTS_REPEAT = 1;  // repeats still fun, but small
function pointsFor(cardId) {
  return State.mastered.has(cardId) ? PTS_REPEAT : PTS_FULL;
}

// ---------- Supabase leaderboard ----------
let db = null;
try {
  if (typeof SUPABASE_URL !== "undefined" && SUPABASE_URL && !SUPABASE_URL.includes("YOUR_")) {
    db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  }
} catch (e) { console.warn("Supabase init failed:", e); }

// ---------- Days, weeks & spaced repetition ----------
function dayNumber(dt = new Date()) {   // local calendar day as a number (changes at midnight)
  return Math.floor(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()) / 86400000);
}
function weekStart(dt = new Date()) {   // Monday of this week, e.g. "2026-11-02"
  const mon = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() - ((dt.getDay() + 6) % 7));
  const p = n => String(n).padStart(2, "0");
  return `${mon.getFullYear()}-${p(mon.getMonth() + 1)}-${p(mon.getDate())}`;
}
// Box → days until the item comes back. Box 0 = got it wrong (due right away).
const INTERVALS = [0, 1, 3, 7, 14, 30];

function reviewKey() { return "cz_review_" + State.name.trim().toLowerCase(); }
function saveReviewLocal() {
  try { localStorage.setItem(reviewKey(), JSON.stringify(State.review)); } catch (e) { /* ignore */ }
}
function loadReviewLocal() {
  try { return JSON.parse(localStorage.getItem(reviewKey()) || "{}") || {}; } catch (e) { return {}; }
}
// Record how an answer went, so the item comes back at the right time.
function recordResult(id, correct) {
  const today = dayNumber(), r = State.review[id];
  if (correct) {
    if (!r) State.review[id] = { b: 1, d: today + INTERVALS[1], w: 0 };
    else if (r.d <= today) { const b = Math.min((r.b || 0) + 1, 5); State.review[id] = { b, d: today + INTERVALS[b], w: r.w || 0 }; }
    // answered again before it was due: keep its schedule
  } else {
    State.review[id] = { b: 0, d: today, w: ((r && r.w) || 0) + 1 };
  }
  saveReviewLocal();
}
// A wrong answer: schedule it for review and save (no points).
function markWrong(id) { recordResult(id, false); apiScore(null, 0); }
// Words mastered before Review existed get a schedule spread over the next 2 weeks.
function seedLegacyReview() {
  const today = dayNumber();
  for (const id of State.mastered) {
    if (State.review[id]) continue;
    let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    State.review[id] = { b: 1, d: today + 1 + (h % 14), w: 0 };
  }
}
function dueIds() {
  const today = dayNumber();
  return Object.entries(State.review)
    .filter(([id, r]) => r.d <= today && ITEM_BY_ID.has(id))
    .sort((a, b) => (a[1].b - b[1].b) || (a[1].d - b[1].d))
    .map(([id]) => id);
}

// Optional database columns (review, week_points, week_start) are added by a one-time SQL step.
// Until then the app keeps working without them. null = not known yet.
let extraColumns = null;
const isMissingColumn = e => !!e && (e.code === "PGRST204" || /column/i.test(e.message || ""));

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}

// Find the player ignoring capitals ("Goksu" = "goksu") and adopt the saved spelling.
async function apiLoadPlayer(name) {
  const finish = () => { State.review = Object.assign(loadReviewLocal(), State.review); seedLegacyReview(); };
  if (!db) { finish(); return; }
  try {
    const { data } = await withTimeout(db.from("players").select("*"), 15000);
    if (data && data.length) extraColumns = "review" in data[0] && "week_points" in data[0];
    const key = name.trim().toLowerCase();
    const mine = (data || [])
      .filter(p => String(p.name || "").trim().toLowerCase() === key)
      .sort((a, b) => (b.points || 0) - (a.points || 0))[0];
    if (mine) {
      State.name = mine.name;
      State.points = mine.points || 0;
      State.mastered = new Set(mine.mastered || []);
      if (mine.review && typeof mine.review === "object") State.review = mine.review;
    }
  } catch (e) { console.warn("apiLoadPlayer:", e); }
  finish();
}

// Saves run one at a time in a queue, so quick answers never overwrite each other.
let saveChain = Promise.resolve();
function apiScore(cardId, pts) {
  if (!db) return saveChain;
  const name = State.name;
  saveChain = saveChain
    .then(() => saveOnce(name, cardId, pts, 0))
    .catch(e => console.warn("apiScore:", e));
  return saveChain;
}
async function saveOnce(name, cardId, pts, tries) {
  const { data: existing } = await db.from("players").select("*").eq("name", name).single();
  const wk = weekStart();
  const extras = row => ({
    review: State.review,
    week_start: wk,
    week_points: (row && row.week_start === wk ? (row.week_points || 0) : 0) + (pts || 0)
  });
  // try with the optional columns; if the database doesn't have them yet, retry without
  const write = async build => {
    if (extraColumns !== false) {
      const { error } = await build(true);
      if (!isMissingColumn(error)) { if (!error) extraColumns = true; return error; }
      extraColumns = false;
    }
    const { error } = await build(false);
    return error;
  };
  if (existing) {
    const mastered = existing.mastered || [];
    if (cardId && !mastered.includes(cardId)) mastered.push(cardId);
    const base = { points: (existing.points || 0) + (pts || 0), mastered };
    const error = await write(withExtra => db.from("players")
      .update(withExtra ? { ...base, ...extras(existing) } : base).eq("name", name));
    if (error) throw error;
  } else {
    const base = { name, points: pts || 0, mastered: cardId ? [cardId] : [] };
    const error = await write(withExtra => db.from("players").insert(withExtra ? { ...base, ...extras(null) } : base));
    // Row was created meanwhile (e.g. another device): retry as an update.
    if (error && error.code === "23505" && tries < 2) return saveOnce(name, cardId, pts, tries + 1);
    if (error) throw error;
  }
}

async function apiLeaderboard() {
  const me = [{ name: State.name, points: State.points, mastered: vocabCount(State.mastered), week: null }];
  if (!db) return me;
  try {
    await saveChain; // show the latest scores, including saves still in progress
    const { data, error } = await db.from("players").select("*").order("points", { ascending: false });
    if (error) return me;
    const wk = weekStart();
    return (data || []).map(p => ({
      name: p.name, points: p.points || 0, mastered: vocabCount(p.mastered || []),
      week: "week_points" in p ? (p.week_start === wk ? (p.week_points || 0) : 0) : null
    }));
  } catch (e) { return me; }
}

// Award points for a correct answer. Updates the screen at once; saving happens in the background.
// forcePts lets an activity give fewer points (e.g. when solved mostly with hints).
function award(cardId, forcePts) {
  const pts = forcePts != null ? forcePts : pointsFor(cardId);
  const wasNew = !State.mastered.has(cardId);
  State.points += pts;
  State.mastered.add(cardId);
  State.answered.add(cardId);
  recordResult(cardId, true);
  updateTopbar();
  apiScore(cardId, pts);
  return { pts, wasNew };
}

// ---------- Levels & badges ----------
// ~12,500 points are available in total, so levels are spread across that range.
const LEVELS = [
  { min: 0,     name: "Začátečník" },    // Beginner
  { min: 300,   name: "Turista" },       // Tourist
  { min: 800,   name: "Cestovatel" },    // Traveler
  { min: 1600,  name: "Student" },
  { min: 3000,  name: "Pokročilý" },     // Advanced
  { min: 5000,  name: "Machr" },         // Pro
  { min: 8000,  name: "Expert" },
  { min: 11000, name: "Rodilý mluvčí" }  // Native-ish
];
function currentLevel() {
  let lvl = LEVELS[0];
  for (const l of LEVELS) if (State.points >= l.min) lvl = l;
  return lvl;
}
function nextLevel() { return LEVELS.find(l => l.min > State.points) || null; }

const BADGES = [
  { id: "first", emoji: "🐣", name: "First word", test: () => vocabCount(State.mastered) >= 1 },
  { id: "ten", emoji: "🔟", name: "10 words", test: () => vocabCount(State.mastered) >= 10 },
  { id: "fifty", emoji: "🧠", name: "50 words", test: () => vocabCount(State.mastered) >= 50 },
  { id: "hundred", emoji: "💯", name: "100 words", test: () => vocabCount(State.mastered) >= 100 },
  { id: "half", emoji: "🌟", name: "Halfway", test: () => vocabCount(State.mastered) >= ALL_CARDS.length / 2 },
  { id: "all", emoji: "👑", name: "All words", test: () => vocabCount(State.mastered) >= ALL_CARDS.length },
  { id: "pts500", emoji: "🚀", name: "500 pts", test: () => State.points >= 500 },
  { id: "grammar", emoji: "🦉", name: "Grammar Guru", test: () => GRAMMAR.filter(g => State.mastered.has(g.id)).length >= 10 },
  { id: "sentences", emoji: "🗣️", name: "Sentence Master", test: () => SENTENCES.filter(s => State.mastered.has(s.id)).length >= 15 }
];

// ---------- Utilities ----------
const $ = sel => document.querySelector(sel);
const screenEl = () => document.getElementById("screen");
// Title with a "back to Home" link, for screens launched from Home tiles.
function titleWithBack(text) {
  return `<div style="display:flex;align-items:center;gap:10px;margin:4px 0 16px">
    <button class="btn-ghost" onclick="go('home')">◀ Home</button>
    <h2 class="screen-title" style="margin:0">${text}</h2>
  </div>`;
}
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function cardsForLesson() {
  return State.lesson === "all" ? ALL_CARDS : ALL_CARDS.filter(c => c.lessonId === State.lesson);
}
// forgiving compare: ignore case, accents, punctuation and extra spaces
function normalize(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[!?.,;:"'„“”()…]/g, " ").replace(/\s+/g, " ").trim();
}

// ---------- Topbar ----------
function updateTopbar() {
  $("#points-badge").textContent = "✨ " + State.points;
  $("#level-badge").textContent = currentLevel().name;
}

// ---------- Celebrations (varied) ----------
const CZ_COLORS = ["#d7141a", "#11457e", "#ffcc33", "#2e9e5b", "#ffffff", "#ff6ec7", "#00d4ff"];
const EMOJI_SETS = [
  ["🎉", "✨", "🎊", "⭐"],
  ["🏆", "👏", "💪", "🎯"],
  ["🥳", "🎈", "🌟", "💫"],
  ["🔥", "⚡", "💯", "🚀"],
  ["🦔", "🍺", "🥨", "🏰"] // playful Czech-ish
];

function ctxSetup() {
  const canvas = $("#confetti");
  const ctx = canvas.getContext("2d");
  canvas.width = innerWidth; canvas.height = innerHeight;
  return { canvas, ctx };
}

// 1) Classic falling confetti squares
function celebrateConfetti() {
  const { canvas, ctx } = ctxSetup();
  const parts = Array.from({ length: 140 }, () => ({
    x: Math.random() * canvas.width, y: -20 - Math.random() * canvas.height * 0.3,
    r: 4 + Math.random() * 6, c: CZ_COLORS[Math.floor(Math.random() * CZ_COLORS.length)],
    vy: 2 + Math.random() * 4, vx: -2 + Math.random() * 4, a: Math.random() * Math.PI, spin: -0.2 + Math.random() * 0.4
  }));
  let f = 0;
  (function loop() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    parts.forEach(p => {
      p.y += p.vy; p.x += p.vx; p.a += p.spin;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.fillStyle = p.c;
      ctx.fillRect(-p.r / 2, -p.r / 2, p.r, p.r * 1.6); ctx.restore();
    });
    if (++f < 130) requestAnimationFrame(loop); else ctx.clearRect(0, 0, canvas.width, canvas.height);
  })();
}

// 2) Emoji rain falling from the top
function celebrateEmojiRain() {
  const { canvas, ctx } = ctxSetup();
  const set = EMOJI_SETS[Math.floor(Math.random() * EMOJI_SETS.length)];
  const parts = Array.from({ length: 60 }, () => ({
    x: Math.random() * canvas.width, y: -40 - Math.random() * 120,
    e: set[Math.floor(Math.random() * set.length)], s: 24 + Math.random() * 22,
    vy: 7 + Math.random() * 5, vx: -1 + Math.random() * 2, a: Math.random() * Math.PI, spin: -0.1 + Math.random() * 0.2
  }));
  let f = 0;
  (function loop() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    parts.forEach(p => {
      p.y += p.vy; p.x += p.vx; p.a += p.spin;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a);
      ctx.font = p.s + "px serif"; ctx.textAlign = "center"; ctx.fillText(p.e, 0, 0); ctx.restore();
    });
    if (++f < 100) requestAnimationFrame(loop); else ctx.clearRect(0, 0, canvas.width, canvas.height);
  })();
}

// 3) Firework burst from the center
function celebrateFirework() {
  const { canvas, ctx } = ctxSetup();
  const cx = canvas.width / 2, cy = canvas.height * 0.4;
  const parts = Array.from({ length: 90 }, (_, i) => {
    const ang = (i / 90) * Math.PI * 2, sp = 3 + Math.random() * 6;
    return { x: cx, y: cy, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, c: CZ_COLORS[Math.floor(Math.random() * CZ_COLORS.length)], r: 3 + Math.random() * 3 };
  });
  let f = 0;
  (function loop() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    parts.forEach(p => {
      p.x += p.vx; p.y += p.vy; p.vy += 0.08; p.vx *= 0.98; p.vy *= 0.98;
      ctx.globalAlpha = Math.max(0, 1 - f / 90); ctx.fillStyle = p.c;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    });
    ctx.globalAlpha = 1;
    if (++f < 90) requestAnimationFrame(loop); else ctx.clearRect(0, 0, canvas.width, canvas.height);
  })();
}

// 4) Emojis floating UP from the bottom (balloons/stars vibe)
function celebrateRise() {
  const { canvas, ctx } = ctxSetup();
  const set = EMOJI_SETS[Math.floor(Math.random() * EMOJI_SETS.length)];
  const parts = Array.from({ length: 26 }, () => ({
    x: Math.random() * canvas.width, y: canvas.height + 20 + Math.random() * 80,
    e: set[Math.floor(Math.random() * set.length)], s: 26 + Math.random() * 24,
    vy: -(5 + Math.random() * 4), drift: -0.6 + Math.random() * 1.2, a: 0, sway: Math.random() * Math.PI
  }));
  let f = 0;
  (function loop() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    parts.forEach(p => {
      p.sway += 0.05; p.y += p.vy; p.x += Math.sin(p.sway) * 0.8 + p.drift;
      ctx.save(); ctx.translate(p.x, p.y); ctx.font = p.s + "px serif"; ctx.textAlign = "center"; ctx.fillText(p.e, 0, 0); ctx.restore();
    });
    if (++f < 105) requestAnimationFrame(loop); else ctx.clearRect(0, 0, canvas.width, canvas.height);
  })();
}

const CELEBRATIONS = [celebrateConfetti, celebrateEmojiRain, celebrateFirework, celebrateRise];
// Pick a random celebration each time for variety.
function celebrate() {
  CELEBRATIONS[Math.floor(Math.random() * CELEBRATIONS.length)]();
}
// Keep the old name working everywhere it's already called.
const confetti = celebrate;

// ---------- Lesson chips ----------
function lessonChips() {
  const opts = [`<option value="all" ${State.lesson === "all" ? "selected" : ""}>🌍 All lessons</option>`]
    .concat(LESSONS.map(l =>
      `<option value="${l.id}" ${State.lesson === l.id ? "selected" : ""}>${l.emoji} ${l.title.split("—")[0].trim()}</option>`));
  return `<div class="lesson-picker">
    <label class="lesson-picker-label" for="lesson-select">Lesson:</label>
    <select class="lesson-select" id="lesson-select">${opts.join("")}</select>
  </div>`;
}
function bindChips() {
  const sel = screenEl().querySelector("#lesson-select");
  if (sel) sel.onchange = () => { setLesson(sel.value); render(); };
}

// "You did everything" check for an activity's card pool
function allMasteredInPool() {
  const pool = cardsForLesson();
  return pool.length > 0 && pool.every(c => State.mastered.has(c.id));
}
function doneScreen(msg) {
  return `<div class="done card">
    <div class="big">🎉</div>
    <h2>All done here!</h2>
    <p class="subtle">${msg}</p>
    <p class="subtle mt">You've mastered every card in this selection.<br/>Wait for next week's lesson to be uploaded, or switch lessons above.</p>
  </div>`;
}

// =============================================================
// SCREENS
// =============================================================

function renderHome() {
  const total = ALL_CARDS.length;
  const mastered = vocabCount(State.mastered);
  const pct = total ? Math.round((mastered / total) * 100) : 0;
  // Word of the day: a different word every day, spread across ALL lessons
  // (golden-ratio stepping jumps around the list, whatever its size).
  const now = new Date();
  const dayNum = Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86400000);
  const wod = ALL_CARDS[Math.floor(((dayNum * 0.6180339887) % 1) * ALL_CARDS.length)];

  const badgeHtml = BADGES.map(b =>
    `<div class="badge ${b.test() ? "earned" : ""}"><div class="b-emoji">${b.emoji}</div><div class="b-name">${b.name}</div></div>`
  ).join("");

  const newest = LESSONS[LESSONS.length - 1];
  const due = dueIds().length;
  const nl = nextLevel();
  const lessonProgress = LESSONS.map(l => {
    const cards = ALL_CARDS.filter(c => c.lessonId === l.id);
    const m = cards.filter(c => State.mastered.has(c.id)).length;
    const p = cards.length ? Math.round((m / cards.length) * 100) : 0;
    const [short, rest] = l.title.split("—").map(s => s.trim());
    return `<button type="button" class="lesson-row" data-lesson="${l.id}">
      <span class="lr-emoji">${l.emoji}</span>
      <span class="lr-main">
        <span class="lr-title">${short}${l === newest ? ` <span class="new-tag">NEW</span>` : ""}${rest ? `<span class="lr-sub"> · ${rest}</span>` : ""}</span>
        <span class="progress-wrap lr-bar"><span class="progress-bar" style="width:${p}%"></span></span>
      </span>
      <span class="lr-count">${m}/${cards.length}</span>
    </button>`;
  }).join("");
  const pctLabel = mastered > 0 && pct === 0 ? "&lt;1%" : pct + "%";

  screenEl().innerHTML = `
    <h2 class="screen-title">Ahoj, ${esc(State.name)}! 👋</h2>
    <div class="card center">
      <div class="subtle">Total progress</div>
      <div style="font-size:34px;font-weight:800;color:var(--accent)">${pctLabel}</div>
      <div class="progress-wrap"><div class="progress-bar" style="width:${pct}%"></div></div>
      <div class="subtle mt">${mastered} of ${total} words learned</div>
      <div class="subtle" style="margin-top:4px">${nl ? `Level: <b>${currentLevel().name}</b> · ${nl.min - State.points} pts to <b>${nl.name}</b>` : `Top level reached: <b>${currentLevel().name}</b> 👑`}</div>
    </div>

    <button type="button" class="card home-action" id="home-review">
      <span class="ha-emoji">🔁</span>
      <span class="ha-main"><span class="ha-title">Review</span>
        <span class="subtle">${due ? `${due} item${due === 1 ? "" : "s"} to review today` : "All caught up ✨"}</span></span>
      <span class="ha-go">${due ? "Start ▶" : ""}</span>
    </button>

    <div class="card newest">
      <div class="subtle">🆕 Newest lesson</div>
      <div class="newest-title">${newest.emoji} ${newest.title}</div>
      <div class="row mt">
        <button class="btn-primary" id="newest-test">📝 Test</button>
        <button class="btn-ghost" id="newest-cards">🃏 Flashcards</button>
      </div>
    </div>

    <div class="card">
      <h3>📅 Word of the day</h3>
      <div style="font-size:26px;font-weight:800">${wod.cz}</div>
      <div class="subtle">${wod.en}${wod.note ? " · " + prettyNote(wod.note) : ""}</div>
    </div>

    <h3 style="margin:18px 0 10px">Play &amp; learn</h3>
    <div class="tiles">
      <button class="tile" data-go="flashcards"><div class="emoji">🃏</div><div class="label">Flashcards</div><div class="sub">flip &amp; learn</div></button>
      <button class="tile" data-go="quiz"><div class="emoji">❓</div><div class="label">Quiz</div><div class="sub">multiple choice</div></button>
      <button class="tile" data-go="typing"><div class="emoji">⌨️</div><div class="label">Typing</div><div class="sub">spell it out</div></button>
      <button class="tile" data-go="match"><div class="emoji">🧩</div><div class="label">Matching</div><div class="sub">pair them up</div></button>
      <button class="tile" data-go="sentences"><div class="emoji">🗣️</div><div class="label">Sentences</div><div class="sub">translate phrases</div></button>
      <button class="tile" data-go="grammar"><div class="emoji">📖</div><div class="label">Grammar</div><div class="sub">learn &amp; practice</div></button>
      <button class="tile" data-go="test"><div class="emoji">📝</div><div class="label">Lesson test</div><div class="sub">10 mixed questions</div></button>
      <button class="tile" data-go="review"><div class="emoji">🔁</div><div class="label">Review</div><div class="sub">${due ? due + " due today" : "all caught up"}</div></button>
    </div>

    <h3 style="margin:18px 0 10px">🏅 Badges</h3>
    <div class="card"><div class="badges">${badgeHtml}</div></div>

    <h3 style="margin:18px 0 4px">📚 Lessons</h3>
    <div class="subtle" style="margin-bottom:10px">Tap a lesson to study it</div>
    <div class="card lesson-list">${lessonProgress}</div>
  `;
  screenEl().querySelectorAll(".tile").forEach(t => t.onclick = () => go(t.dataset.go));
  screenEl().querySelectorAll(".lesson-row").forEach(r => r.onclick = () => { setLesson(r.dataset.lesson); go("flashcards"); });
  $("#home-review").onclick = () => go("review");
  $("#newest-test").onclick = () => { setLesson(newest.id); go("test"); };
  $("#newest-cards").onclick = () => { setLesson(newest.id); go("flashcards"); };
}

// ---------- Flashcards ----------
let fcPool = [], fcIndex = 0;
function renderFlashcards() {
  screenEl().innerHTML = `<h2 class="screen-title">🃏 Flashcards</h2>` + lessonChips() + `<div id="fc-body"></div>`;
  bindChips();
  fcPool = shuffle(cardsForLesson());
  fcIndex = 0;
  drawFlashcard();
}
function drawFlashcard() {
  const body = $("#fc-body");
  if (!fcPool.length) { body.innerHTML = `<div class="card center subtle">No cards here yet.</div>`; return; }
  const c = fcPool[fcIndex];
  body.innerHTML = `
    <div class="subtle center" style="margin-bottom:8px">${fcIndex + 1} / ${fcPool.length} ${State.mastered.has(c.id) ? "· ✅ mastered" : ""}</div>
    <div class="flashcard" id="flip">
      <div class="flashcard-inner">
        <div class="flashcard-face">
          <div class="side-label">Czech 🇨🇿</div>
          <div class="word">${c.cz}</div>
        </div>
        <div class="flashcard-face flashcard-back">
          <div class="side-label">English 🇬🇧</div>
          <div class="word">${c.en}</div>
          ${c.note ? `<div class="note">${prettyNote(c.note)}</div>` : ""}
        </div>
      </div>
    </div>
    <div class="subtle center">Tap the card to flip</div>
    <div class="row mt">
      <button class="btn-ghost" id="fc-prev">◀ Prev</button>
      <button class="btn-primary" id="fc-known" disabled>Flip first 👆</button>
      <button class="btn-ghost" id="fc-next">Next ▶</button>
    </div>`;
  const flip = $("#flip");
  flip.onclick = () => {
    flip.classList.toggle("flipped");
    const k = $("#fc-known");
    if (k.disabled && !k.dataset.used) { k.disabled = false; k.textContent = `I knew it! +${pointsFor(c.id)}`; }
  };
  $("#fc-prev").onclick = () => { fcIndex = (fcIndex - 1 + fcPool.length) % fcPool.length; drawFlashcard(); };
  $("#fc-next").onclick = () => { fcIndex = (fcIndex + 1) % fcPool.length; drawFlashcard(); };
  $("#fc-known").onclick = () => {
    $("#fc-known").disabled = true;
    $("#fc-known").dataset.used = "1";
    const { wasNew } = award(c.id);
    if (wasNew) confetti();
    if (fcIndex < fcPool.length - 1) fcIndex++;
    drawFlashcard();
  };
}

// ---------- Quiz (multiple choice) ----------
// 3 wrong options that never look the same as the answer, and are never
// another valid translation of the same prompt (e.g. "stát" = state / to cost).
function pickDistractors(q, pool, askCz) {
  const shown = c => normalize(askCz ? c.en : c.cz);
  const asked = c => normalize(askCz ? c.cz : c.en);
  const seen = new Set([shown(q)]), out = [];
  // same-lesson options first: they share the topic, so you really have to read them
  const ordered = shuffle(pool.filter(c => c.lessonId === q.lessonId))
    .concat(shuffle(pool.filter(c => c.lessonId !== q.lessonId)));
  for (const c of ordered) {
    if (out.length === 3) break;
    if (c.id === q.id || asked(c) === asked(q) || seen.has(shown(c))) continue;
    seen.add(shown(c)); out.push(c);
  }
  return out;
}
function renderQuiz() {
  screenEl().innerHTML = `<h2 class="screen-title">❓ Quiz</h2>` + lessonChips() + `<div id="quiz-body"></div>`;
  bindChips();
  nextQuiz();
}
function nextQuiz() {
  const body = $("#quiz-body");
  if (!body) return;
  const pool = cardsForLesson();
  if (allMasteredInPool()) { body.innerHTML = doneScreen("You aced the quiz for this selection!"); return; }
  if (pool.length < 4) { body.innerHTML = `<div class="card center subtle">Need at least 4 words here. Pick another lesson.</div>`; return; }
  // prefer not-yet-mastered
  const notMastered = pool.filter(c => !State.mastered.has(c.id));
  const q = (notMastered.length ? shuffle(notMastered) : shuffle(pool))[0];
  const askCz = Math.random() < 0.5;
  const wrongs = pickDistractors(q, pool, askCz);
  const opts = shuffle([q, ...wrongs]);
  body.innerHTML = `
    <div class="card">
      <div class="prompt">${askCz ? q.cz : q.en}</div>
      <div class="prompt-sub">${askCz ? "What does it mean?" : "How do you say it in Czech?"}</div>
      <div id="opts">${opts.map(o => `<button class="option" data-id="${o.id}">${askCz ? o.en : o.cz}</button>`).join("")}</div>
      <div class="feedback" id="q-fb"></div>
    </div>`;
  screenEl().querySelectorAll(".option").forEach(btn => {
    btn.onclick = () => {
      screenEl().querySelectorAll(".option").forEach(b => b.disabled = true);
      const correct = btn.dataset.id === q.id;
      if (correct) {
        btn.classList.add("correct");
        const { pts } = award(q.id);
        $("#q-fb").className = "feedback good";
        $("#q-fb").textContent = `Správně! +${pts} ✨`;
        confetti();
      } else {
        btn.classList.add("wrong");
        screenEl().querySelector(`.option[data-id="${q.id}"]`).classList.add("correct");
        markWrong(q.id);
        $("#q-fb").className = "feedback bad";
        $("#q-fb").textContent = `Answer: ${askCz ? q.en : q.cz}`;
      }
      later(nextQuiz, correct ? 800 : 1600);
    };
  });
}

// ---------- Typing ----------
function renderTyping() {
  screenEl().innerHTML = titleWithBack("⌨️ Typing challenge") + lessonChips() + `<div id="type-body"></div>`;
  bindChips();
  nextTyping();
}
function nextTyping() {
  const body = $("#type-body");
  if (!body) return;
  const pool = cardsForLesson();
  if (allMasteredInPool()) { body.innerHTML = doneScreen("You typed them all correctly!"); return; }
  if (!pool.length) { body.innerHTML = `<div class="card center subtle">No cards here yet.</div>`; return; }
  const notMastered = pool.filter(c => !State.mastered.has(c.id));
  const q = (notMastered.length ? shuffle(notMastered) : shuffle(pool))[0];
  const accepted = acceptedAnswers(q);
  let solved = false;

  let revealed = 0; // guaranteed left-to-right reveals (fallback so you're never stuck)

  // Smart hint: show letters that the user already got right in position,
  // PLUS the first N letters (guaranteed progressive reveal, one per wrong try).
  const maskHint = (typed) => {
    const normAnswer = q.cz.toLowerCase();
    const normTyped = (typed || "").toLowerCase();
    return q.cz.split("").map((ch, i) => {
      if (ch === " ") return "&nbsp;&nbsp;";
      if (!/\p{L}/u.test(ch)) return ch; // punctuation & "/" are always visible
      // Show if: progressive reveal covers this position, OR user's char matches (accent-forgiving)
      const progressiveMatch = i < revealed;
      const normCh = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      const userCh = (normTyped[i] || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const typedMatch = userCh && (userCh === normCh);
      if (progressiveMatch || typedMatch) return `<b>${ch}</b>`;
      return "•";
    }).join(" ");
  };

  const tNote = typingNote(q, accepted);
  body.innerHTML = `
    <div class="card">
      <div class="prompt-sub">Type the Czech word for:</div>
      <div class="prompt">${q.en}</div>
      ${tNote ? `<div class="prompt-sub">${tNote}</div>` : ""}
      <div class="hint-line" id="type-hint"></div>
      <input class="type-input" id="type-in" placeholder="napiš česky…" autocomplete="off" autocapitalize="off" />
      <div class="feedback" id="type-fb"></div>
      <button class="btn-primary" id="type-check">Check</button>
      <div class="subtle center mt">Wrong guess? A letter is revealed each time 😉 (accents optional, č ≈ c)</div>
    </div>`;
  const input = $("#type-in");
  input.focus();

  const check = () => {
    if (solved) return;
    if (accepted.has(normalize(input.value))) {
      solved = true;
      // Full points only if solved with at most 1 revealed letter; otherwise small points.
      const { pts } = award(q.id, revealed >= 2 ? PTS_REPEAT : undefined);
      if (revealed >= 2) recordResult(q.id, false); // needed help → review it again soon
      $("#type-fb").className = "feedback good";
      $("#type-fb").textContent = `Perfect! ${q.cz} +${pts} ✨`;
      confetti();
      $("#type-check").disabled = true; input.disabled = true;
      later(nextTyping, 1000);
    } else {
      // Reveal one more letter (progressive guarantee) + show position matches from input
      if (revealed < q.cz.length) revealed++;
      $("#type-hint").innerHTML = maskHint(input.value);
      $("#type-fb").className = "feedback bad";
      if (revealed >= q.cz.length) {
        $("#type-fb").textContent = "Here's the whole word — type it to continue!";
      } else {
        $("#type-fb").textContent = `Not quite — matching letters shown. Keep trying!`;
      }
      input.focus();
    }
  };
  $("#type-check").onclick = check;
  input.onkeydown = e => { if (e.key === "Enter") check(); };
}

// ---------- Matching game ----------
function renderMatch() {
  screenEl().innerHTML = titleWithBack("🧩 Matching") + lessonChips() + `<div id="match-body"></div>`;
  bindChips();
  newMatchRound();
}
let matchSel = null, matchDone = 0, matchTotal = 0;
function newMatchRound() {
  const body = $("#match-body");
  if (!body) return;
  const pool = cardsForLesson();
  if (pool.length < 3) { body.innerHTML = `<div class="card center subtle">Need at least 3 words. Pick another lesson.</div>`; return; }
  // pick up to 5 words whose Czech AND English texts are all different (no look-alike tiles)
  const picks = [], seenCz = new Set(), seenEn = new Set();
  for (const c of shuffle(pool)) {
    if (picks.length === 5) break;
    const kc = normalize(c.cz), ke = normalize(c.en);
    if (seenCz.has(kc) || seenEn.has(ke)) continue;
    seenCz.add(kc); seenEn.add(ke); picks.push(c);
  }
  matchTotal = picks.length; matchDone = 0; matchSel = null;
  const left = shuffle(picks).map(c => ({ id: c.id, text: c.cz, lang: "cz" }));
  const right = shuffle(picks).map(c => ({ id: c.id, text: c.en, lang: "en" }));
  body.innerHTML = `
    <div class="subtle center" style="margin-bottom:12px">Match Czech 🇨🇿 with English 🇬🇧</div>
    <div class="match-grid">
      <div>${left.map(i => `<button type="button" class="match-item" data-id="${i.id}" data-lang="cz">${i.text}</button>`).join("")}</div>
      <div>${right.map(i => `<button type="button" class="match-item" data-id="${i.id}" data-lang="en">${i.text}</button>`).join("")}</div>
    </div>
    <div class="feedback" id="match-fb" aria-live="polite"></div>`;
  screenEl().querySelectorAll(".match-item").forEach(el => el.onclick = () => onMatchClick(el));
}
function onMatchClick(el) {
  if (el.classList.contains("done")) return;
  if (!matchSel) { matchSel = el; el.classList.add("sel"); return; }
  if (matchSel === el) { el.classList.remove("sel"); matchSel = null; return; }
  if (matchSel.dataset.lang === el.dataset.lang) { // same column, switch selection
    matchSel.classList.remove("sel"); matchSel = el; el.classList.add("sel"); return;
  }
  // different columns -> check match
  if (matchSel.dataset.id === el.dataset.id) {
    matchSel.classList.add("done"); el.classList.add("done");
    matchSel.classList.remove("sel");
    const { pts } = award(el.dataset.id);
    matchSel = null; matchDone++;
    $("#match-fb").className = "feedback good";
    $("#match-fb").textContent = `Match! +${pts} ✨`;
    if (matchDone === matchTotal) {
      confetti();
      $("#match-fb").textContent = "Round complete! 🎉";
      later(newMatchRound, 1100);
    }
  } else {
    const a = matchSel, b = el;
    markWrong(a.dataset.id);
    a.classList.add("bad"); b.classList.add("bad");
    $("#match-fb").className = "feedback bad";
    $("#match-fb").textContent = "Nope, try again!";
    setTimeout(() => { a.classList.remove("bad", "sel"); b.classList.remove("bad"); }, 400);
    matchSel = null;
  }
}

// ---------- Sentences (multiple choice, reveals full translation) ----------
function renderSentences() {
  screenEl().innerHTML = titleWithBack("🗣️ Sentences") + lessonChips() + `<div id="sent-body"></div>`;
  bindChips();
  nextSentence();
}
function nextSentence() {
  const body = $("#sent-body");
  if (!body) return;
  const pool = sentencesForLesson();
  if (pool.length < 4) { body.innerHTML = `<div class="card center subtle">Need at least 4 sentences here. Pick another lesson or "All".</div>`; return; }
  if (pool.every(s => State.mastered.has(s.id))) { body.innerHTML = doneScreen("You've translated every sentence in this selection!"); return; }

  const notMastered = pool.filter(s => !State.mastered.has(s.id));
  const q = (notMastered.length ? shuffle(notMastered) : shuffle(pool))[0];
  const askCz = Math.random() < 0.5; // show Czech, ask for English (and vice versa)
  const wrongs = pickDistractors(q, pool, askCz);
  const opts = shuffle([q, ...wrongs]);

  body.innerHTML = `
    <div class="card">
      <div class="prompt-sub">${askCz ? "What does this mean?" : "How do you say this in Czech?"}</div>
      <div class="prompt" style="font-size:20px;line-height:1.35">${askCz ? q.cz : q.en}</div>
      <div id="sopts" style="margin-top:14px">
        ${opts.map(o => `<button class="option" data-id="${o.id}">${askCz ? o.en : o.cz}</button>`).join("")}
      </div>
      <div class="feedback" id="s-fb"></div>
      <div id="s-full"></div>
    </div>`;

  screenEl().querySelectorAll(".option").forEach(btn => btn.onclick = () => {
    screenEl().querySelectorAll(".option").forEach(b => b.disabled = true);
    const correct = btn.dataset.id === q.id;
    if (correct) {
      btn.classList.add("correct");
      const { pts } = award(q.id);
      $("#s-fb").className = "feedback good";
      $("#s-fb").textContent = `Správně! +${pts} ✨`;
      confetti();
    } else {
      btn.classList.add("wrong");
      [...screenEl().querySelectorAll(".option")].find(b => b.dataset.id === q.id).classList.add("correct");
      markWrong(q.id);
      $("#s-fb").className = "feedback bad";
      $("#s-fb").textContent = "Not quite!";
    }
    // Always reveal the full translation (both languages)
    $("#s-full").innerHTML = `
      <div class="card" style="background:var(--accent-soft);margin-top:8px">
        <div style="font-weight:700">🇨🇿 ${q.cz}</div>
        <div class="subtle" style="margin-top:4px">🇬🇧 ${q.en}</div>
      </div>
      <button class="btn-primary" id="s-next">Next ▶</button>`;
    $("#s-next").onclick = nextSentence;
  });
}

// ---------- Grammar (Learn + Practice) ----------
let grammarMode = "learn"; // "learn" | "practice"
function renderGrammar() {
  screenEl().innerHTML = `<h2 class="screen-title">📖 Grammar</h2>
    <div class="chips">
      <button class="chip ${grammarMode === "learn" ? "active" : ""}" data-mode="learn">📖 Learn</button>
      <button class="chip ${grammarMode === "practice" ? "active" : ""}" data-mode="practice">🎮 Practice</button>
    </div>
    ${lessonChips()}
    <div id="grammar-body"></div>`;
  screenEl().querySelectorAll(".chip[data-mode]").forEach(c => c.onclick = () => { grammarMode = c.dataset.mode; renderGrammar(); });
  bindChips();
  if (grammarMode === "learn") drawGrammarLearn();
  else nextGrammarQ();
}

function drawGrammarLearn() {
  const body = $("#grammar-body");
  const lessons = State.lesson === "all" ? LESSONS : LESSONS.filter(l => l.id === State.lesson);
  const openAll = lessons.length === 1;
  const html = lessons.map(l => {
    if (!l.grammar || !l.grammar.length) return "";
    const notes = l.grammar.map(g => `<div class="card"><h3>${g.title}</h3><div class="subtle">${g.note}</div></div>`).join("");
    return `<details class="g-lesson" ${openAll ? "open" : ""}>
      <summary>${l.emoji} ${l.title} <span class="g-count">${l.grammar.length}</span></summary>${notes}</details>`;
  }).join("");
  body.innerHTML = html
    ? (openAll ? "" : `<div class="subtle" style="margin-bottom:10px">Tap a lesson to open its grammar notes</div>`) + html
    : `<div class="card center subtle">No grammar notes for this selection.</div>`;
}

function nextGrammarQ() {
  const body = $("#grammar-body");
  if (!body) return;
  const pool = grammarForLesson();
  if (!pool.length) { body.innerHTML = `<div class="card center subtle">No grammar questions here yet. Pick another lesson.</div>`; return; }
  if (pool.every(g => State.mastered.has(g.id))) { body.innerHTML = doneScreen("You've nailed all the grammar questions here!"); return; }
  const notMastered = pool.filter(g => !State.mastered.has(g.id));
  const q = (notMastered.length ? shuffle(notMastered) : shuffle(pool))[0];

  if (q.type === "mc") {
    const opts = shuffle(q.options);
    body.innerHTML = `
      <div class="card">
        <div class="prompt-sub">Choose the correct word:</div>
        <div class="prompt" style="font-size:22px">${q.q}</div>
        <div id="gopts">${opts.map(o => `<button class="option" data-val="${o}">${o}</button>`).join("")}</div>
        <div class="feedback" id="g-fb"></div>
        <div id="g-next"></div>
      </div>`;
    screenEl().querySelectorAll(".option").forEach(btn => btn.onclick = () => {
      screenEl().querySelectorAll(".option").forEach(b => b.disabled = true);
      const correct = btn.dataset.val === q.a;
      if (correct) {
        btn.classList.add("correct");
        const { pts } = award(q.id);
        $("#g-fb").className = "feedback good";
        $("#g-fb").innerHTML = `Správně! +${pts} ✨${q.hint ? `<div class="subtle" style="font-weight:400;margin-top:6px">${q.hint}</div>` : ""}`;
        confetti();
      } else {
        btn.classList.add("wrong");
        [...screenEl().querySelectorAll(".option")].find(b => b.dataset.val === q.a).classList.add("correct");
        markWrong(q.id);
        $("#g-fb").className = "feedback bad";
        $("#g-fb").innerHTML = `Answer: ${q.a}${q.hint ? `<div class="subtle" style="font-weight:400;margin-top:6px">${q.hint}</div>` : ""}`;
      }
      $("#g-next").innerHTML = `<button class="btn-primary" id="g-next-btn">Next ▶</button>`;
      $("#g-next-btn").onclick = nextGrammarQ;
    });
  } else { // fill-in-the-blank
    let gRevealed = 0;
    const gMask = (typed) => q.a.split("").map((ch, i) => {
      if (ch === " ") return "&nbsp;&nbsp;";
      if (!/\p{L}/u.test(ch)) return ch;
      const progressiveMatch = i < gRevealed;
      const normCh = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      const userCh = ((typed || "")[i] || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      const typedMatch = userCh && (userCh === normCh);
      if (progressiveMatch || typedMatch) return `<b>${ch}</b>`;
      return "•";
    }).join(" ");

    body.innerHTML = `
      <div class="card">
        <div class="prompt-sub">Fill in the blank (type the missing word):</div>
        <div class="prompt" style="font-size:20px">${q.q}</div>
        <div class="hint-line" id="g-hint"></div>
        <input class="type-input" id="g-in" placeholder="…" autocomplete="off" autocapitalize="off" />
        <div class="feedback" id="g-fb"></div>
        <button class="btn-primary" id="g-check">Check</button>
        <div id="g-next"></div>
        <div class="subtle center mt">Wrong guess? A letter is revealed each time 😉 (accents optional)</div>
      </div>`;
    const input = $("#g-in");
    input.focus();
    let gSolved = false;
    const check = () => {
      if (gSolved) return;
      if (normalize(input.value) === normalize(q.a)) {
        gSolved = true;
        const { pts } = award(q.id, gRevealed >= 2 ? PTS_REPEAT : undefined);
        if (gRevealed >= 2) recordResult(q.id, false);
        $("#g-fb").className = "feedback good";
        $("#g-fb").innerHTML = `Perfect! ${q.a} +${pts} ✨${q.hint ? `<div class="subtle" style="font-weight:400;margin-top:6px">${q.hint}</div>` : ""}`;
        confetti();
        $("#g-check").style.display = "none"; input.disabled = true;
        $("#g-next").innerHTML = `<button class="btn-primary" id="g-next-btn">Next ▶</button>`;
        $("#g-next-btn").onclick = nextGrammarQ;
      } else {
        if (gRevealed < q.a.length) gRevealed++;
        $("#g-hint").innerHTML = gMask(input.value);
        $("#g-fb").className = "feedback bad";
        $("#g-fb").textContent = gRevealed >= q.a.length
          ? "Here's the whole word — type it to continue!"
          : "Not quite — matching letters shown. Keep trying!";
        input.focus();
      }
    };
    $("#g-check").onclick = check;
    input.onkeydown = e => { if (e.key === "Enter") check(); };
  }
}

// ---------- Rounds: Lesson test & Smart Review ----------
let round = null; // { kind: "test"|"review", qs: [...], i, right, missed: [] }

// Turn any item (word, sentence, grammar question) into a question.
function buildQuestion(id) {
  const entry = ITEM_BY_ID.get(id);
  if (!entry) return null;
  const { kind, item } = entry;
  if (kind === "gram") {
    if (item.type === "mc") return { id, kind: "mc", tag: "📖 Grammar", sub: "Choose the correct word:", prompt: item.q,
      options: shuffle(item.options).map(o => ({ label: o, ok: o === item.a })), answer: item.a, hint: item.hint || "" };
    return { id, kind: "type", tag: "📖 Grammar", sub: "Type the missing word:", prompt: item.q, answer: item.a, hint: item.hint || "" };
  }
  const isSent = kind === "sent";
  const all = isSent ? SENTENCES : ALL_CARDS;
  const lessonPool = all.filter(x => x.lessonId === item.lessonId);
  const askCz = Math.random() < 0.5;
  const wrongs = pickDistractors(item, lessonPool.length >= 4 ? lessonPool : all, askCz);
  return { id, kind: "mc", tag: isSent ? "🗣️ Sentence" : "🔤 Word",
    sub: askCz ? "What does it mean?" : "How do you say it in Czech?",
    prompt: askCz ? item.cz : item.en,
    options: shuffle([item, ...wrongs]).map(o => ({ label: askCz ? o.en : o.cz, ok: o.id === item.id })),
    answer: askCz ? item.en : item.cz,
    hint: isSent ? `🇨🇿 ${item.cz}<br>🇬🇧 ${item.en}` : (item.note ? prettyNote(item.note) : "") };
}

// 10 questions for a lesson test: up to 2 grammar, up to 2 sentences, the rest words.
function testIds() {
  const take = (arr, n) => shuffle(arr).slice(0, n).map(x => x.id);
  const gram = take(grammarForLesson(), 2);
  const sentPool = sentencesForLesson();
  const sent = sentPool.length >= 4 ? take(sentPool, 2) : [];
  const vocab = take(cardsForLesson(), 10 - gram.length - sent.length);
  return shuffle([...vocab, ...sent, ...gram]);
}

function startRound(kind, ids) {
  round = { kind, qs: ids.map(buildQuestion).filter(Boolean), i: 0, right: 0, missed: [] };
  drawRound();
}

function drawRound() {
  const body = $("#round-body");
  if (!body || !round) return;
  if (!round.qs.length) { body.innerHTML = `<div class="card center subtle">Nothing to ask here yet. Pick another lesson.</div>`; return; }
  if (round.i >= round.qs.length) { drawRoundSummary(); return; }
  const q = round.qs[round.i], n = round.qs.length;
  body.innerHTML = `
    <div class="round-progress"><span>Question ${round.i + 1} / ${n}</span><span>✅ ${round.right}</span></div>
    <div class="progress-wrap" style="margin-bottom:14px"><div class="progress-bar" style="width:${Math.round(100 * round.i / n)}%"></div></div>
    <div class="card">
      <div class="round-tag">${q.tag}</div>
      <div class="prompt-sub">${q.sub}</div>
      <div class="prompt" style="font-size:22px;line-height:1.35">${q.prompt}</div>
      ${q.kind === "mc"
        ? `<div id="r-opts">${q.options.map((o, k) => `<button class="option" data-k="${k}">${o.label}</button>`).join("")}</div>`
        : `<input class="type-input" id="r-in" placeholder="…" autocomplete="off" autocapitalize="off" />
           <button class="btn-primary mt" id="r-check">Check</button>`}
      <div class="feedback" id="r-fb" aria-live="polite"></div>
      <div id="r-next"></div>
    </div>`;

  let answered = false;
  const finish = correct => {
    if (answered) return;
    answered = true;
    const fb = $("#r-fb");
    if (correct) {
      const { pts } = award(q.id);
      round.right++;
      fb.className = "feedback good";
      fb.innerHTML = `Správně! +${pts} ✨`;
      confetti();
    } else {
      markWrong(q.id);
      round.missed.push({ prompt: q.prompt, answer: q.answer });
      fb.className = "feedback bad";
      fb.innerHTML = `Answer: ${q.answer}`;
    }
    if (q.hint) fb.innerHTML += `<div class="subtle" style="font-weight:400;margin-top:6px">${q.hint}</div>`;
    const last = round.i === round.qs.length - 1;
    $("#r-next").innerHTML = `<button class="btn-primary" id="r-next-btn">${last ? "See results 🏁" : "Next ▶"}</button>`;
    $("#r-next-btn").onclick = () => { round.i++; drawRound(); };
  };

  if (q.kind === "mc") {
    screenEl().querySelectorAll("#r-opts .option").forEach(btn => btn.onclick = () => {
      if (answered) return;
      const all = [...screenEl().querySelectorAll("#r-opts .option")];
      all.forEach(b => b.disabled = true);
      const ok = q.options[+btn.dataset.k].ok;
      all[q.options.findIndex(o => o.ok)].classList.add("correct");
      if (!ok) btn.classList.add("wrong");
      finish(ok);
    });
  } else {
    const input = $("#r-in");
    const check = () => {
      if (answered || !input.value.trim()) return;
      input.disabled = true; $("#r-check").style.display = "none";
      finish(normalize(input.value) === normalize(q.answer));
    };
    $("#r-check").onclick = check;
    input.onkeydown = e => { if (e.key === "Enter") check(); };
    if (window.matchMedia && !window.matchMedia("(pointer: coarse)").matches) input.focus();
  }
}

function drawRoundSummary() {
  const body = $("#round-body");
  const n = round.qs.length, s = round.right, pct = s / n;
  const emoji = pct === 1 ? "🏆" : pct >= 0.8 ? "🎉" : pct >= 0.5 ? "💪" : "📚";
  const msg = pct === 1 ? "Perfect score!" : pct >= 0.8 ? "Great job!" : pct >= 0.5 ? "Good effort — keep going!" : "Keep practising — you'll get there!";
  if (pct >= 0.8) confetti();
  const missed = round.missed.length
    ? `<div class="card"><h3>Words to practise</h3>${round.missed.map(m =>
        `<div class="missed-row"><div>${m.prompt}</div><div class="subtle">→ ${m.answer}</div></div>`).join("")}
       <div class="subtle mt">These are now in your 🔁 Review.</div></div>`
    : "";
  const due = dueIds().length;
  const again = round.kind === "test"
    ? `<button class="btn-primary" id="r-again">📝 New test</button>`
    : (due ? `<button class="btn-primary" id="r-again">🔁 Next review round (${due} left)</button>`
           : `<div class="card center subtle">All caught up for today ✨</div>`);
  body.innerHTML = `
    <div class="card center">
      <div style="font-size:52px">${emoji}</div>
      <div style="font-size:34px;font-weight:800;color:var(--accent)">${s} / ${n}</div>
      <div class="subtle">${msg}</div>
    </div>
    ${missed}
    <div class="round-actions">
      ${again}
      ${round.kind === "test" && round.missed.length ? `<button class="btn-ghost" id="r-review">🔁 Review my mistakes</button>` : ""}
      <button class="btn-ghost" id="r-home">🏠 Home</button>
    </div>`;
  const againBtn = $("#r-again");
  if (againBtn) againBtn.onclick = () => round.kind === "test" ? startRound("test", testIds()) : startRound("review", dueIds().slice(0, 15));
  const rv = $("#r-review"); if (rv) rv.onclick = () => go("review");
  $("#r-home").onclick = () => go("home");
}

function renderTest() {
  screenEl().innerHTML = titleWithBack("📝 Lesson test") + lessonChips() +
    `<div class="subtle" style="margin:-6px 0 12px">10 mixed questions: words, sentences & grammar</div><div id="round-body"></div>`;
  bindChips();
  startRound("test", testIds());
}

function renderReview() {
  screenEl().innerHTML = titleWithBack("🔁 Review") + `<div id="round-body"></div>`;
  const ids = dueIds();
  if (ids.length) { startRound("review", ids.slice(0, 15)); return; }
  round = null;
  const today = dayNumber();
  const future = Object.entries(State.review).filter(([id]) => ITEM_BY_ID.has(id)).map(([, r]) => r.d).filter(d => d > today);
  const next = future.length ? Math.min(...future) - today : null;
  $("#round-body").innerHTML = `
    <div class="card center">
      <div style="font-size:52px">✨</div>
      <h2 style="margin:8px 0">All caught up!</h2>
      <p class="subtle">${next == null ? "Answer some questions in any activity and they'll start appearing here."
        : `Next review ${next === 1 ? "tomorrow" : "in " + next + " days"}.`}</p>
      <p class="subtle mt">Words come back after 1, 3, 7, 14 and 30 days — and mistakes come back right away.</p>
    </div>
    <div class="round-actions"><button class="btn-primary" id="r-home">🏠 Home</button></div>`;
  $("#r-home").onclick = () => go("home");
}

// ---------- Dictionary (searchable, alphabetical) ----------
// Build a de-duplicated, sorted word list once from ALL_CARDS.
const DICT = (() => {
  const seen = new Map();
  ALL_CARDS.forEach(c => {
    const key = c.cz.toLowerCase() + "|" + c.en.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, { cz: c.cz, en: c.en, note: c.note, lessons: new Set([c.lessonTitle]) });
    } else {
      seen.get(key).lessons.add(c.lessonTitle);
    }
  });
  return [...seen.values()].sort((a, b) =>
    a.cz.localeCompare(b.cz, "cs", { sensitivity: "base" }));
})();

let dictQuery = "";
function renderDict() {
  screenEl().innerHTML = `<h2 class="screen-title">📚 Dictionary</h2>
    <input class="dict-search" id="dict-search" type="search" placeholder="🔍 Search Czech or English…" value="${dictQuery.replace(/"/g, "&quot;")}" autocomplete="off" />
    <div class="subtle center" id="dict-count" style="margin:8px 0"></div>
    <div id="dict-list"></div>`;
  const input = $("#dict-search");
  input.oninput = () => { dictQuery = input.value; drawDictList(); };
  drawDictList();
  // Only auto-focus on devices with a mouse — on phones it would pop the keyboard over the list.
  if (window.matchMedia && !window.matchMedia("(pointer: coarse)").matches) {
    input.focus();
    const v = input.value; input.value = ""; input.value = v; // keep cursor at end
  }
}
function drawDictList() {
  const q = normalize(dictQuery);
  // best matches first: exact word → word starts with it → contains it
  const rank = d => {
    const cz = normalize(d.cz), en = normalize(d.en);
    const words = (cz + " " + en).split(/[\s/]+/);
    if (cz === q || en === q || words.includes(q)) return 0;
    if (cz.startsWith(q) || en.startsWith(q) || words.some(w => w.startsWith(q))) return 1;
    if (cz.includes(q) || en.includes(q)) return 2;
    return -1;
  };
  const results = !q ? DICT : DICT.map(d => [rank(d), d]).filter(([r]) => r >= 0)
    .sort((a, b) => a[0] - b[0]).map(([, d]) => d); // stable sort keeps alphabetical order inside each group
  $("#dict-count").textContent = `${results.length} word${results.length === 1 ? "" : "s"}${q ? " found" : ""}`;
  if (!results.length) {
    $("#dict-list").innerHTML = `<div class="card center subtle">No words match "${esc(dictQuery)}". Try Czech or English.</div>`;
    return;
  }
  $("#dict-list").innerHTML = results.map(d => `
    <div class="dict-row">
      <div class="dict-cz">${d.cz}</div>
      <div class="dict-en">${d.en}</div>
      ${d.note ? `<div class="dict-note">${prettyNote(d.note)}</div>` : ""}
      <div class="dict-lesson">${[...d.lessons].map(lessonLabel).join(" · ")}</div>
    </div>`).join("");
}

// ---------- Leaderboard ----------
let rankMode = "week"; // "week" | "all"
async function renderRank() {
  screenEl().innerHTML = `<h2 class="screen-title">🏆 Leaderboard</h2>
    <div class="chips">
      <button class="chip ${rankMode === "week" ? "active" : ""}" data-rank="week">📅 This week</button>
      <button class="chip ${rankMode === "all" ? "active" : ""}" data-rank="all">🏆 All time</button>
    </div>
    <div id="rank-body" class="subtle center">Loading…</div>`;
  screenEl().querySelectorAll(".chip[data-rank]").forEach(c => c.onclick = () => { rankMode = c.dataset.rank; render(); });
  const tok = renderToken;
  const board = await apiLeaderboard();
  if (tok !== renderToken || !$("#rank-body")) return; // user left the screen while loading
  $("#rank-body").className = "";

  if (!board.length) {
    $("#rank-body").innerHTML = `<div class="card center"><div style="font-size:48px">🏁</div><div class="subtle">No scores yet — go play and claim the crown!</div></div>`;
    return;
  }

  let weekly = rankMode === "week";
  if (weekly && board.every(p => p.week == null)) {
    if (!db) weekly = false; // offline / library missing: show what we have
    else {
      $("#rank-body").innerHTML = `<div class="card center"><div style="font-size:40px">🛠️</div>
        <div class="subtle">The weekly ranking needs a one-time database update.<br>Until then, see <b>🏆 All time</b>.</div></div>`;
      return;
    }
  }

  const score = p => weekly ? (p.week || 0) : p.points;
  const list = [...board].sort((a, b) => score(b) - score(a));
  const medals = ["🥇", "🥈", "🥉"];
  const rankClass = ["gold", "silver", "bronze"];
  const leader = list[0];
  const top = score(leader) || 1;
  const nobodyYet = score(leader) === 0;

  // Champion banner
  const champ = nobodyYet
    ? `<div class="champ-banner"><div class="champ-crown">🏁</div><div class="champ-name">New week, new race!</div>
        <div class="champ-sub">No points yet this week — be the first</div></div>`
    : `<div class="champ-banner">
        <div class="champ-crown">👑</div>
        <div class="champ-name">${esc(leader.name)}${leader.name === State.name ? " (you!)" : ""}</div>
        <div class="champ-sub">${weekly ? "Leading this week" : "Current champion"} · ✨ ${score(leader)}</div>
      </div>`;

  const rows = list.map((p, i) => {
    const pct = Math.round((score(p) / top) * 100);
    return `<div class="rank-row ${p.name === State.name ? "me" : ""} ${rankClass[i] || ""}" style="animation-delay:${i * 80}ms">
      <div class="medal">${medals[i] || (i + 1)}</div>
      <div class="rank-main">
        <div class="rname">${esc(p.name)}${p.name === State.name ? " (you)" : ""}</div>
        <div class="rank-bar-wrap"><div class="rank-bar" style="width:0%" data-w="${pct}%"></div></div>
      </div>
      <div class="rpts">✨ ${score(p)}<div class="subtle" style="font-weight:400">${weekly ? "this week" : p.mastered + " words"}</div></div>
    </div>`;
  }).join("");

  $("#rank-body").innerHTML = champ + rows +
    `<div class="card mt center subtle">${weekly ? "The weekly race resets every Monday 🗓️" : "Play more to climb the ranks! 🧗"}</div>`;

  // Animate the point-share bars after paint
  requestAnimationFrame(() => {
    screenEl().querySelectorAll(".rank-bar").forEach(b => { b.style.width = b.dataset.w; });
  });

  // Celebrate if the current player is #1
  if (!nobodyYet && leader.name === State.name) confetti();
}

// =============================================================
// Router / navigation
// =============================================================
function render() {
  renderToken++;
  const map = { home: renderHome, flashcards: renderFlashcards, quiz: renderQuiz, typing: renderTyping, match: renderMatch, sentences: renderSentences, grammar: renderGrammar, dict: renderDict, rank: renderRank, test: renderTest, review: renderReview };
  (map[State.screen] || renderHome)();
}
function go(screen) {
  State.screen = screen;
  // Typing, Match and Sentences launch from Home tiles (not the tab bar),
  // so treat Home as their active tab for highlighting purposes.
  const tabless = ["typing", "match", "sentences", "test", "review"];
  const activeTab = tabless.includes(screen) ? "home" : screen;
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.screen === activeTab));
  window.scrollTo(0, 0);
  render();
}

// ---------- Theme ----------
function initTheme() {
  const saved = localStorage.getItem("cz_theme") || "light";
  document.body.dataset.theme = saved;
  $("#theme-toggle").textContent = saved === "dark" ? "☀️" : "🌙";
  $("#theme-toggle").onclick = () => {
    const next = document.body.dataset.theme === "dark" ? "light" : "dark";
    document.body.dataset.theme = next;
    localStorage.setItem("cz_theme", next);
    $("#theme-toggle").textContent = next === "dark" ? "☀️" : "🌙";
  };
}

// ---------- Startup ----------
async function startApp() {
  $("#name-gate").classList.add("hidden");
  $("#app").classList.remove("hidden");
  initTheme();
  screenEl().innerHTML = `<div class="card center subtle" style="margin-top:40px">⏳ Loading your progress…</div>`;
  await apiLoadPlayer(State.name);
  localStorage.setItem("cz_name", State.name); // saved spelling (e.g. "goksu" → "Goksu")
  updateTopbar();
  document.querySelectorAll(".tab").forEach(t => t.onclick = () => go(t.dataset.screen));
  go("home");
}

function initGate() {
  const input = $("#name-input");
  const goBtn = $("#name-go");
  if (State.name) input.value = State.name;
  let started = false;
  const submit = () => {
    const v = input.value.trim();
    if (!v) { input.focus(); return; }
    if (started) return;
    started = true;
    State.name = v;
    startApp();
  };
  goBtn.onclick = submit;
  input.onkeydown = e => { if (e.key === "Enter") submit(); };
}

window.addEventListener("DOMContentLoaded", initGate);
