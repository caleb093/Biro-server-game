// Who is online, in memory. A user counts as online while they have at least
// one connected socket — so several tabs, or a transport upgrade / reconnect
// that briefly overlaps old and new sockets, never make a live player look
// offline. (This replaces the old walletToSocket map + socketId comparisons.)
//
// To reach a user, emit to their room (userRoom in sockets/events.ts); every one
// of their sockets joins it on connect.

const socketsByUser = new Map<string, Set<string>>();

/** Returns true if this socket brought the user online (first connection). */
export function addSocket(userId: string, socketId: string): boolean {
    let set = socketsByUser.get(userId);
    const cameOnline = !set;
    if (!set) {
        set = new Set();
        socketsByUser.set(userId, set);
    }
    set.add(socketId);
    return cameOnline;
}

/** Returns true if this was the user's last socket (they are now offline). */
export function removeSocket(userId: string, socketId: string): boolean {
    const set = socketsByUser.get(userId);
    if (!set) return false;
    set.delete(socketId);
    if (set.size > 0) return false;
    socketsByUser.delete(userId);
    return true;
}

export function isOnline(userId: string): boolean {
    return socketsByUser.has(userId);
}
