// TouchGrass Squad server. See flow.md (architecture) and decision.md (why).
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MODEL = process.env.MODEL || 'gemma4:e4b-it-q4_K_M';
const OLLAMA = process.env.OLLAMA_URL || 'http://localhost:11434';
const PORT = process.env.PORT || 3000;
const MIN_CONFIDENCE = 60;
const WALK_STOPS = 5, WALK_POINTS = 4, WALK_BONUS = 10;   // walk challenge (D22, D23)
const REQUIRE_OUTDOORS = process.env.REQUIRE_OUTDOORS !== '0';   // D27
const SCREEN_LIMIT = Number(process.env.SCREEN_LIMIT) || 3; // hours per day before a detox quest
const DB_FILE = path.join(__dirname, 'data.json');

// ---- storage: one JSON file, loaded into memory (decision D5) ----
let db = { groups: {}, players: {}, subs: [], hashes: [] };
if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

// ---- helpers ----
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => ymd(new Date());
const yesterday = () => { const d = new Date(); d.setDate(d.getDate() - 1); return ymd(d); };
const clean = s => String(s || '').trim().slice(0, 24);
const FALLBACK = [
  'Photograph something red that you find outside.',
  'Find a plant growing where it probably should not (a crack, a wall).',
  'Take a photo of the biggest tree you can find.',
  'Capture the sky with at least one cloud in it.',
  'Photograph a handful or pile of leaves.',
  'Find an animal or a bird and photograph it.'
];

// ---- Gemma via Ollama ----
async function gemma(messages, wantJson, temp = 0.4) {
  const body = {
    model: MODEL, messages, stream: false, keep_alive: '30m',
    ...(wantJson ? { format: 'json' } : {}),
    options: { temperature: temp, num_ctx: 2048 }
  };
  const post = b => fetch(`${OLLAMA}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  let r = await post({ ...body, think: false });   // D26: skip Gemma 4's slow thinking step
  if (r.status === 400) r = await post(body);      // this Ollama/model does not accept the flag
  if (!r.ok) throw new Error('Ollama returned ' + r.status);
  return (await r.json()).message.content;
}

const DETOX_FALLBACK = [
  'Go outside and photograph the sky.',
  'Find a tree and photograph its trunk.',
  'Photograph something green growing outside.'
];
const BAD_QUEST = /\d|\b(exactly|one|two|three|four|five|six|seven|eight|nine|ten)\b/i;

// Ask Gemma for one simple quest. Returns null if the answer is unusable (decision D18).
async function makeQuestText(avoid, detox) {
  const kind = detox
    ? 'a short "detox" challenge that gets someone outside and away from their phone for 10 to 15 minutes'
    : 'a short, simple photo quest that can be done outside in under 20 minutes';
  try {
    const out = await gemma([{ role: 'user', content:
      `You are the Quest Master of a friends' outdoor game. Invent ONE ${kind}. It must be checkable from a single photo. ` +
      'The judge is a small AI that CANNOT count, read text, or check exact details, so: never use numbers or counting ' +
      '(no "two", "three", "exactly"), no rare or hard-to-find things, no brands or writing. Ask for ONE common, clearly ' +
      'visible thing: a color, a plant, the sky, a vehicle, an animal, a shape. Good examples: "Photograph something yellow." ' +
      '"Photograph a tree trunk." Do not repeat these: ' + avoid +
      '\nReply with JSON only: {"quest":"<one sentence>"}' }], true);
    const t = JSON.parse(out).quest;
    if (typeof t === 'string' && t.trim() && t.length <= 100 && !BAD_QUEST.test(t)) return t.trim();
  } catch (e) { console.log('Quest generation failed:', e.message); }
  return null;
}

// One quest per group per day, generated lazily on first request.
const inflight = {};
function ensureQuest(g) {
  if (g.quest && g.quest.day === today()) return Promise.resolve(g.quest);
  if (!inflight[g.code]) {
    inflight[g.code] = (async () => {
      const text = (await makeQuestText((g.past || []).slice(-5).join(' | '), false)) ||
        FALLBACK[Math.floor(Math.random() * FALLBACK.length)];
      g.quest = { id: crypto.randomUUID(), text, day: today() };
      g.past = [...(g.past || []), text].slice(-10);
      save();
      return g.quest;
    })().finally(() => { delete inflight[g.code]; });
  }
  return inflight[g.code];
}

const WALK_POOL = [
  'Photograph something red.', 'Photograph something yellow.', 'Photograph a tree.', 'Photograph a flower.',
  'Photograph a bird or an animal.', 'Photograph a vehicle.', 'Photograph the sky.', 'Photograph a stone.',
  'Photograph something made of metal.', 'Photograph a fence or a gate.', 'Photograph a shadow.', 'Photograph something round.'
];

