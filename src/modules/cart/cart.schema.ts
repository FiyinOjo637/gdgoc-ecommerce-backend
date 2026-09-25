import { z } from 'zod';

export const addCartItemSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().positive().max(1000),
});

export const updateCartItemSchema = z.object({
  quantity: z.number().int().positive().max(1000),
});

export const productIdParamSchema = z.object({ productId: z.string().uuid() });

export type AddCartItemInput = z.infer<typeof addCartItemSchema>;
export type UpdateCartItemInput = z.infer<typeof updateCartItemSchema>;
