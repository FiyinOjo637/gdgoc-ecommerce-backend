import { Router } from 'express';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../middleware/error';
import { requireAuth } from '../../middleware/auth';
import { z } from 'zod';
import * as ordersService from './orders.service';

const router = Router();
router.use(requireAuth);

const idParamSchema = z.object({ id: z.string().uuid() });

/**
 * @openapi
 * /orders/checkout:
 *   post:
 *     summary: Convert the current cart into an order and initialize payment
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 */
router.post(
  '/checkout',
  asyncHandler(async (req, res) => {
    const result = await ordersService.checkout(req.user!.id, req.user!.email);
    res.status(201).json(result);
  }),
);

/**
 * @openapi
 * /orders:
 *   get:
 *     summary: List the current user's orders
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ data: ordersService.listOrdersForUser(req.user!.id) });
  }),
);

/**
 * @openapi
 * /orders/{id}:
 *   get:
 *     summary: Get a single order (owner or admin only)
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 */
router.get(
  '/:id',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    const isAdmin = req.user!.role === 'ADMIN';
    res.json(ordersService.getOrderForUser(req.user!.id, req.params.id, isAdmin));
  }),
);

/**
 * @openapi
 * /orders/{id}/verify:
 *   post:
 *     summary: Actively re-check payment status with the gateway (reconciliation)
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 */
router.post(
  '/:id/verify',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    const isAdmin = req.user!.role === 'ADMIN';
    const result = await ordersService.verifyOrderWithGateway(req.user!.id, req.params.id, isAdmin);
    res.json(result);
  }),
);

/**
 * @openapi
 * /orders/{id}/cancel:
 *   post:
 *     summary: Cancel a pending (unpaid) order and release reserved stock
 *     tags: [Orders]
 *     security: [{ bearerAuth: [] }]
 */
router.post(
  '/:id/cancel',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    const isAdmin = req.user!.role === 'ADMIN';
    res.json(ordersService.cancelOrder(req.user!.id, req.params.id, isAdmin));
  }),
);

export default router;