// Ask Gemma for the walk's checkpoint targets. Anything unusable is replaced from WALK_POOL (D22).
async function makeWalkStops(n) {
  let list = [];
  try {
    const out = await gemma([{ role: 'user', content:
      `You are the Quest Master of a friends' outdoor walk game. Invent ${n} DIFFERENT, very simple photo targets, one per checkpoint, ` +
      'to find while walking outside. The judge is a small AI that CANNOT count, read text, or check exact details, so: never use ' +
      'numbers or counting, no rare things, no brands or writing. Each target is one short sentence about one common, clearly visible ' +
      'thing, like "Photograph something blue." or "Photograph a tree trunk."\nReply with JSON only: {"stops":["...", "..."]}' }], true);
    list = JSON.parse(out).stops;
  } catch (e) { console.log('Walk generation failed:', e.message); }
  list = (Array.isArray(list) ? list : []).filter(t => typeof t === 'string' && t.trim() && t.length <= 80 && !BAD_QUEST.test(t)).map(t => t.trim());
  list = [...new Set(list)].slice(0, n);
  const pool = WALK_POOL.filter(x => !list.includes(x)).sort(() => Math.random() - 0.5);
  while (list.length < n) list.push(pool.shift());
  return list;
}

// One walk per group per day. Stops are revealed to players one at a time.
function ensureWalk(g) {
  if (g.walk && g.walk.day === today()) return Promise.resolve(g.walk);
  const key = 'walk:' + g.code;
  if (!inflight[key]) {
    inflight[key] = (async () => {
      g.walk = { id: crypto.randomUUID(), day: today(), stops: await makeWalkStops(WALK_STOPS) };
      save();
      return g.walk;
    })().finally(() => { delete inflight[key]; });
  }
  return inflight[key];
}

const liveStreak = p => (p.lastDay === today() || p.lastDay === yesterday()) ? p.streak : 0;

// ---- app ----
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function newPlayer(name, code) {
  const id = crypto.randomUUID();
  db.players[id] = { id, name, group: code, points: 0, streak: 0, lastDay: null, doneQuest: null, screenHours: null, screenDay: null, detox: null };
  return id;
}

app.post('/api/groups', (req, res) => {
  const name = clean(req.body.name), player = clean(req.body.player);
  if (!name || !player) return res.status(400).json({ error: 'Enter a group name and your name.' });
  const code = crypto.randomBytes(3).toString('hex').slice(0, 5).toUpperCase();
  db.groups[code] = { code, name, quest: null, past: [], createdAt: Date.now() };
  const playerId = newPlayer(player, code);
  save();
  res.json({ code, playerId });
});

app.post('/api/join', (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase(), player = clean(req.body.player);
  if (!db.groups[code]) return res.status(404).json({ error: 'Group not found. Check the code.' });
  if (!player) return res.status(400).json({ error: 'Enter your name.' });
  const playerId = newPlayer(player, code);
  save();
  res.json({ code, playerId });
});

app.get('/api/groups/:code', async (req, res) => {
  const g = db.groups[req.params.code];
  if (!g) return res.status(404).json({ error: 'Group not found.' });
  const [quest, walk] = await Promise.all([ensureQuest(g), ensureWalk(g)]);
  const players = Object.values(db.players).filter(p => p.group === g.code)
    .map(p => ({ id: p.id, name: p.name, points: p.points, streak: liveStreak(p), doneToday: p.doneQuest === quest.id, walk: p.walk && p.walk.id === walk.id ? p.walk.done : 0 }))
    .sort((a, b) => b.points - a.points);
  const feed = db.subs.filter(s => s.group === g.code).slice(-15).reverse();
  const me = db.players[req.query.player];
  const d = me && me.detox && me.detox.day === today() ? me.detox : null;
  const mine = me && me.group === g.code ? {
    limit: SCREEN_LIMIT,
    screenHours: me.screenDay === today() ? me.screenHours : null,
    detox: d ? { text: d.text, done: !!d.done } : null,
    walk: (() => {
      const done = me.walk && me.walk.id === walk.id ? me.walk.done : 0;
      return { total: walk.stops.length, done, current: done < walk.stops.length ? walk.stops[done] : null };
    })() } : null;
  res.json({ name: g.name, code: g.code, quest: { text: quest.text }, players, walkTotal: walk.stops.length, feed, mine });
});

app.post('/api/groups/:code/reroll', async (req, res) => {
  const g = db.groups[req.params.code];
  if (!g) return res.status(404).json({ error: 'Group not found.' });
  if (g.quest && Object.values(db.players).some(p => p.group === g.code && p.doneQuest === g.quest.id))
    return res.status(400).json({ error: 'Someone already finished this quest, so it cannot be swapped.' });
  g.quest = null;
  const q = await ensureQuest(g);
  res.json({ quest: q.text });
});

