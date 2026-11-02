import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import App, { type AppInitialData } from './App';
import { auth } from './lib/firebase';
import { startHostSession } from './lib/authSession';
import { initPreHydrationCapture } from './lib/hydration';
import './index.css';

// AC2: Captura temprana de interacciones antes y durante la hidratación
initPreHydrationCapture();

// Una sola vez al arrancar: mantiene fresco el ID token del host (caduca a la hora).
startHostSession(auth);

const container = document.getElementById('root')!;

let initialData: AppInitialData | null = null;
const dataElement = document.getElementById('__TINT_SSR_DATA__');
if (dataElement?.textContent) {
  try {
    initialData = JSON.parse(dataElement.textContent) as AppInitialData;
  } catch {
    // Si falla el parseo se ignora
  }
}

const appElement = (
  <StrictMode>
    <App initialData={initialData} />
  </StrictMode>
);

// AC3: Si el contenedor trae HTML pre-renderizado del servidor, hidrata sobre el DOM existente;
// de lo contrario, realiza render inicial limpio desde la raíz.
if (container.hasChildNodes() && container.innerHTML.trim().length > 0) {
  hydrateRoot(container, appElement);
} else {
  createRoot(container).render(appElement);
}
