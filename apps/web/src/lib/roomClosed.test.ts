import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { CLOSE_ROOM_DISABLED, isRoomDisabledError, ROOM_ENDED_TITLE, roomEndedBody } from './roomClosed';

describe('roomClosed', () => {
  it('el código de cierre es 4010 (ROOM_DISABLED)', () => {
    expect(CLOSE_ROOM_DISABLED).toBe(4010);
    expect(ROOM_ENDED_TITLE).toMatch(/el evento terminó/i);
  });

  it('reconoce el 410 Disabled por el mensaje o por el cuerpo', () => {
    expect(isRoomDisabledError(new ApiError(410, 'Disabled', { error: 'Disabled' }))).toBe(true);
    expect(isRoomDisabledError({ status: 410, message: 'x', body: { error: 'Disabled' } })).toBe(true);
  });

  it('no confunde el 410 Deleted, otros códigos ni errores sin estado', () => {
    expect(isRoomDisabledError(new ApiError(410, 'Deleted', { error: 'Deleted' }))).toBe(false);
    expect(isRoomDisabledError(new ApiError(403, 'Disabled'))).toBe(false);
    expect(isRoomDisabledError(new Error('Disabled'))).toBe(false);
    expect(isRoomDisabledError(null)).toBe(false);
  });

  it('el texto de apoyo cambia para el host y el invitado', () => {
    expect(roomEndedBody(true)).toMatch(/análisis/);
    expect(roomEndedBody(false)).not.toBe(roomEndedBody(true));
  });
});
