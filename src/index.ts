import { env } from "./config/env";
import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import connectDB from "./config/db";
import authRoutes from "./routes/authRoutes";
import leaderboardRoutes from "./routes/leaderboardRoutes";
import { notFound, errorHandler } from "./middleware/errorMiddleware";
import { initSockets } from "./sockets";
import { IO } from "./sockets/events";

const app = express();

app.use(cors({ origin: env.clientOrigins }));
app.use(express.json({ limit: "10kb" }));

app.get("/", (_req, res) => {
    res.json({ message: "Biro Game server is running" });
});

app.use("/api/auth", authRoutes);
app.use("/api/leaderboard", leaderboardRoutes);

app.use(notFound);
app.use(errorHandler);

const server = http.createServer(app);
const io: IO = new Server(server, {
    cors: { origin: env.clientOrigins },
    maxHttpBufferSize: 10_000, // client messages are tiny; reject anything large
});

initSockets(io);

const start = async () => {
    await connectDB();
    server.listen(env.port, () => {
        console.log(`🚀 Server running on http://localhost:${env.port}`);
    });
};

void start();
