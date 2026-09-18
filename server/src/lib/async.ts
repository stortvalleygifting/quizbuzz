import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Express 4 doesn't forward rejected promises, so wrap async handlers. */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };
