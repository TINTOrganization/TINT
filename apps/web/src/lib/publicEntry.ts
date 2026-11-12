/**
 * Convierte una ruta WebSocket pública en una URL absoluta del origen que sirve la SPA.
 * Las URLs absolutas se conservan para entornos de desarrollo con servicios separados.
 * Es defensivo y seguro para SSR en Node.js cuando `window` no está definido.
 */
export function sameOriginWebSocketUrl(
  pathOrUrl: string,
  page?: Pick<Location, 'protocol' | 'host'>,
): string {
  if (/^wss?:\/\//i.test(pathOrUrl)) return pathOrUrl;

  const loc = page ?? (typeof window !== 'undefined' ? window.location : undefined);
  if (!loc) return pathOrUrl;

  const path = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
  const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${loc.host}${path}`;
}
