import { Router } from 'express';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../middleware/error';
import { requireAuth } from '../../middleware/auth';
import { addCartItemSchema, productIdParamSchema, updateCartItemSchema } from './cart.schema';
import * as cartService from './cart.service';

const router = Router();
router.use(requireAuth); // every cart route is tenant-scoped to the caller

/**
 * @openapi
 * /cart:
 *   get:
 *     summary: Get the current user's cart, with live price/stock flags
 *     tags: [Cart]
 *     security: [{ bearerAuth: [] }]
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(cartService.getCartView(req.user!.id));
  }),
);

/**
 * @openapi
 * /cart/items:
 *   post:
 *     summary: Add an item to the cart (or increment quantity if present)
 *     tags: [Cart]
 *     security: [{ bearerAuth: [] }]
 */
router.post(
  '/items',
  validate({ body: addCartItemSchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json(cartService.addItem(req.user!.id, req.body.productId, req.body.quantity));
  }),
);

/**
 * @openapi
 * /cart/items/{productId}:
 *   patch:
 *     summary: Set an item's quantity
 *     tags: [Cart]
 *     security: [{ bearerAuth: [] }]
 */
router.patch(
  '/items/:productId',
  validate({ params: productIdParamSchema, body: updateCartItemSchema }),
  asyncHandler(async (req, res) => {
    res.json(cartService.updateItemQuantity(req.user!.id, req.params.productId, req.body.quantity));
  }),
);

/**
 * @openapi
 * /cart/items/{productId}:
 *   delete:
 *     summary: Remove an item from the cart
 *     tags: [Cart]
 *     security: [{ bearerAuth: [] }]
 */
router.delete(
  '/items/:productId',
  validate({ params: productIdParamSchema }),
  asyncHandler(async (req, res) => {
    res.json(cartService.removeItem(req.user!.id, req.params.productId));
  }),
);

/**
 * @openapi
 * /cart:
 *   delete:
 *     summary: Clear the entire cart
 *     tags: [Cart]
 *     security: [{ bearerAuth: [] }]
 */
router.delete(
  '/',
  asyncHandler(async (req, res) => {
    res.json(cartService.clearCart(req.user!.id));
  }),
);

export default router;
