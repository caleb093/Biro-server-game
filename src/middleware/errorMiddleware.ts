import { Request, Response, NextFunction } from "express";
import { env } from "../config/env";

export const notFound = (req: Request, res: Response) => {
    res.status(404).json({ message: `Not Found - ${req.originalUrl}` });
};

// Express 5 forwards rejected promises from async handlers here automatically.
export const errorHandler = (err: any, _req: Request, res: Response, _next: NextFunction) => {
    // Malformed JSON body from express.json()
    if (err?.type === "entity.parse.failed") {
        res.status(400).json({ message: "Invalid JSON body" });
        return;
    }

    const statusCode = res.statusCode >= 400 ? res.statusCode : 500;
    if (statusCode >= 500) console.error(err);
    res.status(statusCode).json({
        message: statusCode >= 500 && env.isProduction ? "Internal server error" : err?.message,
        stack: env.isProduction ? undefined : err?.stack,
    });
};
