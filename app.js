/* =============================================================
   Czech Mate — app logic
   ============================================================= */

// ---------- State ----------
const State = {
  name: localStorage.getItem("cz_name") || "",
  points: 0,
  mastered: new Set(),      // card ids this player has mastered
  answered: new Set(),      // ids answered at least once this session
  lesson: "all",            // current lesson filter
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

// ---------- Scoring rules ----------
const PTS_FULL = 10;   // first time a card is mastered
const PTS_REPEAT = 1;  // repeats still fun, but small
function pointsFor(cardId) {
  return State.mastered.has(cardId) ? PTS_REPEAT : PTS_FULL;
}

// ---------- Supabase leaderboard ----------
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

async function apiLoadPlayer(name) {
  try {
    const { data } = await supabase.from("players").select("*").eq("name", name).single();
    if (data) {
      State.points = data.points || 0;
      State.mastered = new Set(data.mastered || []);
    }
  } catch (e) { /* offline or first time: keep defaults */ }
}

async function apiScore(cardId, pts) {
  try {
    // Upsert: create the row if it doesn't exist, update if it does.
    const { data: existing } = await supabase.from("players").select("*").eq("name", State.name).single();
    if (existing) {
      const mastered = existing.mastered || [];
      if (cardId && !mastered.includes(cardId)) mastered.push(cardId);
      await supabase.from("players").update({
        points: (existing.points || 0) + (pts || 0),
        mastered: mastered
      }).eq("name", State.name);
    } else {
      await supabase.from("players").insert({
        name: State.name,
        points: pts || 0,
        mastered: cardId ? [cardId] : []
      });
    }
  } catch (e) { /* offline: ignore */ }
}

async function apiLeaderboard() {
  try {
    const { data } = await supabase.from("players").select("*").order("points", { ascending: false });
    return (data || []).map(p => ({ name: p.name, points: p.points || 0, mastered: (p.mastered || []).length }));
  } catch (e) { return [{ name: State.name, points: State.points, mastered: State.mastered.size }]; }
}

// Award points for a correct answer on a card.
async function award(cardId) {
  const pts = pointsFor(cardId);
  const wasNew = !State.mastered.has(cardId);
  State.points += pts;
  State.mastered.add(cardId);
  State.answered.add(cardId);
  updateTopbar();
  await apiScore(cardId, pts);
  return { pts, wasNew };
}

// ---------- Levels & badges ----------
const LEVELS = [
  { min: 0,    name: "Začátečník" },   // Beginner
  { min: 150,  name: "Cestovatel" },   // Traveler
  { min: 400,  name: "Student" },
  { min: 800,  name: "Machr" },        // Pro
  { min: 1500, name: "Rodilý mluvčí" } // Native-ish
];
function currentLevel() {
  let lvl = LEVELS[0];
  for (const l of LEVELS) if (State.points >= l.min) lvl = l;
  return lvl;
}

const BADGES = [
  { id: "first", emoji: "🐣", name: "First word", test: () => State.mastered.size >= 1 },
  { id: "ten", emoji: "🔟", name: "10 words", test: () => State.mastered.size >= 10 },
  { id: "fifty", emoji: "🧠", name: "50 words", test: () => State.mastered.size >= 50 },
  { id: "hundred", emoji: "💯", name: "100 words", test: () => State.mastered.size >= 100 },
  { id: "half", emoji: "🌟", name: "Halfway", test: () => State.mastered.size >= ALL_CARDS.length / 2 },
  { id: "all", emoji: "👑", name: "All words", test: () => State.mastered.size >= ALL_CARDS.length },
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
// forgiving compare: ignore case, spaces and diacritics
function normalize(s) {
  return (s || "").toLowerCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ");
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
  const chips = [`<button class="chip ${State.lesson === "all" ? "active" : ""}" data-lesson="all">All 🌍</button>`]
    .concat(LESSONS.map(l =>
      `<button class="chip ${State.lesson === l.id ? "active" : ""}" data-lesson="${l.id}">${l.emoji} ${l.title.split("—")[0].trim()}</button>`));
  return `<div class="chips">${chips.join("")}</div>`;
}
function bindChips() {
  screenEl().querySelectorAll(".chip[data-lesson]").forEach(c => c.onclick = () => {
    State.lesson = c.dataset.lesson;
    render();
  });
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
  const mastered = State.mastered.size;
  const pct = total ? Math.round((mastered / total) * 100) : 0;
  const wod = ALL_CARDS[new Date().getDate() % ALL_CARDS.length];

  const badgeHtml = BADGES.map(b =>
    `<div class="badge ${b.test() ? "earned" : ""}"><div class="b-emoji">${b.emoji}</div><div class="b-name">${b.name}</div></div>`
  ).join("");

  const lessonProgress = LESSONS.map(l => {
    const cards = ALL_CARDS.filter(c => c.lessonId === l.id);
    const m = cards.filter(c => State.mastered.has(c.id)).length;
    const p = cards.length ? Math.round((m / cards.length) * 100) : 0;
    return `<div class="card">
      <h3>${l.emoji} ${l.title}</h3>
      <div class="subtle" style="margin-bottom:8px">${m}/${cards.length} words mastered</div>
      <div class="progress-wrap"><div class="progress-bar" style="width:${p}%"></div></div>
    </div>`;
  }).join("");

  screenEl().innerHTML = `
    <h2 class="screen-title">Ahoj, ${State.name}! 👋</h2>
    <div class="card center">
      <div class="subtle">Total progress</div>
      <div style="font-size:34px;font-weight:800;color:var(--accent)">${pct}%</div>
      <div class="progress-wrap"><div class="progress-bar" style="width:${pct}%"></div></div>
      <div class="subtle mt">${mastered} of ${total} words · Level: <span class="pill">${currentLevel().name}</span></div>
    </div>

    <div class="card">
      <h3>📅 Word of the day</h3>
      <div style="font-size:26px;font-weight:800">${wod.cz}</div>
      <div class="subtle">${wod.en}${wod.note ? " · " + wod.note : ""}</div>
    </div>

    <h3 style="margin:18px 0 10px">Play &amp; learn</h3>
    <div class="tiles">
      <button class="tile" data-go="flashcards"><div class="emoji">🃏</div><div class="label">Flashcards</div><div class="sub">flip &amp; learn</div></button>
      <button class="tile" data-go="quiz"><div class="emoji">❓</div><div class="label">Quiz</div><div class="sub">multiple choice</div></button>
      <button class="tile" data-go="typing"><div class="emoji">⌨️</div><div class="label">Typing</div><div class="sub">spell it out</div></button>
      <button class="tile" data-go="match"><div class="emoji">🧩</div><div class="label">Matching</div><div class="sub">pair them up</div></button>
      <button class="tile" data-go="sentences"><div class="emoji">🗣️</div><div class="label">Sentences</div><div class="sub">translate phrases</div></button>
      <button class="tile" data-go="grammar"><div class="emoji">📖</div><div class="label">Grammar</div><div class="sub">learn &amp; practice</div></button>
    </div>

    <h3 style="margin:18px 0 10px">🏅 Badges</h3>
    <div class="card"><div class="badges">${badgeHtml}</div></div>

    <h3 style="margin:18px 0 10px">📚 Lessons</h3>
    ${lessonProgress}
  `;
  screenEl().querySelectorAll(".tile").forEach(t => t.onclick = () => go(t.dataset.go));
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
          ${c.note ? `<div class="note">${c.note}</div>` : ""}
        </div>
      </div>
    </div>
    <div class="subtle center">Tap the card to flip</div>
    <div class="row mt">
      <button class="btn-ghost" id="fc-prev">◀ Prev</button>
      <button class="btn-primary" id="fc-known">I knew it! +${pointsFor(c.id)}</button>
      <button class="btn-ghost" id="fc-next">Next ▶</button>
    </div>`;
  const flip = $("#flip");
  flip.onclick = () => flip.classList.toggle("flipped");
  $("#fc-prev").onclick = () => { fcIndex = (fcIndex - 1 + fcPool.length) % fcPool.length; drawFlashcard(); };
  $("#fc-next").onclick = () => { fcIndex = (fcIndex + 1) % fcPool.length; drawFlashcard(); };
  $("#fc-known").onclick = async () => {
    const { wasNew } = await award(c.id);
    if (wasNew) confetti();
    if (fcIndex < fcPool.length - 1) { fcIndex++; drawFlashcard(); }
    else drawFlashcard();
  };
}

// ---------- Quiz (multiple choice) ----------
function renderQuiz() {
  screenEl().innerHTML = `<h2 class="screen-title">❓ Quiz</h2>` + lessonChips() + `<div id="quiz-body"></div>`;
  bindChips();
  nextQuiz();
}
function nextQuiz() {
  const body = $("#quiz-body");
  const pool = cardsForLesson();
  if (allMasteredInPool()) { body.innerHTML = doneScreen("You aced the quiz for this selection!"); return; }
  if (pool.length < 4) { body.innerHTML = `<div class="card center subtle">Need at least 4 words here. Pick another lesson.</div>`; return; }
  // prefer not-yet-mastered
  const notMastered = pool.filter(c => !State.mastered.has(c.id));
  const q = (notMastered.length ? shuffle(notMastered) : shuffle(pool))[0];
  const askCz = Math.random() < 0.5;
  const wrongs = shuffle(pool.filter(c => c.id !== q.id)).slice(0, 3);
  const opts = shuffle([q, ...wrongs]);
  body.innerHTML = `
    <div class="card">
      <div class="prompt">${askCz ? q.cz : q.en}</div>
      <div class="prompt-sub">${askCz ? "What does it mean?" : "How do you say it in Czech?"}</div>
      <div id="opts">${opts.map(o => `<button class="option" data-id="${o.id}">${askCz ? o.en : o.cz}</button>`).join("")}</div>
      <div class="feedback" id="q-fb"></div>
    </div>`;
  screenEl().querySelectorAll(".option").forEach(btn => {
    btn.onclick = async () => {
      screenEl().querySelectorAll(".option").forEach(b => b.disabled = true);
      const correct = btn.dataset.id === q.id;
      if (correct) {
        btn.classList.add("correct");
        const { pts } = await award(q.id);
        $("#q-fb").className = "feedback good";
        $("#q-fb").textContent = `Správně! +${pts} ✨`;
        confetti();
      } else {
        btn.classList.add("wrong");
        screenEl().querySelector(`.option[data-id="${q.id}"]`).classList.add("correct");
        $("#q-fb").className = "feedback bad";
        $("#q-fb").textContent = `Answer: ${askCz ? q.en : q.cz}`;
      }
      setTimeout(nextQuiz, correct ? 800 : 1600);
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
  const pool = cardsForLesson();
  if (allMasteredInPool()) { body.innerHTML = doneScreen("You typed them all correctly!"); return; }
  if (!pool.length) { body.innerHTML = `<div class="card center subtle">No cards here yet.</div>`; return; }
  const notMastered = pool.filter(c => !State.mastered.has(c.id));
  const q = (notMastered.length ? shuffle(notMastered) : shuffle(pool))[0];

  let revealed = 0; // guaranteed left-to-right reveals (fallback so you're never stuck)

  // Smart hint: show letters that the user already got right in position,
  // PLUS the first N letters (guaranteed progressive reveal, one per wrong try).
  const maskHint = (typed) => {
    const normAnswer = q.cz.toLowerCase();
    const normTyped = (typed || "").toLowerCase();
    return q.cz.split("").map((ch, i) => {
      if (ch === " ") return "&nbsp;&nbsp;";
      if (ch === "/" || ch === "-") return ch;
      // Show if: progressive reveal covers this position, OR user's char matches (accent-forgiving)
      const progressiveMatch = i < revealed;
      const normCh = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      const userCh = (normTyped[i] || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const typedMatch = userCh && (userCh === normCh);
      if (progressiveMatch || typedMatch) return `<b>${ch}</b>`;
      return "•";
    }).join(" ");
  };

  body.innerHTML = `
    <div class="card">
      <div class="prompt-sub">Type the Czech word for:</div>
      <div class="prompt">${q.en}</div>
      ${q.note ? `<div class="prompt-sub">${q.note}</div>` : ""}
      <div class="hint-line" id="type-hint"></div>
      <input class="type-input" id="type-in" placeholder="napiš česky…" autocomplete="off" autocapitalize="off" />
      <div class="feedback" id="type-fb"></div>
      <button class="btn-primary" id="type-check">Check</button>
      <div class="subtle center mt">Wrong guess? A letter is revealed each time 😉 (accents optional, č ≈ c)</div>
    </div>`;
  const input = $("#type-in");
  input.focus();

  const check = async () => {
    if (normalize(input.value) === normalize(q.cz)) {
      // Full points only if solved with at most 1 revealed letter; otherwise small points.
      const cheap = revealed >= 2;
      const before = State.mastered.has(q.id);
      let pts;
      if (cheap && !before) { // solved mostly via hints, first time: give repeat-size points, still master it
        pts = PTS_REPEAT; State.points += pts; State.mastered.add(q.id); State.answered.add(q.id);
        updateTopbar(); await apiScore(q.id, pts);
      } else {
        const r = await award(q.id); pts = r.pts;
      }
      $("#type-fb").className = "feedback good";
      $("#type-fb").textContent = `Perfect! ${q.cz} +${pts} ✨`;
      confetti();
      $("#type-check").disabled = true; input.disabled = true;
      setTimeout(nextTyping, 1000);
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
  const pool = cardsForLesson();
  if (pool.length < 3) { body.innerHTML = `<div class="card center subtle">Need at least 3 words. Pick another lesson.</div>`; return; }
  const picks = shuffle(pool).slice(0, Math.min(5, pool.length));
  matchTotal = picks.length; matchDone = 0; matchSel = null;
  const left = shuffle(picks).map(c => ({ id: c.id, text: c.cz, lang: "cz" }));
  const right = shuffle(picks).map(c => ({ id: c.id, text: c.en, lang: "en" }));
  body.innerHTML = `
    <div class="subtle center" style="margin-bottom:12px">Match Czech 🇨🇿 with English 🇬🇧</div>
    <div class="match-grid">
      <div>${left.map(i => `<div class="match-item" data-id="${i.id}" data-lang="cz">${i.text}</div>`).join("")}</div>
      <div>${right.map(i => `<div class="match-item" data-id="${i.id}" data-lang="en">${i.text}</div>`).join("")}</div>
    </div>
    <div class="feedback" id="match-fb"></div>`;
  screenEl().querySelectorAll(".match-item").forEach(el => el.onclick = () => onMatchClick(el));
}
async function onMatchClick(el) {
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
    const { pts } = await award(el.dataset.id);
    matchSel = null; matchDone++;
    $("#match-fb").className = "feedback good";
    $("#match-fb").textContent = `Match! +${pts} ✨`;
    if (matchDone === matchTotal) {
      confetti();
      $("#match-fb").textContent = "Round complete! 🎉";
      setTimeout(newMatchRound, 1100);
    }
  } else {
    const a = matchSel, b = el;
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
  const pool = sentencesForLesson();
  if (pool.length < 4) { body.innerHTML = `<div class="card center subtle">Need at least 4 sentences here. Pick another lesson or "All".</div>`; return; }
  if (pool.every(s => State.mastered.has(s.id))) { body.innerHTML = doneScreen("You've translated every sentence in this selection!"); return; }

  const notMastered = pool.filter(s => !State.mastered.has(s.id));
  const q = (notMastered.length ? shuffle(notMastered) : shuffle(pool))[0];
  const askCz = Math.random() < 0.5; // show Czech, ask for English (and vice versa)
  const wrongs = shuffle(pool.filter(s => s.id !== q.id)).slice(0, 3);
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

  screenEl().querySelectorAll(".option").forEach(btn => btn.onclick = async () => {
    screenEl().querySelectorAll(".option").forEach(b => b.disabled = true);
    const correct = btn.dataset.id === q.id;
    if (correct) {
      btn.classList.add("correct");
      const { pts } = await award(q.id);
      $("#s-fb").className = "feedback good";
      $("#s-fb").textContent = `Správně! +${pts} ✨`;
      confetti();
    } else {
      btn.classList.add("wrong");
      [...screenEl().querySelectorAll(".option")].find(b => b.dataset.id === q.id).classList.add("correct");
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
  const html = lessons.map(l => {
    if (!l.grammar || !l.grammar.length) return "";
    const notes = l.grammar.map(g => `<div class="card"><h3>${g.title}</h3><div class="subtle">${g.note}</div></div>`).join("");
    return `<h3 style="margin:16px 0 8px">${l.emoji} ${l.title}</h3>${notes}`;
  }).join("");
  body.innerHTML = html || `<div class="card center subtle">No grammar notes for this selection.</div>`;
}

function nextGrammarQ() {
  const body = $("#grammar-body");
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
    screenEl().querySelectorAll(".option").forEach(btn => btn.onclick = async () => {
      screenEl().querySelectorAll(".option").forEach(b => b.disabled = true);
      const correct = btn.dataset.val === q.a;
      if (correct) {
        btn.classList.add("correct");
        const { pts } = await award(q.id);
        $("#g-fb").className = "feedback good";
        $("#g-fb").innerHTML = `Správně! +${pts} ✨${q.hint ? `<div class="subtle" style="font-weight:400;margin-top:6px">${q.hint}</div>` : ""}`;
        confetti();
      } else {
        btn.classList.add("wrong");
        [...screenEl().querySelectorAll(".option")].find(b => b.dataset.val === q.a).classList.add("correct");
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
      if (ch === "/" || ch === "-") return ch;
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
    const check = async () => {
      if (normalize(input.value) === normalize(q.a)) {
        const cheap = gRevealed >= 2;
        const before = State.mastered.has(q.id);
        let pts;
        if (cheap && !before) {
          pts = PTS_REPEAT; State.points += pts; State.mastered.add(q.id); State.answered.add(q.id);
          updateTopbar(); await apiScore(q.id, pts);
        } else {
          const r = await award(q.id); pts = r.pts;
        }
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

// ---------- Leaderboard ----------
async function renderRank() {
  screenEl().innerHTML = `<h2 class="screen-title">🏆 Leaderboard</h2><div id="rank-body" class="subtle center">Loading…</div>`;
  const board = await apiLeaderboard();
  $("#rank-body").className = "";

  if (!board.length) {
    $("#rank-body").innerHTML = `<div class="card center"><div style="font-size:48px">🏁</div><div class="subtle">No scores yet — go play and claim the crown!</div></div>`;
    return;
  }

  const medals = ["🥇", "🥈", "🥉"];
  const rankClass = ["gold", "silver", "bronze"];
  const top = board[0].points || 1;
  const leader = board[0];

  // Champion banner
  const champ = `
    <div class="champ-banner">
      <div class="champ-crown">👑</div>
      <div class="champ-name">${leader.name}${leader.name === State.name ? " (you!)" : ""}</div>
      <div class="champ-sub">Current champion · ✨ ${leader.points}</div>
    </div>`;

  const rows = board.map((p, i) => {
    const pct = Math.round(((p.points || 0) / top) * 100);
    return `<div class="rank-row ${p.name === State.name ? "me" : ""} ${rankClass[i] || ""}" style="animation-delay:${i * 80}ms">
      <div class="medal">${medals[i] || (i + 1)}</div>
      <div class="rank-main">
        <div class="rname">${p.name}${p.name === State.name ? " (you)" : ""}</div>
        <div class="rank-bar-wrap"><div class="rank-bar" style="width:0%" data-w="${pct}%"></div></div>
      </div>
      <div class="rpts">✨ ${p.points}<div class="subtle" style="font-weight:400">${p.mastered} words</div></div>
    </div>`;
  }).join("");

  $("#rank-body").innerHTML = champ + rows +
    `<div class="card mt center subtle">Play more to climb the ranks! 🧗</div>`;

  // Animate the point-share bars after paint
  requestAnimationFrame(() => {
    screenEl().querySelectorAll(".rank-bar").forEach(b => { b.style.width = b.dataset.w; });
  });

  // Celebrate if the current player is #1
  if (leader.name === State.name && leader.points > 0) confetti();
}

// =============================================================
// Router / navigation
// =============================================================
function render() {
  const map = { home: renderHome, flashcards: renderFlashcards, quiz: renderQuiz, typing: renderTyping, match: renderMatch, sentences: renderSentences, grammar: renderGrammar, rank: renderRank };
  (map[State.screen] || renderHome)();
}
function go(screen) {
  State.screen = screen;
  // Typing, Match and Sentences launch from Home tiles (not the tab bar),
  // so treat Home as their active tab for highlighting purposes.
  const tabless = ["typing", "match", "sentences"];
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
  localStorage.setItem("cz_name", State.name);
  $("#name-gate").classList.add("hidden");
  $("#app").classList.remove("hidden");
  await apiLoadPlayer(State.name);
  updateTopbar();
  initTheme();
  document.querySelectorAll(".tab").forEach(t => t.onclick = () => go(t.dataset.screen));
  go("home");
}

function initGate() {
  const input = $("#name-input");
  const goBtn = $("#name-go");
  if (State.name) input.value = State.name;
  const submit = () => {
    const v = input.value.trim();
    if (!v) { input.focus(); return; }
    State.name = v;
    startApp();
  };
  goBtn.onclick = submit;
  input.onkeydown = e => { if (e.key === "Enter") submit(); };
}

window.addEventListener("DOMContentLoaded", initGate);
