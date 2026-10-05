import User, { IUserStats, LEADERBOARD_SORT } from "../models/userSchema";

// Leaderboard ranked by wins.
//
// Speed: wins are counters on the user document (updated when a match result
// is recorded), and the board is read through a partial index, so a page is
// an index walk, not an aggregation over match history. The hot top pages are
// additionally served from a small in-memory cache.
//
// Ranking is "competition" style: players with equal wins share a rank
// (1, 2, 2, 4). Within a tie, fewer losses are listed first.

export interface LeaderboardEntry {
    rank: number;
    userId: string;
    username: string;
    wins: number;
    losses: number;
    draws: number;
    played: number;
}

export interface LeaderboardPage {
    entries: LeaderboardEntry[];
    total: number;        // players on the board (≥ 1 win)
    limit: number;
    offset: number;
    generatedAt: string;  // when this page was read from the database
}

const ON_BOARD = { "stats.wins": { $gt: 0 } };

// Number of players strictly ahead on wins. Uses the leaderboard index
// (wins > n with n ≥ 0 implies the index's wins > 0 filter).
const countAhead = (wins: number) => User.countDocuments({ "stats.wins": { $gt: Math.max(0, wins) } });

async function fetchPage(limit: number, offset: number): Promise<LeaderboardPage> {
    const [users, total] = await Promise.all([
        User.find(ON_BOARD).sort(LEADERBOARD_SORT).skip(offset).limit(limit).select("username stats").lean(),
        User.countDocuments(ON_BOARD),
    ]);

    const entries: LeaderboardEntry[] = [];
    if (users.length > 0) {
        // The first row may tie with rows on the previous page, so its rank
        // comes from a count; after that, a change in wins means everyone
        // listed before is strictly ahead → rank = position.
        let rank = offset === 0 ? 1 : 1 + (await countAhead(users[0].stats.wins));
        users.forEach((u, i) => {
            if (i > 0 && u.stats.wins !== users[i - 1].stats.wins) rank = offset + i + 1;
            entries.push({ rank, userId: u._id.toString(), username: u.username, ...pickStats(u.stats) });
        });
    }

    return { entries, total, limit, offset, generatedAt: new Date().toISOString() };
}

const pickStats = (s: IUserStats) => ({ wins: s.wins, losses: s.losses, draws: s.draws, played: s.played });

// ── Cache ───────────────────────────────────────────────────────────────────
// Pages near the top are what everyone opens, so they are cached briefly.
//   • No new results since the read → valid for FRESH_MS.
//   • A result was recorded since     → valid for only AFTER_CHANGE_MS, so a
//     player sees their win within a couple of seconds, while a burst of
//     finishing matches still costs at most one read per page per window.
// Concurrent requests for the same page share one in-flight query, and if a
// refresh fails (database blip) the previous page is served instead of an error.

const FRESH_MS = 30_000;
const AFTER_CHANGE_MS = 2_000;
const CACHE_MAX_DEPTH = 200;   // only pages within the top 200 are cached
const CACHE_MAX_ENTRIES = 50;  // bound memory against odd limit/offset combinations

let resultsVersion = 0;
const cache = new Map<string, { page: Promise<LeaderboardPage>; fetchedAt: number; version: number }>();

/** Call after stats change (a match result was recorded). */
export function invalidateLeaderboard() {
    resultsVersion++;
}

export function getLeaderboardPage(limit: number, offset: number): Promise<LeaderboardPage> {
    if (offset + limit > CACHE_MAX_DEPTH) return fetchPage(limit, offset);

    const key = `${limit}:${offset}`;
    const now = Date.now();
    const previous = cache.get(key);
    if (previous) {
        const maxAge = previous.version === resultsVersion ? FRESH_MS : AFTER_CHANGE_MS;
        if (now - previous.fetchedAt < maxAge) return previous.page;
    }

    const entry = {
        page: fetchPage(limit, offset).catch((err) => {
            if (previous) {
                console.warn("[leaderboard] refresh failed, serving the previous page:", err?.message);
                return previous.page;
            }
            throw err;
        }),
        fetchedAt: now,
        version: resultsVersion,
    };

    cache.delete(key); // re-insert so Map order = least recently refreshed first
    cache.set(key, entry);
    if (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!);
    // Never keep a failed read around.
    entry.page.catch(() => {
        if (cache.get(key) === entry) cache.delete(key);
    });

    return entry.page;
}

// ── A single player's position ──────────────────────────────────────────────

export async function getPlayerStanding(stats: IUserStats): Promise<{ rank: number | null; total: number } & ReturnType<typeof pickStats>> {
    const [total, ahead] = await Promise.all([
        User.countDocuments(ON_BOARD),
        stats.wins > 0 ? countAhead(stats.wins) : Promise.resolve(null),
    ]);
    return { rank: ahead === null ? null : ahead + 1, total, ...pickStats(stats) };
}
