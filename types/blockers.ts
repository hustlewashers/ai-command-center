// Note: 'project' is intentionally excluded — the deployed DB CHECK constraint
// (blockers_blocked_entity_type_check, 011_governance_layer.sql) only admits
// 'task' and 'work_packet'. Project blockers are deferred (G8 §2).
export type BlockerEntityType = 'task' | 'work_packet'

export type BlockerSeverity = 'low' | 'medium' | 'high' | 'critical'

// All five DB-valid statuses (blockers_status_check, 011_governance_layer.sql).
// The API's sprint-1.9 state machine covers: open, resolved, won_t_fix only.
// 'investigating' and 'pending_external' are valid DB values but not reachable via
// the current API transition set — they are future-phase extensions (G8 §5).
export type BlockerStatus =
  | 'open'
  | 'investigating'
  | 'pending_external'
  | 'resolved'
  | 'won_t_fix'

export interface BlockerRow {
  id: string
  organization_id: string
  department_id: string
  description: string
  blocked_entity_type: BlockerEntityType
  blocked_entity_id: string
  severity: BlockerSeverity
  reported_by_user_id: string
  assigned_to_user_id: string | null
  resolution_note: string | null
  status: BlockerStatus
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface CreateBlockerBody {
  department_id: string
  description: string
  blocked_entity_type: BlockerEntityType
  blocked_entity_id: string
  severity: BlockerSeverity
  assigned_to_user_id?: string | null
}

export interface PatchBlockerBody {
  description?: string
  severity?: BlockerSeverity
  status?: BlockerStatus
  resolution_note?: string | null
  assigned_to_user_id?: string | null
}

// Sprint 1.9 state machine (G8 §5, MVP transitions).
// won_t_fix → open has an additional Category B Decision gate enforced in the route handler.
// 'investigating' and 'pending_external' have no valid outbound transitions via this API
// for the current sprint scope.
export const VALID_BLOCKER_TRANSITIONS: Record<BlockerStatus, BlockerStatus[]> = {
  open:             ['resolved', 'won_t_fix'],
  investigating:    [],
  pending_external: [],
  resolved:         ['open'],
  won_t_fix:        ['open'],
}

// Only 'open' is valid at INSERT (blockers_insert_department_scope WITH CHECK, G8 §4).
export const VALID_INSERT_STATUSES: BlockerStatus[] = ['open']
