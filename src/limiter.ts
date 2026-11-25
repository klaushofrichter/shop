/** The shop's rate limiters: per client address, standard headers only. */
import { rateLimit, type RateLimitRequestHandler } from 'express-rate-limit';

export const perClient = (windowMs: number, limit: number): RateLimitRequestHandler =>
  rateLimit({ windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false });
