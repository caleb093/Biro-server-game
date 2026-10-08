# Biro Game — Frontend Integration Guide for Online PvP

You are integrating the Biro Game frontend (Next.js + canvas, files like `game.tsx`, `physics.ts`, `archetypes.ts`, `player-setup.tsx`, `challenges.tsx`, `index.tsx`) with a new backend that runs online player-vs-player matches. This document is the complete contract: REST auth, the socket.io protocol, and the changes needed in the game screen.

## 1. The core idea: the server is authoritative

In online matches **the frontend no longer runs physics or decides outcomes**. It:

1. renders the board the server sends,
2. lets the local player aim on their turn, and sends **only the intent** (where they grabbed their pen + the drag vector),
3. plays back the **recorded frames** the server sends for every flick, then snaps to the server's final positions,
4. shows round/match results when the server announces them.

The server validates everything (whose turn it is, that the grab is on your own pen, drag strength caps), simulates the flick with the same physics as the frontend's `physics.ts`, and broadcasts the result to both players.

**Keep the existing "vs Computer" (`ai`) and local hot-seat (`pvp`) modes exactly as they are** — they stay fully client-side. Add a new online mode (e.g. `PenFightMode = "ai" | "pvp" | "online"`).

### Constants that must match the server

The world coordinates are shared. Do not change these on the frontend without changing the server too:

| Constant | Value |
|---|---|
| `WORLD_W` × `WORLD_H` | 1800 × 860 |
| `TABLE_PAD` | 38 → table = `{ x: 38, y: 38, w: 1724, h: 784 }` |
| `FLICK_MAX_DRAG` | 180 (server caps anything larger) |
| Minimum drag | 6 (smaller = tap, rejected) |
| Archetype `length` / `width` / `mass` | same values as `archetypes.ts` (bic, lucky, racer, leo, multi) |
| Initial pens | seat 1 at `(x: 128, y: 430)`, angle `-π/2`; seat 2 at `(x: 1672, y: 430)`, angle `π/2` |

### Game rules (server-enforced; show these in the UI)

| Rule | Value |
|---|---|
| Match | first to **2** round wins, at most **3** rounds (drawn rounds count toward the 3) |
| Setup (pick a biro) | **30 s**; anyone who hasn't picked gets `"bic"` automatically and the match starts |
| Turn | **30 s** to flick; on expiry the turn passes to the opponent |
| AFK | **3** consecutive missed turns = forfeit |
| Round clock | **4 min**; on expiry the round is a draw |
| Between rounds | **3.5 s** intermission |
| Next round | the round's loser starts; after a drawn round, the other player from whoever acted last |
| Disconnect | **30 s** to reconnect, otherwise the opponent wins (both gone = abandoned, no winner) |
| Power-ups | **not supported online** — setup is biro choice only |

Seats are assigned **randomly** by the server. Seat 1 is always the left pen / blue ink (`INK[1]`), seat 2 the right pen / red ink (`INK[2]`). Do not mirror the board for the local player; label players as "YOU" vs the opponent's username using `match.you`.

## 2. Configuration

```
NEXT_PUBLIC_SERVER_URL=http://localhost:4000
```

The server allows CORS from `http://localhost:3000` by default (configurable on the server via `CLIENT_ORIGIN`).

Install the client: `npm i socket.io-client` (v4).

## 3. Auth (REST)

All responses are JSON. Errors are `{ message: string }` with the HTTP status.

| Endpoint | Body | Success | Errors |
|---|---|---|---|
| `POST /api/auth/register` | `{ username, password }` | `201 { token, user }` | `400` invalid input, `409` username taken |
| `POST /api/auth/login` | `{ username, password }` | `200 { token, user }` | `400`, `401` "Invalid username or password" |
| `GET /api/auth/me` | header `Authorization: Bearer <token>` | `200 { user }` | `401` |

```ts
type PublicUser = {
    id: string;
    username: string;
    stats: { played: number; wins: number; losses: number; draws: number };
    createdAt: string;
};
```

- Username: 3–20 characters, letters/digits/underscore. Case-insensitive for login and uniqueness ("Bob" and "bob" are the same account); display the `username` returned by the server.
- Password: 8–128 characters.
- Store the token (e.g. localStorage) and send it as `Authorization: Bearer <token>`. Tokens expire (default 7 days); on a `401` log the user out.
- `user.id` is how players are identified everywhere in the socket protocol (`userId`). Use it to tell "me" from "them".

## 4. Socket connection

Create **one socket per logged-in session at the app level** (e.g. a React context provider), not per page. Every event below goes through it.

```ts
import { io, Socket } from "socket.io-client";

export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(process.env.NEXT_PUBLIC_SERVER_URL!, {
    autoConnect: false,
    auth: { token: "" },
});

export function connectSocket(token: string) {
    socket.auth = { token };
    socket.connect();
}

socket.on("connect_error", (err) => {
    // Auth failures from the server: "MISSING_AUTH_TOKEN" | "INVALID_OR_EXPIRED_TOKEN" | "USER_NOT_FOUND".
    // socket.io does NOT auto-retry these — log out, or set socket.auth and call socket.connect() again.
});
```

- Disconnect the socket on logout.
- Network drops reconnect automatically (socket.io default). After every (re)connect, if the user is in a match the server sends `biro_resume` with a full snapshot. See §7.
- Multiple tabs are fine: every tab receives the match events and any tab can act.

### Clock offset (required for countdowns)

All timestamps from the server (`phaseEndsAt`, `roundEndsAt`, `reconnectBy`, `nextRoundAt`) are **server-clock epoch ms**. Estimate the offset on connect (and occasionally after):

```ts
let clockOffset = 0;
export const serverNow = () => Date.now() + clockOffset;

function syncClock() {
    const t0 = Date.now();
    socket.emit("ping_check", null, (res) => {
        if (!res.success) return;
        const t1 = Date.now();
        clockOffset = res.serverTime - (t0 + t1) / 2;
    });
}
socket.on("connect", syncClock);

// countdown seconds:
const secondsLeft = (deadline: number | null) => (deadline ? Math.max(0, Math.ceil((deadline - serverNow()) / 1000)) : null);
```

### Ack convention

Every client → server event is `socket.emit(event, payload, ack)`. The ack always receives:

```ts
{ success: true, ...data }  |  { success: false, error: "ERROR_CODE" }
```

Never put identity (userId/username) in payloads — the server identifies the caller from the authenticated socket and ignores anything else. Each event is rate-limited to 30 calls per 5 s per socket (`RATE_LIMITED`).

## 5. Protocol types (copy into the frontend, e.g. `lib/biro-protocol.ts`)

