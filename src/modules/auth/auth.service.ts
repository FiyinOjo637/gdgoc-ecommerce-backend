import { eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { users, carts } from '../../db/schema';
import { hashPassword, verifyPassword } from '../../utils/password';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../../utils/jwt';
import { newId, nowIso } from '../../utils/id';
import { ConflictError, UnauthorizedError } from '../../utils/errors';
import { LoginInput, RegisterInput } from './auth.schema';

function toPublicUser(u: typeof users.$inferSelect) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, createdAt: u.createdAt };
}

export async function register(input: RegisterInput) {
  const existing = db.select().from(users).where(eq(users.email, input.email)).get();
  if (existing) {
    throw new ConflictError('An account with this email already exists');
  }

  const passwordHash = await hashPassword(input.password);
  const now = nowIso();
  const userId = newId();

  // Public registration never grants ADMIN — that role is only assignable
  // via the seed script or by an existing admin (see users.routes RBAC).
  const role = 'CUSTOMER' as const;

  db.transaction((tx) => {
    tx.insert(users)
      .values({
        id: userId,
        name: input.name,
        email: input.email,
        passwordHash,
        role,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    // Every customer gets exactly one cart, created eagerly so cart
    // endpoints never have to special-case "cart doesn't exist yet".
    tx.insert(carts)
      .values({ id: newId(), userId, createdAt: now, updatedAt: now })
      .run();
  });

  const user = db.select().from(users).where(eq(users.id, userId)).get()!;
  return issueTokens(user);
}

export async function login(input: LoginInput) {
  const user = db.select().from(users).where(eq(users.email, input.email)).get();
  if (!user) throw new UnauthorizedError('Invalid email or password');

  const valid = await verifyPassword(input.password, user.passwordHash);
  if (!valid) throw new UnauthorizedError('Invalid email or password');

  return issueTokens(user);
}

export function refresh(refreshToken: string) {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw new UnauthorizedError('Invalid or expired refresh token');
  }
  const user = db.select().from(users).where(eq(users.id, payload.sub)).get();
  if (!user) throw new UnauthorizedError('User no longer exists');
  return issueTokens(user);
}

function issueTokens(user: typeof users.$inferSelect) {
  const accessToken = signAccessToken({ sub: user.id, role: user.role, email: user.email });
  const refreshToken = signRefreshToken(user.id);
  return { user: toPublicUser(user), accessToken, refreshToken };
}
