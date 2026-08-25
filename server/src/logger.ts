import type { NextFunction, Request, Response } from "express";

/**
 * Minimal request logging middleware. Logs method, path, status code, and
 * duration in milliseconds to stdout once the response finishes.
 *
 * No external logging library — this is deliberately lightweight per the
 * scaffolding scope of this issue.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    console.log(
      `${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs.toFixed(1)}ms`,
    );
  });

  next();
}
