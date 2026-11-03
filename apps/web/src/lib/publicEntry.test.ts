import { describe, expect, it } from 'vitest';
import { sameOriginWebSocketUrl } from './publicEntry';

describe('sameOriginWebSocketUrl', () => {
  it('usa WSS y el host de la página HTTPS para los conectores públicos', () => {
    expect(sameOriginWebSocketUrl('/ws/sync', { protocol: 'https:', host: 'tint.example' })).toBe(
      'wss://tint.example/ws/sync',
    );
  });

  it('mantiene WS para el desarrollo local servido por HTTP', () => {
    expect(sameOriginWebSocketUrl('/ws/social', { protocol: 'http:', host: 'localhost:5173' })).toBe(
      'ws://localhost:5173/ws/social',
    );
  });

  it('añade barra inicial si la ruta relativa no la tiene', () => {
    expect(sameOriginWebSocketUrl('ws/voice', { protocol: 'https:', host: 'tint.example' })).toBe(
      'wss://tint.example/ws/voice',
    );
  });

  it('conserva URLs absolutas ws:// y wss:// sin modificarlas', () => {
    expect(sameOriginWebSocketUrl('ws://custom-server:8080/ws/sync')).toBe('ws://custom-server:8080/ws/sync');
    expect(sameOriginWebSocketUrl('wss://custom-server:8443/ws/social')).toBe('wss://custom-server:8443/ws/social');
  });
});
