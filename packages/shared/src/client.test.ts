import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from './client';

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('api client', () => {
  it('returns parsed JSON on success and sends credentials', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { data: { ok: true } }));
    const api = createApiClient({ baseUrl: '/api/v1', fetchImpl });
    await expect(api.get('/health')).resolves.toEqual({ data: { ok: true } });
    expect(fetchImpl).toHaveBeenCalledWith('/api/v1/health', expect.objectContaining({ credentials: 'include' }));
  });

  it('throws ApiError carrying the server error envelope', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(409, { error: { code: 'CONFLICT', message: 'Duplicate SKU', requestId: 'r-1' } }),
    );
    const api = createApiClient({ baseUrl: '', fetchImpl });
    const err = await api.post('/x', { a: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'CONFLICT', message: 'Duplicate SKU', requestId: 'r-1' });
  });

  it('handles non-JSON error responses', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>Bad gateway</html>', { status: 502 }));
    const api = createApiClient({ baseUrl: '', fetchImpl });
    await expect(api.get('/x')).rejects.toMatchObject({ status: 502, code: 'HTTP_ERROR' });
  });

  it('sends the CSRF token on state-changing requests only', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    const api = createApiClient({ baseUrl: '', fetchImpl, getCsrfToken: () => 'tok' });
    await api.get('/a');
    await api.post('/b', {});
    const headersOf = (i: number) => (fetchImpl.mock.calls[i] as unknown as [string, RequestInit])[1].headers;
    expect(headersOf(0)).not.toHaveProperty('X-CSRF-Token');
    expect(headersOf(1)).toHaveProperty('X-CSRF-Token', 'tok');
  });
});
