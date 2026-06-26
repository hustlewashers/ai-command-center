export type UserRole =
  | 'org_admin'
  | 'department_lead'
  | 'department_member'
  | 'read_only'
  | 'agent'

export interface UserContext {
  userId: string
  organizationId: string
  departmentId: string | null
  role: UserRole
}

export type ErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'approval_required'
  | 'conflict'
  | 'validation'
  | 'rate_limited'
  | 'internal'

export interface ApiError {
  code: ErrorCode
  message: string
  details?: unknown
}

export interface ApiSuccess<T> {
  data: T
  error?: never
}

export interface ApiFailure {
  data?: never
  error: ApiError
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure
