// Grassroots server. See flow.md (architecture) and decision.md (why).
// MODE=local (default): everything on one machine, judging happens in this process.
// MODE=hub: hosted copy with no AI. worker.js on your laptop fetches photos, judges them and posts verdicts (D32).
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { gemma, judgeObject, judgeSquad, makeBank, BAD_QUEST, MODEL } = require('./judge');

const MODE = process.env.MODE === 'hub' ? 'hub' : 'local';
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || __dirname);
const WORKER_KEY = process.env.WORKER_KEY || '';
const MIN_CONFIDENCE = 60;
const REQUIRE_OUTDOORS = process.env.REQUIRE_OUTDOORS !== '0';        // D27
const SCREEN_LIMIT = Number(process.env.SCREEN_LIMIT) || 3;           // D20
const WALK_STOPS = 5, WALK_POINTS = 4, WALK_BONUS = 10, DETOX_POINTS = 15;
const TOGETHER_BONUS = 10, TOGETHER_WINDOW = 90 * 60 * 1000;          // D34

// ---- storage: one JSON file in memory (D5). Photos are temp files until judged (D37) ----
fs.mkdirSync(path.join(DATA_DIR, 'photos'), { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'data.json');
let db = { groups: {}, players: {}, subs: [], hashes: [], bank: {}, workerSeen: 0 };
if (fs.existsSync(DB_FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
db.bank = { squad: [], stops: [], detox: [], ...db.bank };
const save = () => { const t = DB_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(db)); fs.renameSync(t, DB_FILE); };

// ---- helpers ----
const uid = () => crypto.randomUUID();
const clean = s => String(s || '').trim().slice(0, 24);
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const serverDay = () => ymd(new Date());
const prevDay = day => { const [y, m, d] = day.split('-').map(Number); return ymd(new Date(y, m - 1, d - 1)); };
// The phone decides which day it is (D36); the server only checks it is plausible.
const validDay = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && Math.abs(new Date(d + 'T12:00:00') - Date.now()) < 4 * 864e5;
const photoPath = id => path.join(DATA_DIR, 'photos', id + '.jpg');
const pendingSubs = () => db.subs.filter(s => s.status === 'pending').sort((a, b) => a.takenAt - b.takenAt);

// ---- quests: taken from the bank Gemma fills ahead of time (D33), with built-in fallbacks ----
const SQUAD_FALLBACK = [
  'Play a ball game together in an open space.', 'Go for a walk-and-talk through a green area.',
  'Toss a frisbee or ball around together.', 'Have a snack break together outside.',
  'Stretch or do a light workout together in the open air.', 'Take a long walk together and chat about your week.'
];
const WALK_POOL = [
  'Photograph something red.', 'Photograph something yellow.', 'Photograph a tree.', 'Photograph a flower.',
  'Photograph a bird or an animal.', 'Photograph a vehicle.', 'Photograph the sky.', 'Photograph a stone.',
  'Photograph something made of metal.', 'Photograph a fence or a gate.', 'Photograph a shadow.', 'Photograph something round.'
];
const DETOX_FALLBACK = ['Go outside and photograph the sky.', 'Find a tree and photograph its trunk.', 'Photograph something green growing outside.'];
const shuffle = a => a.map(v => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map(x => x[1]);
function take(kind, fallback, n, avoid = []) {
  const out = [];
  while (out.length < n && db.bank[kind].length) { const t = db.bank[kind].shift(); if (!avoid.includes(t) && !out.includes(t)) out.push(t); }
  for (const t of shuffle(fallback)) if (out.length < n && !out.includes(t) && !avoid.includes(t)) out.push(t);
  for (const t of shuffle(fallback)) if (out.length < n && !out.includes(t)) out.push(t);
  return out;
}
function planFor(g, day) {
  g.days = g.days || {};
  if (!g.days[day]) {
    const used = Object.values(g.days).map(d => d.quest.text);
    g.days[day] = {
      quest: { id: uid(), text: take('squad', SQUAD_FALLBACK, 1, used)[0] },
      walk: { id: uid(), stops: take('stops', WALK_POOL, WALK_STOPS) },
      detox: { id: uid(), text: take('detox', DETOX_FALLBACK, 1)[0] }
    };
    Object.keys(g.days).sort().slice(0, -7).forEach(k => delete g.days[k]);
    save();
  }
  return g.days[day];
}
const bankNeeds = () => ({ squad: Math.max(0, 8 - db.bank.squad.length), stops: Math.max(0, 15 - db.bank.stops.length), detox: Math.max(0, 8 - db.bank.detox.length) });
function addBank(lists) {
  for (const k of Object.keys(db.bank))
    for (const t of (lists && lists[k]) || [])
      if (typeof t === 'string' && t.trim() && t.length <= 110 && !BAD_QUEST.test(t) && !db.bank[k].includes(t.trim())) db.bank[k].push(t.trim());
  save();
}

// ---- scoring: applies one verdict from the judge to a sealed proof ----
function togetherBonus(sub) {
  const mates = db.subs.filter(s => s !== sub && s.group === sub.group && s.kind === 'squad' && s.refId === sub.refId && s.match &&
    s.playerId !== sub.playerId && Math.abs(s.takenAt - sub.takenAt) <= TOGETHER_WINDOW);
  if (!mates.length) return 0;
  mates.filter(s => !s.togetherPaid).forEach(s => { s.togetherPaid = true; s.points += TOGETHER_BONUS; db.players[s.playerId].points += TOGETHER_BONUS; });
  sub.togetherPaid = true;
  return TOGETHER_BONUS;
}
function applyVerdict(sub, v) {
  const p = db.players[sub.playerId];
  const confidence = Number(v.confidence) || 0;
  const looksRight = v.match === true && confidence >= MIN_CONFIDENCE && !(sub.kind === 'squad' && v.people === false);
  const indoors = REQUIRE_OUTDOORS && v.outdoors === false;                 // only an explicit false blocks (D27)
  let ok = looksRight && !indoors, caption = String(v.caption || '').slice(0, 200), points = 0;
  if (ok && p.done[sub.key]) { ok = false; caption = 'Already completed.'; }
  Object.assign(sub, { status: 'done', match: ok, confidence, caption, judgedAt: Date.now(), points: 0, reason: ok ? '' : (looksRight && indoors ? 'indoors' : 'nomatch') });
  if (ok) {
    p.done[sub.key] = true; db.hashes.push(sub.hash); db.hashes = db.hashes.slice(-2000);
    if (sub.kind === 'squad') {
      if (!p.lastDay || sub.day > p.lastDay) { p.streak = p.lastDay === prevDay(sub.day) ? p.streak + 1 : 1; p.lastDay = sub.day; }
      points = 10 + Math.min(p.streak, 5) + togetherBonus(sub);              // D34
    } else if (sub.kind === 'walk') {
      points = WALK_POINTS;                                                  // D35
      const n = Array.from({ length: WALK_STOPS }, (_, k) => p.done[`walk:${sub.refId}:${k}`]).filter(Boolean).length;
      if (n >= WALK_STOPS) points += WALK_BONUS;
    } else points = DETOX_POINTS;                                            // D21
    p.points += points; sub.points = points;
  }
  fs.rm(photoPath(sub.id), { force: true }, () => {});                       // D37: photo deleted once judged
  if (db.subs.length > 600) db.subs = pendingSubs().concat(db.subs.filter(s => s.status === 'done').slice(-400));
  save();
}

// ---- local judge loop (MODE=local) ----
let judging = false, filling = false;
async function judgeNext() {
  if (judging) return;
  const sub = pendingSubs().find(s => (s.retryAt || 0) <= Date.now());
  if (!sub) return;
  judging = true;
  try {
    if (!fs.existsSync(photoPath(sub.id))) applyVerdict(sub, { match: false, caption: 'The photo was lost before judging.' });
    else {
      const image = fs.readFileSync(photoPath(sub.id)).toString('base64');
      applyVerdict(sub, await (sub.kind === 'squad' ? judgeSquad : judgeObject)(sub.text, image));
      console.log(`Judged ${sub.kind} from ${sub.player}: ${sub.match ? 'pass' : 'fail'}`);
    }
  } catch (e) {
    if (e.parse && (sub.attempts = (sub.attempts || 0) + 1) >= 3) applyVerdict(sub, { match: false, caption: 'The judge could not read this photo.' });
    else sub.retryAt = Date.now() + 10000;
    console.log('Judge problem:', e.message);
  } finally { judging = false; if (pendingSubs().some(s => (s.retryAt || 0) <= Date.now())) setImmediate(judgeNext); }
}
async function fillBank() {
  if (filling || !Object.values(bankNeeds()).some(n => n > 0)) return;
  filling = true;
  try { addBank(await makeBank(bankNeeds())); console.log('Quest bank refilled.'); }
  catch (e) { console.log('Bank refill failed:', e.message); }
  finally { filling = false; }
}

// ---- app ----
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function newPlayer(name, code) {
  const id = uid();
  db.players[id] = { id, name, group: code, points: 0, streak: 0, lastDay: null, done: {}, screen: {} };
  return id;
}
app.post('/api/groups', (req, res) => {
  const name = clean(req.body.name), player = clean(req.body.player);
  if (!name || !player) return res.status(400).json({ error: 'Enter a group name and your name.' });
  const code = crypto.randomBytes(3).toString('hex').slice(0, 5).toUpperCase();
  db.groups[code] = { code, name, days: {}, createdAt: Date.now() };
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

function myView(p, plan, day) {
  const subs = db.subs.filter(s => s.playerId === p.id);
  const state = key => p.done[key] ? 'pass' : subs.some(s => s.key === key && s.status === 'pending') ? 'wait' : 'none';
  return {
    squad: state('squad:' + plan.quest.id),
    walk: plan.walk.stops.map((_, k) => state(`walk:${plan.walk.id}:${k}`)),
    detox: state('detox:' + plan.detox.id),
    screenHours: p.screen[day] === undefined ? null : p.screen[day],
    proofs: subs.slice(-8).reverse().map(s => ({ id: s.id, kind: s.kind, text: s.text, status: s.status, match: s.match, caption: s.caption, points: s.points, reason: s.reason }))
  };
}
app.get('/api/groups/:code', (req, res) => {
  const g = db.groups[req.params.code];
  if (!g) return res.status(404).json({ error: 'Group not found.' });
  const day = validDay(req.query.day) ? req.query.day : serverDay();
  const plan = planFor(g, day);
  const me = db.players[req.query.player];
  const mine = me && me.group === g.code ? myView(me, plan, day) : null;
  const live = p => (p.lastDay === day || p.lastDay === prevDay(day)) ? p.streak : 0;
  const walkDone = p => plan.walk.stops.filter((_, k) => p.done[`walk:${plan.walk.id}:${k}`]).length;
  res.json({
    name: g.name, code: g.code, day, mode: MODE,
    judge: { online: MODE === 'local' || Date.now() - db.workerSeen < 120000, waiting: pendingSubs().filter(s => s.group === g.code).length },
    quest: { id: plan.quest.id, text: plan.quest.text },
    walk: { total: WALK_STOPS, stops: mine ? plan.walk.stops : [] },
    detox: { text: mine ? plan.detox.text : '', limit: SCREEN_LIMIT },
    players: Object.values(db.players).filter(p => p.group === g.code)
      .map(p => ({ id: p.id, name: p.name, points: p.points, streak: live(p), squad: !!p.done['squad:' + plan.quest.id], walk: walkDone(p) }))
      .sort((a, b) => b.points - a.points),
    feed: db.subs.filter(s => s.group === g.code && s.status === 'done').slice(-15).reverse()
      .map(s => ({ player: s.player, kind: s.kind, match: s.match, confidence: s.confidence, caption: s.caption, points: s.points })),
    mine
  });
});

app.post('/api/groups/:code/reroll', (req, res) => {
  const g = db.groups[req.params.code];
  if (!g) return res.status(404).json({ error: 'Group not found.' });
  const plan = planFor(g, validDay(req.body.day) ? req.body.day : serverDay());
  if (db.subs.some(s => s.group === g.code && s.refId === plan.quest.id && (s.status === 'pending' || s.match)))
    return res.status(400).json({ error: 'Someone already sent a photo for this quest, so it cannot be swapped.' });
  plan.quest = { id: uid(), text: take('squad', SQUAD_FALLBACK, 1, Object.values(g.days).map(d => d.quest.text))[0] };
  save();
  res.json({ quest: plan.quest.text });
});

app.post('/api/screentime', (req, res) => {
  const p = db.players[req.body.playerId];
  if (!p) return res.status(404).json({ error: 'Player not found. Rejoin the group.' });
  const hours = Number(req.body.hours);
  if (req.body.hours === '' || req.body.hours == null || !(hours >= 0 && hours <= 24)) return res.status(400).json({ error: 'Enter hours between 0 and 24.' });
  p.screen[validDay(req.body.day) ? req.body.day : serverDay()] = hours;
  save();
  res.json({ over: hours >= SCREEN_LIMIT, limit: SCREEN_LIMIT });
});

// A sealed proof: stored as pending, judged later (D31). Safe to send twice (same photo returns the same id).
app.post('/api/submit', (req, res) => {
  const { playerId, kind, image, day } = req.body;
  const p = db.players[playerId];
  if (!p) return res.status(404).json({ error: 'Player not found. Rejoin the group.' });
  if (!['squad', 'walk', 'detox'].includes(kind)) return res.status(400).json({ error: 'Unknown quest type.' });
  if (!validDay(day)) return res.status(400).json({ error: 'Your phone clock looks wrong. Check the date and time.' });
  if (typeof image !== 'string' || image.length < 100 || image.length > 4e6) return res.status(400).json({ error: 'That photo could not be used.' });
  const g = db.groups[p.group], plan = planFor(g, day);
  let ref;
  if (kind === 'squad') ref = { key: 'squad:' + plan.quest.id, refId: plan.quest.id, text: plan.quest.text };
  else if (kind === 'walk') {
    const k = Number(req.body.stopIndex);
    if (!Number.isInteger(k) || k < 0 || k >= WALK_STOPS) return res.status(400).json({ error: 'Unknown walk stop.' });
    ref = { key: `walk:${plan.walk.id}:${k}`, refId: plan.walk.id, text: plan.walk.stops[k] };
  } else {
    if (!(p.screen[day] >= SCREEN_LIMIT)) return res.status(400).json({ error: `Log ${SCREEN_LIMIT} or more hours of screen time to unlock the detox quest.` });
    ref = { key: 'detox:' + plan.detox.id, refId: plan.detox.id, text: plan.detox.text };
  }
  if (p.done[ref.key]) return res.status(400).json({ error: 'You already completed this one.' });
  const hash = crypto.createHash('sha1').update(image).digest('hex');
  const same = db.subs.find(s => s.playerId === p.id && s.hash === hash && s.status === 'pending');
  if (same) return res.json({ queued: true, id: same.id });
  if (db.hashes.includes(hash)) return res.status(400).json({ error: 'That photo was already used. Take a new one.' });
  if (db.subs.some(s => s.playerId === p.id && s.key === ref.key && s.status === 'pending')) return res.status(400).json({ error: 'A photo for this is already waiting for the judge.' });
  const id = uid();
  fs.writeFileSync(photoPath(id), Buffer.from(image, 'base64'));
  const takenAt = Math.min(Number(req.body.takenAt) || Date.now(), Date.now() + 5 * 60000);
  db.subs.push({ id, group: g.code, playerId: p.id, player: p.name, kind, day, key: ref.key, refId: ref.refId, text: ref.text, hash, takenAt, status: 'pending' });
  save();
  res.json({ queued: true, id });
  if (MODE === 'local') setImmediate(judgeNext);
});

// ---- endpoints for the home judge (worker.js), protected by WORKER_KEY ----
const auth = (req, res, next) => (WORKER_KEY && req.get('x-worker-key') === WORKER_KEY) ? next() : res.status(401).json({ error: 'Worker key required.' });
app.get('/api/worker/pending', auth, (req, res) => {
  db.workerSeen = Date.now();
  res.json({ proofs: pendingSubs().slice(0, 20).map(s => ({ id: s.id, kind: s.kind, text: s.text })), bank: bankNeeds() });
});
app.get('/api/worker/photo/:id', auth, (req, res) => {
  if (!/^[0-9a-f-]{36}$/.test(req.params.id) || !fs.existsSync(photoPath(req.params.id))) return res.status(404).json({ error: 'No such photo.' });
  res.type('image/jpeg').sendFile(photoPath(req.params.id));
});
app.post('/api/worker/verdict/:id', auth, (req, res) => {
  const sub = db.subs.find(s => s.id === req.params.id && s.status === 'pending');
  if (!sub) return res.status(404).json({ error: 'No pending proof with that id.' });
  applyVerdict(sub, req.body || {});
  res.json({ ok: true, match: sub.match, points: sub.points });
});
app.post('/api/worker/bank', auth, (req, res) => { addBank(req.body); res.json({ ok: true, bank: bankNeeds() }); });

app.get('/api/health', async (req, res) => {
  if (MODE === 'hub') return res.json({ server: 'ok', mode: MODE, judgeSeenSecondsAgo: db.workerSeen ? Math.round((Date.now() - db.workerSeen) / 1000) : null });
  try { const r = await fetch((process.env.OLLAMA_URL || 'http://localhost:11434') + '/api/tags'); res.json({ server: 'ok', mode: MODE, ollama: r.ok ? 'ok' : 'error', model: MODEL }); }
  catch { res.json({ server: 'ok', mode: MODE, ollama: 'unreachable', model: MODEL }); }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Grassroots running in ${MODE} mode.${MODE === 'local' ? ' Model: ' + MODEL : ''}`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list) if (i.family === 'IPv4' && !i.internal) console.log(`  Open on your phone: http://${i.address}:${PORT}`);
  if (MODE === 'hub') { if (!WORKER_KEY) console.log('WARNING: WORKER_KEY is not set, so no home judge can connect.'); return; }
  gemma([{ role: 'user', content: 'Reply with the word ok.' }], false)             // D28
    .then(() => console.log('Gemma is warmed up.'))
    .catch(e => console.log('Warm-up failed (is Ollama running?):', e.message));
  setInterval(judgeNext, 2000);
  setInterval(() => { if (!pendingSubs().length) fillBank(); }, 60000);
  setTimeout(fillBank, 5000);
});
