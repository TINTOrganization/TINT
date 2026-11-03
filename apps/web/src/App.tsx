import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { StaticRouter } from 'react-router-dom/server';
import { AnimatePresence } from 'framer-motion';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import CreateRoom from './pages/CreateRoom';
import InviteLanding from './pages/InviteLanding';
import WatchRoom from './pages/WatchRoom';
import ProtectedRoute from './routes/ProtectedRoute';
import Forbidden from './pages/Forbidden';
import { MotionProvider } from './components/motion/MotionProvider';
import { PageTransition } from './components/motion/PageTransition';

// Carga diferida: la ruta oculta del cuestionario no se enlaza desde la UI.
const TestMe = lazy(() => import('./pages/TestMe'));
// Carga diferida: mapa interactivo de la arquitectura, también oculto y hermano del cuestionario.
const Arquitectura = lazy(() => import('./pages/Arquitectura'));
// Carga diferida: la analítica solo la abre el host y no debe pesar en el bundle principal.
const RoomAnalytics = lazy(() => import('./pages/RoomAnalytics'));
// Carga diferida: panel de negocio de analítica, oculto y protegido con contraseña.
const BusinessAnalytics = lazy(() => import('./pages/BusinessAnalytics'));
// Carga diferida: la sala live (WHIP/WHEP, mezclador y compositor) solo la abre quien la usa.
const LiveRoom = lazy(() => import('./pages/LiveRoom'));

const page = (node: ReactNode) => <PageTransition>{node}</PageTransition>;

export interface AppInitialData {
  roomTitle?: string | null;
  code?: string | null;
  [key: string]: unknown;
}

export interface AppProps {
  location?: string;
  initialData?: AppInitialData | null;
}

/** Rutas con transición: AnimatePresence necesita la ubicación para animar la salida. */
export function AnimatedRoutes({ initialData }: { initialData?: AppInitialData | null }) {
  const location = useLocation();
  return (
    <AnimatePresence mode="wait" initial={false}>
      <Routes location={location} key={location.pathname}>
        <Route path="/login" element={page(<Login />)} />
        <Route path="/invite/:code" element={page(<InviteLanding initialRoomTitle={initialData?.roomTitle} />)} />
        <Route path="/dashboard" element={page(<ProtectedRoute><Dashboard /></ProtectedRoute>)} />
        <Route path="/rooms/new" element={page(<ProtectedRoute><CreateRoom /></ProtectedRoute>)} />
        <Route path="/rooms/:id" element={page(<ProtectedRoute><CreateRoom /></ProtectedRoute>)} />
        <Route
          path="/rooms/:id/analytics"
          element={page(<ProtectedRoute><Suspense fallback={null}><RoomAnalytics /></Suspense></ProtectedRoute>)}
        />
        <Route path="/watch/:roomId" element={page(<WatchRoom />)} />
        {/* Sala live (ADR 0019): transmisión por stream-core, sin Canal Sync. */}
        <Route path="/live/:roomId" element={page(<Suspense fallback={null}><LiveRoom /></Suspense>)} />
        <Route path="/403" element={page(<Forbidden />)} />
        {/* Ruta oculta: cuestionario del monorepo, sin enlaces desde la UI. */}
        <Route path="/test-me" element={<Suspense fallback={null}><TestMe /></Suspense>} />
        {/* Ruta oculta: mapa interactivo de la arquitectura, sin enlaces desde la UI. */}
        <Route path="/arquitectura" element={<Suspense fallback={null}><Arquitectura /></Suspense>} />
        {/* Ruta oculta: panel de negocio de analítica (pide la contraseña del equipo). */}
        <Route path="/analitica" element={<Suspense fallback={null}><BusinessAnalytics /></Suspense>} />
        <Route path="/" element={<Navigate to="/login" replace />} />
      </Routes>
    </AnimatePresence>
  );
}

export default function App({ location, initialData }: AppProps = {}) {
  const content = (
    <MotionProvider>
      <AnimatedRoutes initialData={initialData} />
    </MotionProvider>
  );

  if (location !== undefined) {
    return <StaticRouter location={location}>{content}</StaticRouter>;
  }

  return <BrowserRouter>{content}</BrowserRouter>;
}
