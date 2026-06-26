// category 'c' exists in the DB check constraint but is forbidden by RLS INSERT/UPDATE
// policies (017). The API surface exposes only 'a' and 'b' (G5 §4).
export type ApprovalCategory = 'a' | 'b'

export type ApprovalSubjectType = 'task' | 'work_packet' | 'decision' | 'output'

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'withdrawn'

// Statuses reachable via the authenticated PATCH endpoint (G5 §6, §12).
// 'expired' is system/service-role only; 'pending' has no return path.
export type ApprovalResolutionStatus = 'approved' | 'rejected' | 'withdrawn'

export interface ApprovalRow {
  id: string
  organization_id: string
  department_id: string
  subject_type: ApprovalSubjectType
  subject_id: string
  category: ApprovalCategory
  trigger_reason: string
  requested_by_user_id: string | null
  approver_user_id: string | null
  approver_role: string
  status: ApprovalStatus
  decided_at: string | null   // null iff pending (DB paired invariant)
  decision_note: string | null
  expires_at: string | null
  created_at: string
  updated_at: string
}

export interface CreateApprovalBody {
  subject_type: ApprovalSubjectType
  subject_id: string
  category: ApprovalCategory
  trigger_reason: string
  department_id: string
  approver_role: string
  approver_user_id?: string | null
  expires_at?: string | null
}

export interface PatchApprovalBody {
  // status is required — the only mutable transition is pending → resolved (G5 §11).
  // 'expired' is excluded: system/service-role only, unreachable via authenticated path.
  status: ApprovalResolutionStatus
  decision_note?: string | null
}
