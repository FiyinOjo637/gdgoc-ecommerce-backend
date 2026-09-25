import winston from 'winston';
import { isTest } from '../config/env';

export const logger = winston.createLogger({
  level: 'info',
  silent: isTest,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  transports: [new winston.transports.Console()],
});
