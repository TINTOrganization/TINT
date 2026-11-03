import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import App from './App';
import { auth } from './lib/firebase';
import { startHostSession } from './lib/authSession';
import './index.css';

// Una sola vez al arrancar: mantiene fresco el ID token del host (caduca a la hora).
startHostSession(auth);

const container = document.getElementById('root');

if (container) {
  const appElement = (
    <StrictMode>
      <App />
    </StrictMode>
  );

  // Hidratación en cliente sin recargas de página cuando el servidor devuelve HTML pre-renderizado (AC3).
  if (container.hasChildNodes()) {
    hydrateRoot(container, appElement);
  } else {
    createRoot(container).render(appElement);
  }
}
