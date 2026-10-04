import { IO, GameSocket, userRoom } from "./events";
import { registerBiroHandlers } from "./biro.socket";
import { registerChallengeHandlers } from "./challenge.socket";
import { on, ok } from "./handler";
import { verifyToken } from "../utils/auth";
import User from "../models/userSchema";
import { addSocket, removeSocket } from "../managers/presence";
import { matchManager } from "../managers/matchManager";
import { matchmaker } from "../managers/matchmaker";

export const initSockets = (io: IO) => {
    matchManager.init(io);

    // Authenticate every connection with the same JWT the REST API issues:
    //   io(URL, { auth: { token } })
    io.use(async (socket, next) => {
        try {
            const token = socket.handshake.auth?.token;
            if (typeof token !== "string" || !token) return next(new Error("MISSING_AUTH_TOKEN"));

            const { id } = verifyToken(token);
            const user = await User.findById(id).select("username").lean();
            if (!user) return next(new Error("USER_NOT_FOUND"));

            socket.data.user = { id: user._id.toString(), username: user.username };
            next();
        } catch {
            next(new Error("INVALID_OR_EXPIRED_TOKEN"));
        }
    });

    io.on("connection", (socket: GameSocket) => {
        const { id: userId, username } = socket.data.user;

        // Every socket of a user joins their personal room — that's how we reach
        // a user regardless of how many tabs/sockets they have open.
        socket.join(userRoom(userId));
        const cameOnline = addSocket(userId, socket.id);
        if (cameOnline) console.log(`🔌 ${username} online`);

        // Back into a live match? Rejoin its room and get a snapshot (biro_resume).
        matchManager.handleConnect(socket, userId);

        // Server timestamps (phaseEndsAt etc.) are server-clock epoch ms; clients
        // use serverTime from this to correct for their own clock offset.
        on(socket, "ping_check", () => {
            const serverTime = Date.now();
            socket.emit("pong_check", { serverTime });
            return ok({ serverTime });
        });
        registerBiroHandlers(socket);
        registerChallengeHandlers(io, socket);

        socket.on("disconnect", () => {
            const wentOffline = removeSocket(userId, socket.id);
            if (!wentOffline) return; // another tab/socket is still connected

            console.log(`❌ ${username} offline`);
            matchmaker.leave(userId);
            matchManager.handleDisconnect(userId);
        });
    });
};
