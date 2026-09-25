import { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from '../utils/jwt';
import { UnauthorizedError, ForbiddenError } from '../utils/errors';
import { Role } from '../db/schema';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: string; role: Role; email: string };
    }
  }
}

/**
 * Verifies the bearer access token and attaches `req.user`. Multi-tenant
 * boundary enforcement (no IDOR on carts/orders) happens at the resource
 * layer by always scoping queries with `WHERE userId = req.user.id`
 * (see modules/cart and modules/orders), never by trusting a client-supplied
 * user/cart/order id alone.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next(new UnauthorizedError('Missing or malformed Authorization header'));
  }
  const token = header.slice('Bearer '.length);
  try {
    const payload = verifyAccessToken(token);
    if (payload.type !== 'access') {
      return next(new UnauthorizedError('Invalid token type'));
    }
    req.user = { id: payload.sub, role: payload.role, email: payload.email };
    return next();
  } catch {
    return next(new UnauthorizedError('Invalid or expired token'));
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new UnauthorizedError());
    if (!roles.includes(req.user.role)) {
      return next(new ForbiddenError(`Requires role: ${roles.join(' or ')}`));
    }
    return next();
  };
}

/** Optional auth: attaches req.user if a valid token is present, else continues anonymously. */
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return next();
  try {
    const payload = verifyAccessToken(header.slice('Bearer '.length));
    if (payload.type === 'access') {
      req.user = { id: payload.sub, role: payload.role, email: payload.email };
    }
  } catch {
    // ignore invalid token in optional context
  }
  return next();
}
