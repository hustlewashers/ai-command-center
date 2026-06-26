export type WorkPacketStatus =
  | 'draft'
  | 'ready'
  | 'pending_approval'
  | 'in_execution'
  | 'accepted'
  | 'superseded'
  | 'cancelled'

export type WorkPacketParentType = 'task' | 'project'

export type WorkPacketPriority = 'low' | 'normal' | 'high' | 'critical'

export interface WorkPacketRow {
  id: string
  organization_id: string
  title: string
  objective: string
  scope: Record<string, unknown>
  acceptance_criteria: unknown[]
  department_id: string
  parent_type: WorkPacketParentType
  parent_id: string
  priority: WorkPacketPriority
  constraints: Record<string, unknown>
  approval_required_before_start: boolean
  author_user_id: string
  status: WorkPacketStatus
  created_at: string
  updated_at: string
}

export interface CreateWorkPacketBody {
  title: string
  objective: string
  department_id: string
  parent_type: WorkPacketParentType
  parent_id: string
  scope: Record<string, unknown>
  acceptance_criteria: unknown[]
  constraints: Record<string, unknown>
  priority: WorkPacketPriority
  approval_required_before_start: boolean
  status: WorkPacketStatus
}

export interface PatchWorkPacketBody {
  title?: string
  objective?: string
  scope?: Record<string, unknown>
  acceptance_criteria?: unknown[]
  constraints?: Record<string, unknown>
  priority?: WorkPacketPriority
  approval_required_before_start?: boolean
  status?: WorkPacketStatus
}

// Status transitions permitted by the documented lifecycle (G4 §5).
// Conditional rules (approval gate, pending_approval gate) are enforced at Layer 4 in the route.
// Terminal states have empty arrays — no outbound transitions.
export const VALID_WORK_PACKET_TRANSITIONS: Record<WorkPacketStatus, WorkPacketStatus[]> = {
  draft:            ['ready', 'cancelled'],
  ready:            ['pending_approval', 'in_execution', 'superseded', 'cancelled'],
  pending_approval: ['in_execution', 'ready', 'superseded', 'cancelled'],
  in_execution:     ['accepted', 'superseded', 'cancelled'],
  accepted:         [],
  superseded:       [],
  cancelled:        [],
}

export const TERMINAL_WORK_PACKET_STATUSES: WorkPacketStatus[] = ['accepted', 'superseded', 'cancelled']

// Only these statuses are permitted when creating a work packet (G4 §8, §19.1).
export const VALID_INITIAL_WP_STATUSES: WorkPacketStatus[] = ['draft', 'ready']
