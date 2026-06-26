import type { ApiError } from '@/types/api'

export class ApiClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'ApiClientError'
  }
  get isUnauthenticated() { return this.status === 401 }
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  const json: unknown = await res.json()
  if (!res.ok) {
    const body = json as { error?: ApiError }
    throw new ApiClientError(
      body.error?.code ?? 'internal',
      body.error?.message ?? 'Request failed',
      res.status,
    )
  }
  return (json as { data: T }).data
}

export function apiGet<T>(url: string): Promise<T> {
  return apiFetch<T>(url)
}

export function apiPost<T>(url: string, body: unknown): Promise<T> {
  return apiFetch<T>(url, { method: 'POST', body: JSON.stringify(body) })
}

export function apiPatch<T>(url: string, body: unknown): Promise<T> {
  return apiFetch<T>(url, { method: 'PATCH', body: JSON.stringify(body) })
}