// Self-reported screen time. At or over the limit, the player gets a personal detox quest (D12, D20, D21).
app.post('/api/screentime', async (req, res) => {
  const p = db.players[req.body.playerId];
  if (!p) return res.status(404).json({ error: 'Player not found. Rejoin the group.' });
  const hours = Number(req.body.hours);
  if (req.body.hours === '' || !(hours >= 0 && hours <= 24)) return res.status(400).json({ error: 'Enter hours between 0 and 24.' });
  p.screenHours = hours; p.screenDay = today();
  const over = hours >= SCREEN_LIMIT;
  if (over && !(p.detox && p.detox.day === today())) {
    const g = db.groups[p.group];
    const text = (await makeQuestText(g.quest ? g.quest.text : '', true)) ||
      DETOX_FALLBACK[Math.floor(Math.random() * DETOX_FALLBACK.length)];
    p.detox = { id: crypto.randomUUID(), text, day: today(), done: false };
  }
  save();
  res.json({ over, limit: SCREEN_LIMIT });
});

app.post('/api/submit', async (req, res) => {
  const p = db.players[req.body.playerId];
  if (!p) return res.status(404).json({ error: 'Player not found. Rejoin the group.' });
  const image = req.body.image;
  if (!image || typeof image !== 'string') return res.status(400).json({ error: 'No photo received.' });
  const g = db.groups[p.group];
  const detox = req.body.kind === 'detox', walk = req.body.kind === 'walk';
  let target;
  if (detox) {
    if (!p.detox || p.detox.day !== today()) return res.status(400).json({ error: 'You have no detox quest today.' });
    if (p.detox.done) return res.status(400).json({ error: 'You already finished today\'s detox quest.' });
    target = p.detox;
  } else if (walk) {
    const w = await ensureWalk(g);
    if (!p.walk || p.walk.id !== w.id) p.walk = { id: w.id, done: 0 };
    if (p.walk.done >= w.stops.length) return res.status(400).json({ error: 'You already finished today\'s walk.' });
    target = { text: w.stops[p.walk.done] };
  } else {
    target = await ensureQuest(g);
    if (p.doneQuest === target.id) return res.status(400).json({ error: 'You already finished today\'s quest.' });
  }
  const hash = crypto.createHash('sha1').update(image).digest('hex');
  if (db.hashes.includes(hash)) return res.status(400).json({ error: 'That photo was already used. Take a new one.' });

  let v;
  try {
    v = JSON.parse(await gemma([{ role: 'user', images: [image], content:
      `Quest: "${target.text}"\n` +
      'First list the main objects you can clearly see. Do not guess what kind of place it is or what people are doing; name only what is visible.\n' +
      'Then decide whether the photo clearly satisfies the quest.\n' +
      'Also say whether it was taken outdoors. Answer true if there is any sign of being outside (sky, ground, grass, plants, an outdoor wall or street, daylight); close-ups of things outside count as outdoors. Answer false only if it is clearly inside a room.\n' +
      'Reply with JSON only: {"seen": ["..."], "match": true or false, "confidence": 0-100, "outdoors": true or false, "caption": "one friendly sentence naming only what you can see"}' }], true, 0.2));
  } catch (e) {
    console.log('Judge failed:', e.message);
    return res.status(502).json({ error: 'The judge (Gemma) did not answer. Is Ollama running?' });
  }
  const confidence = Number(v.confidence) || 0;
  const looksRight = v.match === true && confidence >= MIN_CONFIDENCE;
  const indoors = REQUIRE_OUTDOORS && v.outdoors === false;   // only an explicit "false" blocks (D27)
  const match = looksRight && !indoors;
  const caption = String(v.caption || '').slice(0, 200);
  let points = 0;

  if (match) {
    db.hashes.push(hash);
    if (detox) {
      points = 15; p.detox.done = true;                       // flat reward, no streak or first bonus (D21)
    } else if (walk) {
      p.walk.done++;
      points = WALK_POINTS + (p.walk.done >= WALK_STOPS ? WALK_BONUS : 0);   // D23
    } else {
      const first = !db.subs.some(s => s.group === g.code && s.day === today() && s.match && (!s.kind || s.kind === 'quest'));
      p.streak = p.lastDay === yesterday() ? p.streak + 1 : 1;
      p.lastDay = today();
      p.doneQuest = target.id;
      points = 10 + (first ? 5 : 0) + Math.min(p.streak, 5);
    }
    p.points += points;
  }
  db.subs.push({ group: g.code, player: p.name, kind: detox ? 'detox' : walk ? 'walk' : 'quest', day: today(), match, confidence, caption, points, at: Date.now() });
  db.subs = db.subs.slice(-300);
  save();
  res.json({ match, confidence, caption, points,
    message: match ? `+${points} points. ${caption}` : (looksRight && indoors ? 'That looks like it was taken indoors. Take it outside and try again.' : `Not quite. ${caption}`) });
});

app.get('/api/health', async (req, res) => {
  try { const r = await fetch(`${OLLAMA}/api/tags`); res.json({ server: 'ok', ollama: r.ok ? 'ok' : 'error', model: MODEL }); }
  catch { res.json({ server: 'ok', ollama: 'unreachable', model: MODEL }); }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`TouchGrass Squad running. Model: ${MODEL}`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list) if (i.family === 'IPv4' && !i.internal) console.log(`  Open on your phone: http://${i.address}:${PORT}`);
});