```ts
export type Seat = 1 | 2;
export type Vec2 = { x: number; y: number };
export type ArchetypeId = "bic" | "lucky" | "racer" | "leo" | "multi";

export type BiroPhase = "setup" | "aim" | "settling" | "round-over" | "complete";
export type RoundEndReason = "knockout" | "double_knockout" | "time";
export type MatchEndReason = "normal" | "forfeit" | "disconnect" | "afk" | "abandoned";

export type AckResponse<T = {}> = ({ success: true } & T) | { success: false; error: string };
type Ack<T = {}> = (res: AckResponse<T>) => void;

export interface PenView {
    player: Seat;
    archetype: ArchetypeId;
    x: number;
    y: number;
    angle: number;     // radians, continuous (not wrapped)
    length: number;
    width: number;
    offTable: boolean;
}

export interface PlayerView {
    seat: Seat;
    userId: string;
    username: string;
    archetype: ArchetypeId | null; // the opponent's pick is null (hidden) during setup
    ready: boolean;                // has picked a biro
    connected: boolean;
    reconnectBy: number | null;    // server ms deadline while disconnected
}

export interface MatchView {
    id: string;
    phase: BiroPhase;
    you: Seat | null;              // your seat
    players: [PlayerView, PlayerView]; // [seat 1, seat 2]
    round: number;
    maxRounds: number;             // 3
    roundsToWin: number;           // 2
    scores: { p1: number; p2: number };
    turn: Seat;                    // whose flick it is (during "settling": who just flicked)
    phaseEndsAt: number | null;    // setup: pick deadline · aim: turn deadline · settling: playback end · round-over: next round start
    roundEndsAt: number | null;    // round clock deadline
    pens: PenView[];               // empty during setup
}

export interface ChallengeView {
    id: string;
    from: { userId: string; username: string; online: boolean };
    to: { userId: string; username: string };
    archetype: ArchetypeId;        // the challenger's biro, chosen when sending
    message: string;
    createdAt: string;             // ISO
    expiresAt: string;             // ISO (24 h after sending)
    hold: { startsAt: number | null } | null; // accepted while the challenger was mid-match (see §8); startsAt = countdown end, server ms
}

export interface ClientToServerEvents {
    ping_check: (payload: null, ack: Ack<{ serverTime: number }>) => void;

    biro_find_match: (payload: null, ack: Ack<{ searching: boolean; matchId: string | null }>) => void;
    biro_cancel_search: (payload: null, ack: Ack<{ wasSearching: boolean }>) => void;
    biro_get_state: (payload: null, ack: Ack<{ match: MatchView | null; searching: boolean }>) => void;
    biro_submit_setup: (payload: { matchId: string; archetype: ArchetypeId }, ack: Ack) => void;
    biro_flick: (payload: { matchId: string; contact: Vec2; drag: Vec2 }, ack: Ack) => void;
    biro_forfeit: (payload: { matchId: string }, ack: Ack) => void;

    challenge_send: (payload: { username: string; archetype: ArchetypeId; message?: string }, ack: Ack<{ challenge: ChallengeView }>) => void;
    challenge_list: (payload: null, ack: Ack<{ incoming: ChallengeView[]; outgoing: ChallengeView[] }>) => void;
    challenge_accept: (payload: { challengeId: string }, ack: Ack<{ matchId: string | null; waiting?: boolean }>) => void;
    challenge_decline: (payload: { challengeId: string }, ack: Ack) => void;
    challenge_cancel: (payload: { challengeId: string }, ack: Ack) => void;
}

export interface ServerToClientEvents {
    pong_check: (data: { serverTime: number }) => void;

    biro_match_found: (data: { match: MatchView }) => void;
    biro_player_ready: (data: { matchId: string; seat: Seat }) => void;
    biro_round_start: (data: { match: MatchView }) => void;
    biro_flick_resolved: (data: {
        matchId: string;
        seat: Seat;                    // who flicked
        contact: Vec2;                 // where the server applied it (clamped onto the pen)
        drag: Vec2;                    // the drag after the server's 180 cap
        outcome: "none" | RoundEndReason;
        frames: number[][];            // [x1, y1, a1, x2, y2, a2] — seat 1 pen then seat 2 pen
        frameMs: number;               // ≈33.3 (30 fps)
        durationMs: number;            // total playback time incl. knockout reveal
        pens: PenView[];               // final authoritative board
    }) => void;
    biro_turn: (data: { matchId: string; turn: Seat; phaseEndsAt: number; reason: "flick" | "timeout"; missedSeat?: Seat }) => void;
    biro_round_result: (data: {
        matchId: string;
        round: number;
        winnerSeat: Seat | null;       // null = drawn round
        reason: RoundEndReason;
        scores: { p1: number; p2: number };
        nextRoundAt: number | null;    // null = that was the final round (biro_match_completed follows)
    }) => void;
    biro_match_completed: (data: {
        matchId: string;
        winnerSeat: Seat | null;       // null = drawn match
        winner: { userId: string; username: string } | null;
        reason: MatchEndReason;
        scores: { p1: number; p2: number };
    }) => void;
    biro_player_disconnected: (data: { matchId: string; seat: Seat; reconnectBy: number }) => void;
    biro_player_reconnected: (data: { matchId: string; seat: Seat }) => void;
    biro_resume: (data: { match: MatchView }) => void;

    challenge_received: (data: ChallengeView) => void;
    challenge_declined: (data: { challengeId: string; by: string }) => void; // by = username who declined
    challenge_cancelled: (data: { challengeId: string }) => void;
    challenge_hold: (data: { challengeId: string; startsAt: number | null }) => void;  // to both players
    challenge_hold_ended: (data: { challengeId: string; reason: "challenger_offline" | "challengee_offline" | "gone" }) => void;
}
```

## 6. Online flow, screen by screen

Client-side state machine for online play (keep it in the app-level context so routing can react to events from anywhere):

```
idle ──biro_find_match──▶ searching ──biro_match_found──▶ setup ──biro_round_start──▶ playing ──biro_match_completed──▶ finished ──▶ idle
          ▲   biro_cancel_search ◀──┘                                                       (biro_resume can jump straight into setup/playing)
```

Register the match listeners (`biro_match_found`, `biro_resume`, `biro_match_completed`) **globally** in the provider, not only inside the game component. A match can be found while the user is on the menu, or resumed on page load.

