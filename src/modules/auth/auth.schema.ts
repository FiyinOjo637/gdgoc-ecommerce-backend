import { z } from 'zod';

export const registerSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email(),
  password: z.string().min(8).max(72),
  // Only present so an admin bootstrap script can create admins; public
  // registration ignores this unless ALLOW_SELF_SIGNUP_ADMIN is enabled
  // (see auth.service.ts) - default deployments always create CUSTOMER.
  role: z.enum(['CUSTOMER', 'ADMIN']).optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(10),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
