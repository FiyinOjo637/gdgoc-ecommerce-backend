import express, { Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import path from 'path';
import YAML from 'yamljs';
import swaggerUi from 'swagger-ui-express';

import authRoutes from './modules/auth/auth.routes';
import productsRoutes from './modules/products/products.routes';
import cartRoutes from './modules/cart/cart.routes';
import ordersRoutes from './modules/orders/orders.routes';
import webhookRoutes from './modules/payments/webhook.routes';
import { errorHandler, notFoundHandler } from './middleware/error';
import { isTest } from './config/env';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors());
  app.use(compression());
  if (!isTest) app.use(morgan('combined'));

  // Global rate limit as a baseline defence; auth routes layer a stricter
  // limiter on top (see auth.routes.ts).
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: 300,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  // IMPORTANT: the webhook route needs the RAW request body to verify
  // Paystack's HMAC signature, so it is mounted BEFORE the global JSON body
  // parser and parses its own body with express.raw() internally
  // (see webhook.routes.ts). Every other route below uses express.json().
  app.use('/webhooks', webhookRoutes);

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

  app.use('/auth', authRoutes);
  app.use('/products', productsRoutes);
  app.use('/cart', cartRoutes);
  app.use('/orders', ordersRoutes);

  try {
    const openapiDocument = YAML.load(path.join(__dirname, '..', 'openapi.yaml'));
    app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiDocument));
    app.get('/openapi.json', (_req, res) => res.json(openapiDocument));
  } catch {
    // openapi.yaml missing in some minimal deployments — docs route simply
    // won't be mounted rather than crashing the app.
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