### 6.1 Quick match ("Play Online")

1. `socket.emit("biro_find_match", null, ack)`.
   - `{ searching: true }` → show a "Finding an opponent…" screen with a Cancel button.
   - If an opponent was already waiting you're paired immediately. **`biro_match_found` arrives before the ack** in that case, so drive the UI from the event, not the ack.
   - `ALREADY_IN_MATCH` → call `biro_get_state` and route into that match.
2. Cancel → `biro_cancel_search`. The server also removes you from the queue if you go offline.
3. On `biro_match_found` → store `match.id`, go to setup.

### 6.2 Setup screen (reuse `player-setup.tsx`)

- Show **one** `PlayerSetup` for the local player only (`player = match.you`, so the ink colour matches their seat). The local `pvp` flow's "P1 then P2" doesn't apply.
- Show the countdown from `match.phaseEndsAt` and the opponent's username/ready state (`players[...]`). The opponent's `archetype` is `null` until the round starts.
- Confirm → `biro_submit_setup { matchId, archetype }` (no loadout). Then show "Waiting for <opponent>…".
  - Errors: `INVALID_ARCHETYPE`, `NOT_IN_SETUP` (setup already over), `ALREADY_READY`, `MATCH_NOT_FOUND`, `NOT_IN_MATCH`.
- `biro_player_ready { seat }` → mark that player ready.
- `biro_round_start` → go to the game screen. **It can arrive while the user is still picking** (setup timer expired, server assigned `"bic"`). Leave the setup screen in that case.
- For a match from an accepted challenge, the challenger is already `ready: true` with their biro set.

### 6.3 Game screen (`game.tsx` in online mode)

Pass the online context into the component, e.g. `<PenFightGame mode="online" initialMatch={match} ... />`. In online mode:

**Do not run physics.** Skip the `stepPen` / `collidePens` / knockout-detection / `pendingRef` / `concludeRound` / `concludeDraw` / `placePensForRound` / AI logic entirely. Keep the render loop (`requestAnimationFrame`), because it now draws the board and runs playback.

**Building pens from the server.** Whenever you receive a `MatchView` (`biro_round_start`, `biro_resume`) or final pens (`biro_flick_resolved.pens`), rebuild `pensRef.current`:

```ts
function pensFromView(views: PenView[]): Pen[] {
    return views.map((v) => {
        const def = ARCHETYPE_MAP[v.archetype];
        const pen = createPen({ x: v.x, y: v.y }, v.angle, INK[v.player], def.accent, v.player, v.length, v.width, def.mass, v.archetype);
        pen.offTable = v.offTable;
        return pen;
    });
}
```

**State to hold** (refs for the hot path, React state for the HUD): `matchId`, `you`, `players`, `phase`, `turn`, `round`, `scores`, `phaseEndsAt`, `roundEndsAt`, plus a `playbackRef` and a `flickInFlightRef`.

**Input (aiming).** Keep the existing pointer handlers, but only allow `pointerdown` when `phase === "aim" && turn === you && !flickInFlightRef.current`. On `pointerup`, after the existing `dragMag < 6` check, send the flick instead of calling `performFlick`:

```ts
const contact = dragLocalContactRef.current!;           // already clampToPenBody(me, pointerDownWorld)
const drag = { x: end.x - start.x, y: end.y - start.y }; // raw drag in world units (end − start); the server reverses it (slingshot)
flickInFlightRef.current = true;
socket.emit("biro_flick", { matchId, contact, drag }, (res) => {
    if (!res.success) {
        flickInFlightRef.current = false;   // e.g. NOT_YOUR_TURN, GRAB_OFF_PEN, FLICK_TOO_SMALL, NOT_AIMING
        // optional: toast; resync with biro_get_state if the error suggests stale state
    }
});
// do NOT apply anything locally; wait for biro_flick_resolved (it arrives before the ack)
```

Send the drag exactly as `end − start`. Don't negate it, normalise it or cap it yourself; the server does all of that. The opponent does not see your aim line, only the result.

**Playback (`biro_flick_resolved`).** Both players (including the flicker) play the server's frames:

