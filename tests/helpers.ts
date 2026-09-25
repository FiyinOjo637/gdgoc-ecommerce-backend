import request from 'supertest';
import { createApp } from '../src/app';
import { db } from '../src/db/client';
import { products, users, carts } from '../src/db/schema';
import { hashPassword } from '../src/utils/password';
import { newId, nowIso } from '../src/utils/id';
import { nairaToKobo } from '../src/utils/money';
import { signAccessToken } from '../src/utils/jwt';

export const app = createApp();

export async function createUser(opts: { role?: 'CUSTOMER' | 'ADMIN'; email?: string } = {}) {
  const now = nowIso();
  const id = newId();
  const email = opts.email ?? `user-${id}@example.com`;
  db.insert(users)
    .values({
      id,
      name: 'Test User',
      email,
      passwordHash: await hashPassword('Password123!'),
      role: opts.role ?? 'CUSTOMER',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(carts).values({ id: newId(), userId: id, createdAt: now, updatedAt: now }).run();

  const token = signAccessToken({ sub: id, role: opts.role ?? 'CUSTOMER', email });
  return { id, email, token };
}

export function createProduct(opts: {
  name?: string;
  priceNaira?: number;
  stock?: number;
  isActive?: boolean;
  category?: string;
} = {}) {
  const now = nowIso();
  const id = newId();
  db.insert(products)
    .values({
      id,
      name: opts.name ?? 'Sample Product',
      description: 'A sample product for tests',
      category: opts.category ?? 'Test',
      priceKobo: nairaToKobo(opts.priceNaira ?? 1000),
      stock: opts.stock ?? 10,
      isActive: opts.isActive ?? true,
      version: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

export function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

export { request };
