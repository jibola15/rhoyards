import { errorBodySchema } from './api';

/** Error thrown by the API client for any non-2xx response. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Returns the CSRF token to send on state-changing requests (wired up with sessions in Phase 2). */
  getCsrfToken?: () => string | undefined;
  fetchImpl?: typeof fetch;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export function createApiClient({ baseUrl, getCsrfToken, fetchImpl }: ApiClientOptions) {
  async function request<T>(method: Method, path: string, options: RequestOptions = {}): Promise<T> {
    const doFetch = fetchImpl ?? fetch;
    const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
    // FormData (file uploads) sets its own multipart Content-Type with the boundary.
    const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
    if (options.body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') {
      const csrf = getCsrfToken?.();
      if (csrf) headers['X-CSRF-Token'] = csrf;
    }

    const res = await doFetch(`${baseUrl}${path}`, {
      method,
      headers,
      credentials: 'include',
      body: options.body === undefined ? undefined : isForm ? (options.body as FormData) : JSON.stringify(options.body),
      signal: options.signal,
    });

    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }

    if (!res.ok) {
      const parsed = errorBodySchema.safeParse(json);
      if (parsed.success) {
        const e = parsed.data.error;
        throw new ApiError(res.status, e.code, e.message, e.details, e.requestId);
      }
      throw new ApiError(res.status, 'HTTP_ERROR', `Request failed with status ${res.status}`);
    }
    return json as T;
  }

  return {
    get: <T>(path: string, options?: Omit<RequestOptions, 'body'>) => request<T>('GET', path, options),
    post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
      request<T>('POST', path, { ...options, body }),
    put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
      request<T>('PUT', path, { ...options, body }),
    patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
      request<T>('PATCH', path, { ...options, body }),
    delete: <T>(path: string, options?: RequestOptions) => request<T>('DELETE', path, options),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