```ts
socket.on("biro_flick_resolved", (d) => {
    flickInFlightRef.current = false;
    playSfx?.("beamInteraction");
    setPhase("settling"); phaseRef.current = "settling";
    playbackRef.current = { frames: d.frames, frameMs: d.frameMs, durationMs: d.durationMs, startedAt: performance.now(), finalPens: d.pens };
});

// inside the rAF loop, before render():
const TABLE = { x: 38, y: 38, w: 1724, h: 784 };
function advancePlayback(now: number) {
    const pb = playbackRef.current;
    if (!pb) return;
    const elapsed = now - pb.startedAt;
    const f = elapsed / pb.frameMs;
    const last = pb.frames.length - 1;
    const i = Math.min(Math.floor(f), last);
    const j = Math.min(i + 1, last);
    const k = i === j ? 0 : f - i;
    const A = pb.frames[i], B = pb.frames[j];
    for (const p of pensRef.current) {
        const o = p.player === 1 ? 0 : 3;
        p.pos.x = A[o] + (B[o] - A[o]) * k;
        p.pos.y = A[o + 1] + (B[o + 1] - A[o + 1]) * k;
        p.angle = A[o + 2] + (B[o + 2] - A[o + 2]) * k; // angles are continuous, plain lerp is fine
        p.vel.x = p.vel.y = 0; p.omega = 0;
        // Same rule as the server: knocked out once the centre crosses the table edge (sticky).
        if (!p.offTable && (p.pos.x < TABLE.x || p.pos.x > TABLE.x + TABLE.w || p.pos.y < TABLE.y || p.pos.y > TABLE.y + TABLE.h)) p.offTable = true;
    }
    if (elapsed >= pb.durationMs) {
        pensRef.current = pensFromView(pb.finalPens); // snap to the authoritative result
        playbackRef.current = null;
    }
}
```

- `frames[i]` is the pose at `i × frameMs` after the flick. `frames[0]` is the starting pose.
- `durationMs` can be longer than the frames, because a pen left teetering on the edge is shown for an extra 0.9 s. Hold the last frame until `durationMs`, then snap.
- The existing render code (knockout ring on `offTable` pens, active-pen dot) keeps working on these pens.

**Turns and rounds.** All of these are server-driven:

| Event | What to do |
|---|---|
| `biro_turn` | `turn = d.turn`, `phase = "aim"`, `phaseEndsAt = d.phaseEndsAt`. If `reason === "timeout"`, briefly show "<player> ran out of time". |
| `biro_round_result` | Update `scores`, `phase = "round-over"`, show the round overlay: `reason "knockout"` → "Round Won" for `winnerSeat`; `"double_knockout"` → "Double Knockout · Draw"; `"time"` → "Time up · Draw". It arrives after the playback finishes. |
| `biro_round_start` | Clear playback; rebuild pens from `match.pens`; set `round`, `turn`, `scores`, `phase = "aim"`, `phaseEndsAt`, `roundEndsAt`; hide the round overlay. |
| `biro_match_completed` | `phase = "match-over"`; show the winner overlay. Copy by `reason`: `normal`; `forfeit` ("<loser> left the match"); `disconnect` ("<loser> disconnected"); `afk` ("<loser> was idle for 3 turns"); `abandoned` (no winner). Can arrive at any time, even mid-playback or during setup. |

`biro_round_result` with `nextRoundAt: null` means `biro_match_completed` comes right after.

**HUD.**
- Scoreboard: `scores.p1` is seat 1 (left/blue), `scores.p2` seat 2. Labels: `"YOU"` for `you`, opponent's `username` otherwise.
- Turn label: on your turn "Your flick · 23s"; otherwise "<opponent> is aiming… · 23s" (from `phaseEndsAt`).
- Round clock from `roundEndsAt` (small, e.g. "Round 1 · 3:41").
- Remove the power-up rails and freeze/shield UI in online mode.

**Buttons.**
- Exit (mid-match) → confirm "Leaving forfeits the match", then `biro_forfeit { matchId }`, then leave when `biro_match_completed` arrives.
- Match-over "Play Again" → `biro_find_match` (there is no rematch; this queues for a new opponent). "Main Menu" → idle.

**Opponent connection.**
- `biro_player_disconnected { seat, reconnectBy }` → banner "<opponent> disconnected — waiting 0:30" (count down to `reconnectBy`). The game keeps going; their turns time out normally.
- `biro_player_reconnected` → hide the banner.

## 7. Reconnect / page reload / resume

