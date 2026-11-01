import request from 'supertest';
import { describe, it, expect } from 'vitest';
import app from '../src/app.js';

describe('healthz', () => {
  it('returns ok', async () => {
    const res = await request(app).get('/api/v1/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', service: 'identity-api' });
  });

  it('preserves the correlation ID and includes it in error responses', async () => {
    const correlationId = 'trace-123';
    const ok = await request(app)
      .get('/api/v1/healthz')
      .set('X-Correlation-ID', correlationId);
    expect(ok.headers['x-correlation-id']).toBe(correlationId);

    const error = await request(app)
      .get('/api/v1/rooms/not-a-route')
      .set('X-Correlation-ID', correlationId);
    expect(error.headers['x-correlation-id']).toBe(correlationId);
    expect(error.body.correlation_id).toBe(correlationId);
  });

  it('generates a correlation ID when the request does not provide one', async () => {
    const response = await request(app).get('/api/v1/rooms/not-a-route');
    expect(response.headers['x-correlation-id']).toMatch(/^[A-Za-z0-9._:-]+$/);
  });
});
