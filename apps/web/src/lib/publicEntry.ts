/**
 * Convierte una ruta WebSocket pública en una URL absoluta del origen que sirve la SPA.
 * Las URLs absolutas se conservan para entornos de desarrollo con servicios separados.
 */
export function sameOriginWebSocketUrl(
  pathOrUrl: string,
  page: Pick<Location, 'protocol' | 'host'> = window.location,
): string {
  if (/^wss?:\/\//i.test(pathOrUrl)) return pathOrUrl;

  const path = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
  const protocol = page.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${page.host}${path}`;
}
