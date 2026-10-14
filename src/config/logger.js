import { createRequire } from 'module';
import pino from 'pino';
import env from './env.js';

// Development: short, coloured single-line output ("14:02:11 INFO  API ready ...").
// Production: compact JSON lines for log collectors. pino-pretty is a dev dependency,
// so it's only used when installed.
function prettyTransport() {
  if (env.NODE_ENV === 'production' || env.NODE_ENV === 'test') return undefined;
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
  } catch {
    return undefined;
  }
  return {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:HH:MM:ss',
      ignore: 'pid,hostname,req,res,responseTime',
      singleLine: true,
    },
  };
}

export default pino({
  level: env.LOG_LEVEL,
  base: undefined, // drop pid/hostname from every line
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.passwordHash'],
  transport: prettyTransport(),
});
