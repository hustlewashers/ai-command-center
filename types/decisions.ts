export type DecisionStatus =
  | 'proposed'
  | 'confirmed'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'superseded'

export interface DecisionRow {
  id: string
  organization_id: string
  task_id: string
  summary: string
  rationale: string
  decided_by_user_id: string | null
  decided_at: string
  status: DecisionStatus
  created_at: string
  updated_at: string
}

export interface CreateDecisionBody {
  task_id: string
  summary: string
  rationale: string
  status: DecisionStatus
}

export interface PatchDecisionBody {
  summary?: string
  rationale?: string
  status?: DecisionStatus
}

// Status transitions permitted by the documented lifecycle (G7 §5).
// Conditional gate rule (pending_approval → approved requires resolved Category B approval)
//   is enforced at Layer 4 in the route handler, not in this table.
// 'rejected' can return to 'proposed' via the revise operation.
// 'superseded' is the only truly terminal state (no outbound transitions).
export const VALID_DECISION_TRANSITIONS: Record<DecisionStatus, DecisionStatus[]> = {
  proposed:         ['confirmed', 'pending_approval', 'rejected'],
  confirmed:        ['superseded'],
  pending_approval: ['approved', 'rejected', 'proposed'],
  approved:         ['superseded'],
  rejected:         ['proposed'],
  superseded:       [],
}

// Statuses permitted on initial INSERT (G7 §7, RLS WITH CHECK).
// DB enforces this too; Layer 4 gives a typed error before the DB fires.
export const VALID_INSERT_STATUSES: DecisionStatus[] = ['proposed', 'pending_approval']

// Committed states whose substantive fields (summary/rationale) may not be edited in-place.
// Substantive edits to a committed decision must go through 'supersede' (G7 §10).
export const COMMITTED_STATUSES: DecisionStatus[] = ['confirmed', 'approved']
