# flow.md: architecture, endpoints and data flow

## Architecture

```
 Phone browser (public/index.html)
        |  HTTP + JSON over local Wi-Fi / hotspot
        v
 Laptop: Node + Express (server.js, port 3000)
        |-- data.json  (groups, players, submissions, photo hashes)
        '-- HTTP to Ollama (localhost:11434)
                 '-- gemma4:e4b-it-q4_K_M  (quests + photo judging)
```

Nothing leaves the laptop. No cloud calls.

## Endpoints

| Method | Path | Body / params | Returns | Notes |
|--------|------|---------------|---------|-------|
| POST | `/api/groups` | `{name, player}` | `{code, playerId}` | Creates group with a 5-char code and the first player. |
| POST | `/api/join` | `{code, player}` | `{code, playerId}` | 404 if code unknown. |
| GET | `/api/groups/:code` | optional `?player=<id>` | `{name, code, quest:{text}, players[], walkTotal, feed[], mine}` | Creates today's quest on first call (Gemma, with fallback). Phones poll this every 6 s. |
| POST | `/api/groups/:code/reroll` | none | `{quest}` | Replaces today's quest with a new one. 400 if anyone in the group already completed the current quest. |
| POST | `/api/screentime` | `{playerId, hours}` | `{over, limit}` | Saves today's self-reported hours. If `hours >= limit`, creates the player's detox quest (once per day). |
| POST | `/api/submit` | `{playerId, image, kind}` (base64 JPEG, no prefix; `kind` is `quest` by default, `detox` or `walk`) | `{match, confidence, caption, points, message}` | Sends photo to Gemma. Errors: 400 duplicate or already done, 502 judge unavailable. |
| GET | `/api/health` | none | `{server, ollama, model}` | Quick check that Ollama is reachable. |

## Data model (data.json)

- `groups[code]`: `{code, name, quest:{id,text,day}, past[], walk:{id,day,stops[]}, createdAt}`
- `players[id]`: `{id, name, group, points, streak, lastDay, doneQuest, screenHours, screenDay, detox:{id,text,day,done}, walk:{id,done}}`
- `subs[]`: `{group, player, day, match, confidence, caption, points, at}` (last 300 kept)
- `hashes[]`: SHA-1 of every passed photo, used to reject reuse

## Flows

**Daily quest rules:** one verifiable thing, no counting or numbers (D18). Generated text with digits or number words is discarded for a fallback. The "Swap quest" button calls the reroll endpoint (D19).

**Daily quest:** first `GET /api/groups/:code` of the day, then Gemma is asked for one verifiable quest as JSON, then it is saved on the group. If Gemma fails or the answer is invalid, a fallback quest is used. Requests that arrive at the same moment share one generation.

**Submit a photo:** phone shrinks photo to 512 px, sends `/api/submit`, server checks player, already-done and duplicate hash, then asks Gemma (temperature 0.2) to list what it sees and decide, returning `{seen[], match, confidence, outdoors, caption}`. `seen` is not used; the other fields are. Thinking is switched off in the request (D26). A pass needs match, confidence of 60 or more and, unless `REQUIRE_OUTDOORS=0`, no explicit `outdoors: false` (D27); an indoor photo gets a specific "take it outside" message. On a pass the server updates streak and points, stores the hash, and logs to `subs`. Failed attempts are logged but not scored and can be retried.

**Streak:** a pass on the day after the previous pass continues the streak, otherwise it restarts at 1. The leaderboard shows 0 if the player missed yesterday and today.

**Scoring:** 10 + 5 if first in group today + min(streak, 5). A detox quest is a flat 15 and leaves streak and the first bonus alone. Each walk stop is 4 points, plus 10 for finishing all five (maximum 30 a day).

**Walk challenge:** the first `GET /api/groups/:code` of the day also asks Gemma for 5 simple targets, validated with the D18 rules and topped up from a built-in pool if needed. `mine.walk` shows only the player's current stop (`done` of `total`). A photo sent with `kind: "walk"` is judged against that stop. A pass moves the player to the next stop, and the fifth pass adds the completion bonus. The leaderboard shows each player's progress.

**Screen-time nudge:** the player types today's hours (`POST /api/screentime`). At or above `SCREEN_LIMIT` the server asks Gemma for a detox quest (same rules as D18, fallback list if unusable). `GET /api/groups/:code?player=<id>` returns it under `mine`. The photo is submitted with `kind: "detox"` and judged like any other.

## Config (environment variables, all optional)

`MODEL` (default `gemma4:e4b-it-q4_K_M`), `OLLAMA_URL` (default `http://localhost:11434`), `PORT` (default 3000), `SCREEN_LIMIT` (default 3 hours), `REQUIRE_OUTDOORS` (on by default; set to `0` to turn off).

## Dev tools

- `check-gemma.js <photo>`: sends one photo to Gemma and prints a free-form description. Sanity check only, not the real judge.
- `test-judge.js "<quest>" <passFolder> <failFolder>`: runs the judge prompt on two folders of photos and prints how many were judged correctly.

## Known limits

Gemma can be fooled by a photo of a screen. Small models can invent details in captions, so the judge prompt tells it to name only visible things.

Same-network only. No login (a player id lives in the browser's localStorage). Weekly recap and the Mastra agent are not built yet. Walk distance is not verified (D11), so stop numbers are an honor system. Screen time is self-reported. The failed-photo response omits the confidence number (see D16).
