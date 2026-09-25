import { Router } from 'express';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../middleware/error';
import { requireAuth, requireRole } from '../../middleware/auth';
import {
  createProductSchema,
  idParamSchema,
  listProductsQuerySchema,
  updateProductSchema,
} from './products.schema';
import * as productsService from './products.service';

const router = Router();

/**
 * @openapi
 * /products:
 *   get:
 *     summary: Browse/search/filter the product catalog (public)
 *     tags: [Products]
 */
router.get(
  '/',
  validate({ query: listProductsQuerySchema }),
  asyncHandler(async (req, res) => {
    res.json(productsService.listProducts(req.query as any));
  }),
);

/**
 * @openapi
 * /products/categories:
 *   get:
 *     summary: List distinct product categories (public)
 *     tags: [Products]
 */
router.get(
  '/categories',
  asyncHandler(async (_req, res) => {
    res.json({ data: productsService.listCategories() });
  }),
);

/**
 * @openapi
 * /products/{id}:
 *   get:
 *     summary: Get a single product's details (public)
 *     tags: [Products]
 */
router.get(
  '/:id',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    res.json(productsService.getProductById(req.params.id));
  }),
);

/**
 * @openapi
 * /products:
 *   post:
 *     summary: Create a product (admin only)
 *     tags: [Products]
 *     security: [{ bearerAuth: [] }]
 */
router.post(
  '/',
  requireAuth,
  requireRole('ADMIN'),
  validate({ body: createProductSchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json(productsService.createProduct(req.body));
  }),
);

/**
 * @openapi
 * /products/{id}:
 *   patch:
 *     summary: Update a product (admin only)
 *     tags: [Products]
 *     security: [{ bearerAuth: [] }]
 */
router.patch(
  '/:id',
  requireAuth,
  requireRole('ADMIN'),
  validate({ params: idParamSchema, body: updateProductSchema }),
  asyncHandler(async (req, res) => {
    res.json(productsService.updateProduct(req.params.id, req.body));
  }),
);

/**
 * @openapi
 * /products/{id}:
 *   delete:
 *     summary: Deactivate a product (admin only, soft delete)
 *     tags: [Products]
 *     security: [{ bearerAuth: [] }]
 */
router.delete(
  '/:id',
  requireAuth,
  requireRole('ADMIN'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    res.json(productsService.deactivateProduct(req.params.id));
  }),
);

export default router;
