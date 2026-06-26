import { NextResponse } from 'next/server'
import type { ErrorCode, ApiError } from '@/types/api'

const HTTP_STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  approval_required: 409,
  conflict: 409,
  validation: 422,
  rate_limited: 429,
  internal: 500,
}

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function createError(code: ErrorCode, message: string, details?: unknown): AppError {
  return new AppError(code, message, details)
}

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof AppError) {
    const body: { error: ApiError } = {
      error: { code: err.code, message: err.message, ...(err.details !== undefined && { details: err.details }) },
    }
    return NextResponse.json(body, { status: HTTP_STATUS[err.code] })
  }

  console.error('[internal]', err)
  const body: { error: ApiError } = {
    error: { code: 'internal', message: 'An unexpected error occurred' },
  }
  return NextResponse.json(body, { status: 500 })
}

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ data }, { status })
}
