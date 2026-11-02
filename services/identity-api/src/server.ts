import 'dotenv/config';
import app from './app.js';
import { env } from './config/env.js';
import { logger } from './logging.js';

const port = parseInt(env.IDENTITY_API_PORT, 10);
app.listen(port, () => {
  logger.info('identity-api listening', { port });
});
