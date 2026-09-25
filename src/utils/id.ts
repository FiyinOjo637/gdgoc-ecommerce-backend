import { randomUUID } from 'crypto';

export function newId(): string {
  return randomUUID();
}

/** Human-shareable payment reference, distinct from the internal UUID id. */
export function newOrderReference(): string {
  const rand = randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();
  return `GDG-${Date.now().toString(36).toUpperCase()}-${rand}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
