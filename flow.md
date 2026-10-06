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
| GET | `/api/groups/:code` | none | `{name, code, quest:{text}, players[], feed[]}` | Creates today's quest on first call (Gemma, with fallback). Phones poll this every 6 s. |
| POST | `/api/submit` | `{playerId, image}` (base64 JPEG, no prefix) | `{match, confidence, caption, points, message}` | Sends photo to Gemma. Errors: 400 duplicate or already done, 502 judge unavailable. |
| GET | `/api/health` | none | `{server, ollama, model}` | Quick check that Ollama is reachable. |

## Data model (data.json)

- `groups[code]`: `{code, name, quest:{id,text,day}, past[], createdAt}`
- `players[id]`: `{id, name, group, points, streak, lastDay, doneQuest}`
- `subs[]`: `{group, player, day, match, confidence, caption, points, at}` (last 300 kept)
- `hashes[]`: SHA-1 of every passed photo, used to reject reuse

## Flows

**Daily quest:** first `GET /api/groups/:code` of the day, then Gemma is asked for one verifiable quest as JSON, then it is saved on the group. If Gemma fails or the answer is invalid, a fallback quest is used. Requests that arrive at the same moment share one generation.

**Submit a photo:** phone shrinks photo to 640 px, sends `/api/submit`, server checks player, already-done and duplicate hash, then asks Gemma for `{match, confidence, caption}`. A pass needs match and confidence of 60 or more. On a pass the server updates streak and points, stores the hash, and logs to `subs`. Failed attempts are logged but not scored and can be retried.

**Streak:** a pass on the day after the previous pass continues the streak, otherwise it restarts at 1. The leaderboard shows 0 if the player missed yesterday and today.

**Scoring:** 10 + 5 if first in group today + min(streak, 5).

## Config (environment variables, all optional)

`MODEL` (default `gemma4:e4b-it-q4_K_M`), `OLLAMA_URL` (default `http://localhost:11434`), `PORT` (default 3000).

## Known limits

Same-network only. No login (a player id lives in the browser's localStorage). Screen-time quests, weekly recap and the Mastra agent are not built yet.
