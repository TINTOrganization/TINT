import 'dotenv/config';
import app from './app.js';
import { env } from './config/env.js';
import { logger } from './logging.js';
import { isAuthEmulatorEnabled } from './modules/auth/firebaseToken.js';

if (isAuthEmulatorEnabled()) {
  // ADR 0024: solo desarrollo. Los ID tokens del emulador no llevan firma.
  logger.warn('identity-api: modo Firebase Auth Emulator activo, se aceptan ID tokens sin firma (solo desarrollo)', {
    project: env.FIREBASE_PROJECT_ID,
  });
}

const port = parseInt(env.IDENTITY_API_PORT, 10);
app.listen(port, () => {
  logger.info('identity-api listening', { port });
});