- On every socket connection, if the user is in a match, the server sends `biro_resume { match }`. Route to the right screen from `match.phase`: `setup` → setup screen; `aim`, `settling` or `round-over` → game screen, built from the snapshot. During `settling`, `pens` are already the final positions; just draw them and wait for the next event.
- When the game page mounts (e.g. navigating back while the socket stayed connected), call `biro_get_state` to sync. `{ match: null }` means no active match; `searching: true` means still in the queue.
- Treat any `MatchView` as the full truth: replace local state with it.

## 8. Challenges (`challenges.tsx` + a new "send challenge" UI)

Challenges are stored on the server (they survive being offline) and expire after 24 h.

**Sending** (new UI needed: opponent username input, biro picker, optional message):

```ts
socket.emit("challenge_send", { username, archetype, message }, (res) => { /* res.challenge */ });
```

- The challenger picks their biro **now**. When accepted, they skip setup.
- `message` is optional, up to 140 characters (trimmed).
- Errors: `USER_NOT_FOUND`, `CANNOT_CHALLENGE_SELF`, `CHALLENGE_ALREADY_PENDING` (one pending challenge per pair), `TOO_MANY_CHALLENGES` (max 10 outgoing), `MESSAGE_TOO_LONG`, `INVALID_ARCHETYPE`.

**Listing.** Replace `DUMMY_CHALLENGES` with `challenge_list`. Fetch when the modal opens, and keep the list in sync with the live events below. Map to the existing `Challenge` shape:

```ts
const toChallenge = (c: ChallengeView): Challenge & { online: boolean } => ({
    id: c.id,
    from: c.from.username,
    biro: c.archetype,
    message: c.message,
    sentAgo: timeAgo(c.createdAt), // e.g. "5 min ago"
    online: c.from.online,
});
```

`outgoing` (challenges you sent) can be shown with a Cancel button → `challenge_cancel { challengeId }`.

**Accept / reject.**
- Accept → `challenge_accept { challengeId }` → `{ matchId }`, and `biro_match_found` arrives for both players → setup screen (the challenger is already ready).
  - `CHALLENGER_OFFLINE` → "<name> isn't online right now". The challenge stays, so they can try later. Consider disabling Accept when `online` is false.
  - `CHALLENGER_BUSY` → someone else is already waiting on them (see below). `ALREADY_IN_MATCH` → you are in a match. `ALREADY_WAITING` → you're already waiting on a held challenge. `CHALLENGE_NOT_FOUND` → expired or cancelled: remove it from the list.
- Reject → `challenge_decline { challengeId }`.

**Held accepts (challenger mid-match).** Accepting while the challenger is in another match doesn't fail. It **holds**:
- The ack is `{ matchId: null, waiting: true }`, and `challenge_hold { challengeId, startsAt: null }` goes to both players. The challenge stays in the lists with `hold` set. Show the challengee a blocking "please hold" screen with a Decline button.
- While holding, both players are reserved: `biro_find_match` → `WAITING_FOR_CHALLENGE`, other accepts → `ALREADY_WAITING`, and a second accept of the same challenger's challenges → `CHALLENGER_BUSY`. Only one player can wait per challenger.
- The challengee can back out with `challenge_decline`. It works like a normal decline: the challenge is deleted and the challenger gets `challenge_declined` (best shown after their match).
- When the challenger's match ends, `challenge_hold { challengeId, startsAt }` goes to both: show a countdown to `startsAt` (server clock). Declining now → `CHALLENGE_STARTING`. At `startsAt` the server starts the match and `biro_match_found` arrives for both, with the challenger already ready.
- `challenge_hold_ended { challengeId, reason }` → the hold fell through (someone went offline, or the challenge is `gone`). Clear `hold`; the challenge is pending again, unless the reason is `gone`.
- Holds live in server memory: after a server restart `challenge_list` returns `hold: null` and the challenge is plain pending again.

**Live events** (listen globally to drive a badge on the Challenges button):
- `challenge_received` → add to incoming + badge/toast.
- `challenge_cancelled { challengeId }` → remove from incoming.
- `challenge_declined { challengeId, by }` → remove from outgoing + toast "<by> declined your challenge".

## 9. Error codes (ack `error` values)

