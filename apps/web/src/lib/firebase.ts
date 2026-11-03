import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { connectToAuthEmulator } from './authEmulator';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'test',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'test',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'test',
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Solo desarrollo (ADR 0024): login del host contra el Firebase Auth Emulator.
connectToAuthEmulator(auth, import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_URL);
