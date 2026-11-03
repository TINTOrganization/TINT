/**
 * Preferencias por navegador en `localStorage`. Puede lanzar (modo privado, datos de sitio
 * bloqueados): en ese caso se lee `null` y la escritura se ignora, nunca se rompe la UI.
 */
export function readStored(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, value);
  } catch {
    // Sin almacenamiento la preferencia solo dura esta visita.
  }
}