| Code | Meaning |
|---|---|
| `MATCH_ID_REQUIRED`, `INVALID_FLICK`, `INVALID_ARCHETYPE`, `INVALID_CHALLENGE_ID`, `USERNAME_REQUIRED`, `INVALID_MESSAGE` | malformed payload (a frontend bug) |
| `MATCH_NOT_FOUND`, `NOT_IN_MATCH` | stale match id: resync with `biro_get_state` |
| `ALREADY_IN_MATCH` | already playing: resync and route into that match |
| `NOT_IN_SETUP`, `ALREADY_READY` | setup already submitted/over |
| `NOT_AIMING`, `NOT_YOUR_TURN` | flick at the wrong time (e.g. during playback): ignore, local state will catch up |
| `GRAB_OFF_PEN` | grab point wasn't on your own pen |
| `FLICK_TOO_SMALL` | drag < 6 world units |
| `NO_BOARD` | no pens yet |
| `USER_NOT_FOUND`, `CANNOT_CHALLENGE_SELF`, `CHALLENGE_ALREADY_PENDING`, `TOO_MANY_CHALLENGES`, `MESSAGE_TOO_LONG` | challenge send |
| `CHALLENGE_NOT_FOUND`, `CHALLENGER_OFFLINE`, `CHALLENGER_BUSY`, `ALREADY_WAITING`, `CHALLENGE_STARTING` | challenge accept/decline/cancel |
| `WAITING_FOR_CHALLENGE` | `biro_find_match` while waiting on a held challenge |
| `RATE_LIMITED` | more than 30 calls of one event in 5 s |
| `INTERNAL_ERROR` | server bug: show a generic error |

## 10. Leaderboard (REST — wire up the 🏆 Leaderboard button)

Ranked by **wins** (online PvP only). Players with equal wins **share a rank** (1, 2, 2, 4), and within a tie fewer losses are listed first. Only players with at least one win appear.

| Endpoint | Auth | Response |
|---|---|---|
| `GET /api/leaderboard?limit=50&offset=0` | none (public) | `LeaderboardPage` |
| `GET /api/leaderboard/me` | `Bearer` token | `MyStanding` — your rank even if you're not on the page shown |

```ts
interface LeaderboardEntry {
    rank: number;
    userId: string;
    username: string;
    wins: number;
    losses: number;
    draws: number;
    played: number;
}
interface LeaderboardPage {
    entries: LeaderboardEntry[];
    total: number;        // players on the board
    limit: number;
    offset: number;
    generatedAt: string;  // ISO time the data was read
}
interface MyStanding {
    userId: string;
    username: string;
    rank: number | null;  // null = no wins yet (not on the board)
    total: number;
    wins: number;
    losses: number;
    draws: number;
    played: number;
}
```

- `limit` must be 1–100 (default 50) and `offset` 0–10000 (default 0); anything else → `400`.
- Paginate with `offset += limit` while `offset < total`. Highlight the row whose `userId` is the logged-in user. If they're not on the current page, show the `/me` standing pinned at the bottom ("You · #37 · 12 wins"), or "Win a match to get ranked" when `rank` is `null`.
- Win rate, if you want it, is `wins / played`, computed on the client.
- The data is cached briefly on the server: a finished match shows up within about 2 seconds, otherwise pages refresh every 30 seconds. Refetch when the modal opens; there is no socket push for the leaderboard.

## 11. Not available yet (don't build UI that depends on these)

- Power-ups in online matches.
- Rematch with the same opponent ("Play Again" just re-queues).
- Spectating, or seeing the opponent's aim line before they flick.

## 12. Done checklist

- [ ] Register/login screens; token persisted; socket connects with the token; logout disconnects it.
- [ ] Clock offset via `ping_check`; every countdown uses `serverNow()`.
- [ ] Quick match: search + cancel; `biro_match_found` routes to setup from anywhere in the app.
- [ ] Setup: single picker for `match.you`, countdown, waiting state, auto-advance on `biro_round_start`.
- [ ] Game (online): no local physics; input only on your turn; `biro_flick` sends `contact` + raw `drag`; frame playback with interpolation, then snap to `pens`.
- [ ] Server events drive turns, round overlays, match-over overlay (all end reasons), opponent disconnect banner.
- [ ] Exit = forfeit with confirmation; Play Again re-queues.
- [ ] Reload mid-match restores the game via `biro_resume` / `biro_get_state`.
- [ ] Challenges: send UI, live list from `challenge_list`, accept/reject/cancel, live events + badge.
- [ ] Leaderboard modal: paginated `GET /api/leaderboard`, own row highlighted, `/me` standing pinned.
- [ ] `ai` and local `pvp` modes still work unchanged.
