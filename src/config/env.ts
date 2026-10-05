import "dotenv/config";

const isProduction = process.env.NODE_ENV === "production";

function required(name: string, devFallback: string): string {
    const value = process.env[name];
    if (value) return value;
    if (isProduction) throw new Error(`❌ ${name} is not defined in environment variables.`);
    console.warn(`⚠️  ${name} not set — using a development default. Never do this in production.`);
    return devFallback;
}

export const env = {
    isProduction,
    port: Number(process.env.PORT) || 4000,
    mongoUri: required("MONGO_URI", "mongodb://127.0.0.1:27017/birogame"),
    jwtSecret: required("JWT_SECRET", "dev-only-insecure-secret"),
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
    // How many proxies sit in front of the server (Render: 1). Express needs it to
    // read the player's real IP for rate limiting; 0 = none (local development).
    trustProxy: Number(process.env.TRUST_PROXY ?? (isProduction ? 1 : 0)) || 0,
    // Comma-separated list of allowed frontend origins (REST + socket.io CORS).
    clientOrigins: (process.env.CLIENT_ORIGIN || "http://localhost:3000").split(",").map((o) => o.trim()),
};
