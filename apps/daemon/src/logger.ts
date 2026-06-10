import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: process.env.HA_LOG_LEVEL ?? 'info',
  transport: config.logPretty
    ? {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
      }
    : undefined,
});
