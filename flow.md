# flow.md: architecture, endpoints and data flow

## Architecture

Two ways to run the same code (D32):

```
LOCAL MODE (default): everything on one laptop
 Phone browser --HTTP--> server.js --> judge.js --> Ollama (Gemma)
                          '-- data.json + temp photos

HUB MODE (deployed link): the hosted copy has no AI
 Phone browser --HTTPS--> hosted server.js (MODE=hub)
                              ^  outgoing HTTPS calls only
 Laptop: worker.js --> judge.js --> Ollama (Gemma)
```

Files: `server.js` (app and API), `judge.js` (all Gemma prompts), `worker.js` (home judge for hub mode), `public/index.html` (whole front end), `public/sw.js` (offline page cache), `public/fonts/` (bundled fonts), `check-gemma.js` and `test-judge.js` (dev tools).

## The sealed-proof lifecycle (D31)

1. **Phone, any time:** photo is shrunk to 512 px and saved in the phone's `queue` (localStorage) with `kind`, `day`, `takenAt` and, for walks, `stopIndex`.
2. **Phone, when a connection exists:** the queue is sent in order to `POST /api/submit` (screen-time items go to `/api/screentime`). A connection error keeps everything and retries later. A server rejection (for example a duplicate photo) drops that item and shows the message.
3. **Server:** stores the photo as a temp file and the proof as `pending`. Sending the same photo twice returns the same id.
4. **Judge** (in-process in local mode, `worker.js` in hub mode): judges oldest `takenAt` first, then calls `applyVerdict`.
5. **Server `applyVerdict`:** sets the result, awards points, saves, and deletes the temp photo (D37).
6. **Phone:** the next `GET /api/groups/:code` shows the result under "Your envelopes". The page also draws from a cached copy of the last plan when offline.

## Endpoints (phone)

| Method | Path | Body / params | Returns |
|--------|------|---------------|---------|
| POST | `/api/groups` | `{name, player}` | `{code, playerId}` |
| POST | `/api/join` | `{code, player}` | `{code, playerId}` |
| GET | `/api/groups/:code` | `?player=<id>&day=YYYY-MM-DD` | the day's plan, leaderboard, feed, judge status and `mine` (see below) |
| POST | `/api/groups/:code/reroll` | `{day}` | `{quest}`. 400 if anyone already sent a photo for the current squad quest. |
| POST | `/api/screentime` | `{playerId, hours, day}` | `{over, limit}` |
| POST | `/api/submit` | `{playerId, kind, day, takenAt, image, stopIndex?}` | `{queued, id}`. `kind` is `squad`, `walk` or `detox`. 400s: duplicate photo, already done, detox without enough screen time, unknown stop. |
| GET | `/api/health` | none | mode and Ollama status |

`mine` holds `squad`, `walk[5]` and `detox` states (`none`, `wait` or `pass`), `screenHours` and the last 8 proofs with status and caption.

## Endpoints (home judge, need header `x-worker-key`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/worker/pending` | up to 20 pending proofs (`id`, `kind`, `text`) and how many bank quests are needed. Also marks the judge as online. |
| GET | `/api/worker/photo/:id` | the temp photo |
| POST | `/api/worker/verdict/:id` | `{match, confidence, outdoors, people, caption}` |
| POST | `/api/worker/bank` | `{squad[], stops[], detox[]}` new quests for the bank |

## Data model (`data.json`)

- `groups[code]`: `{code, name, createdAt, days{ "YYYY-MM-DD": {quest:{id,text}, walk:{id,stops[5]}, detox:{id,text}} }}` (last 7 days kept)
- `players[id]`: `{id, name, group, points, streak, lastDay, done{key:true}, screen{day:hours}}`. Keys in `done` look like `squad:<questId>`, `walk:<walkId>:<k>` and `detox:<detoxId>`.
- `subs[]`: proofs: `{id, group, playerId, player, kind, day, key, refId, text, hash, takenAt, status, match, confidence, caption, points, reason, togetherPaid}`
- `bank`: `{squad[], stops[], detox[]}`, `hashes[]`, `workerSeen`
- `photos/<id>.jpg`: temp files, deleted once judged

## Rules

- **Judging:** squad quests use `judgeSquad` (people visible, activity fits, outdoors). Walk stops and detox use `judgeObject`. A pass needs `match`, confidence of 60 or more and no explicit `outdoors: false` (D27). Squad also needs `people` not false. Thinking is switched off (D26).
- **Squad quest:** 10 + streak bonus (min(streak, 5)). **Together bonus** +10 each when two players' passed photos for the same quest were taken within 90 minutes of each other (D34).
- **Streak:** a passed squad quest on the day after your last one continues it, otherwise it restarts at 1. Older proofs judged late do not change it.
- **Walk:** 4 per stop, +10 when all five passed. Stops are independent (D35).
- **Detox:** 15 points. Needs 3 or more logged screen hours for that day (D20).
- **Quest bank:** `take()` removes a quest from the bank for each new day's plan. Gemma refills the bank when it is low (D33).

## Config (environment variables, all optional)

`MODE` (`local` or `hub`), `PORT` (3000), `DATA_DIR` (where `data.json` and photos live; point it at a persistent disk when hosting), `WORKER_KEY` (required in hub mode), `MODEL` (default `gemma4:e4b-it-q4_K_M`), `OLLAMA_URL`, `SCREEN_LIMIT` (3), `REQUIRE_OUTDOORS` (`0` turns the outdoors check off).
Worker: `HUB_URL` and `WORKER_KEY`.

## Dev tools

- `check-gemma.js <photo>`: one free-form description from Gemma.
- `test-judge.js "<quest>" <passFolder> <failFolder>`: runs the real object judge on two folders and prints accuracy and seconds per photo.

## Known limits

Service workers need HTTPS (or localhost), so offline page caching works on a hosted deployment, not on a plain `http://` laptop address. Together bonus uses phone clocks. A small model cannot count and can be fooled by a photo of a screen. Do-it quests and photo duels are not built yet (D38). Walk distance is not measured.
