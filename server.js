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
  'Photograph three different kinds of leaves together.',
  'Find an animal or a bird and photograph it.'
];

// ---- Gemma via Ollama ----
async function gemma(messages, wantJson) {
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, messages, stream: false,
      ...(wantJson ? { format: 'json' } : {}),
      options: { temperature: 0.4, num_ctx: 2048 }
    })
  });
  if (!r.ok) throw new Error('Ollama returned ' + r.status);
  return (await r.json()).message.content;
}

// One quest per group per day, generated lazily on first request.
const inflight = {};
function ensureQuest(g) {
  if (g.quest && g.quest.day === today()) return Promise.resolve(g.quest);
  if (!inflight[g.code]) {
    inflight[g.code] = (async () => {
      let text;
      try {
        const avoid = (g.past || []).slice(-5).join(' | ');
        const out = await gemma([{ role: 'user', content:
          'You are the Quest Master of a friends\' outdoor game. Invent ONE short photo quest that can be done ' +
          'outside in under 20 minutes and checked from a single photo. Use easy-to-see things: colors, plants, ' +
          'sky, vehicles, animals, shapes. Do not repeat these: ' + avoid +
          '\nReply with JSON only: {"quest":"<one sentence>"}' }], true);
        text = JSON.parse(out).quest;
      } catch (e) { console.log('Quest generation failed, using fallback:', e.message); }
      if (typeof text !== 'string' || !text.trim() || text.length > 160)
        text = FALLBACK[Math.floor(Math.random() * FALLBACK.length)];
      g.quest = { id: crypto.randomUUID(), text: text.trim(), day: today() };
      g.past = [...(g.past || []), g.quest.text].slice(-10);
      save();
      return g.quest;
    })().finally(() => { delete inflight[g.code]; });
  }
  return inflight[g.code];
}

const liveStreak = p => (p.lastDay === today() || p.lastDay === yesterday()) ? p.streak : 0;

// ---- app ----
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function newPlayer(name, code) {
  const id = crypto.randomUUID();
  db.players[id] = { id, name, group: code, points: 0, streak: 0, lastDay: null, doneQuest: null };
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
  const quest = await ensureQuest(g);
  const players = Object.values(db.players).filter(p => p.group === g.code)
    .map(p => ({ id: p.id, name: p.name, points: p.points, streak: liveStreak(p), doneToday: p.doneQuest === quest.id }))
    .sort((a, b) => b.points - a.points);
  const feed = db.subs.filter(s => s.group === g.code).slice(-15).reverse();
  res.json({ name: g.name, code: g.code, quest: { text: quest.text }, players, feed });
});

app.post('/api/submit', async (req, res) => {
  const p = db.players[req.body.playerId];
  if (!p) return res.status(404).json({ error: 'Player not found. Rejoin the group.' });
  const image = req.body.image;
  if (!image || typeof image !== 'string') return res.status(400).json({ error: 'No photo received.' });
  const g = db.groups[p.group];
  const quest = await ensureQuest(g);
  if (p.doneQuest === quest.id) return res.status(400).json({ error: 'You already finished today\'s quest.' });
  const hash = crypto.createHash('sha1').update(image).digest('hex');
  if (db.hashes.includes(hash)) return res.status(400).json({ error: 'That photo was already used. Take a new one.' });

  let v;
  try {
    v = JSON.parse(await gemma([{ role: 'user', images: [image], content:
      `Quest: "${quest.text}"\nDoes this photo clearly satisfy the quest? Be fair but not gullible.\n` +
      'Reply with JSON only: {"match": true or false, "confidence": 0-100, "caption": "one friendly sentence about what you see"}' }], true));
  } catch (e) {
    console.log('Judge failed:', e.message);
    return res.status(502).json({ error: 'The judge (Gemma) did not answer. Is Ollama running?' });
  }
  const confidence = Number(v.confidence) || 0;
  const match = v.match === true && confidence >= MIN_CONFIDENCE;
  const caption = String(v.caption || '').slice(0, 200);
  let points = 0;

  if (match) {
    const first = !db.subs.some(s => s.group === g.code && s.day === today() && s.match);
    p.streak = p.lastDay === yesterday() ? p.streak + 1 : 1;
    p.lastDay = today();
    p.doneQuest = quest.id;
    points = 10 + (first ? 5 : 0) + Math.min(p.streak, 5);
    p.points += points;
    db.hashes.push(hash);
  }
  db.subs.push({ group: g.code, player: p.name, day: today(), match, confidence, caption, points, at: Date.now() });
  db.subs = db.subs.slice(-300);
  save();
  res.json({ match, confidence, caption, points,
    message: match ? `+${points} points. ${caption}` : `Not quite (${confidence}% sure). ${caption}` });
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
