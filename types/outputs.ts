export type OutputType = 'report' | 'artifact' | 'message' | 'data' | 'other'

export type OutputStatus =
  | 'draft'
  | 'in_review'
  | 'approved'
  | 'delivered'
  | 'superseded'
  | 'rejected'

export interface OutputRow {
  id: string
  organization_id: string
  department_id: string
  task_id: string
  project_id: string
  title: string
  output_type: OutputType
  content: string | null
  storage_path: string | null
  created_by_user_id: string | null
  status: OutputStatus
  produced_at: string
  delivered_at: string | null
  created_at: string
  updated_at: string
}

export interface CreateOutputBody {
  title: string
  output_type: OutputType
  content?: string | null
  storage_path?: string | null
  department_id: string
  task_id: string
  project_id: string
  status: OutputStatus
}

export interface PatchOutputBody {
  title?: string
  output_type?: OutputType
  content?: string | null
  storage_path?: string | null
  status?: OutputStatus
}

// G6 §5 — full status machine.
// The delivery gate (approved → delivered requires an approved Category A approval)
// is application-enforced in the route handler, not represented here.
export const VALID_OUTPUT_TRANSITIONS: Record<OutputStatus, OutputStatus[]> = {
  draft:      ['in_review', 'rejected'],
  in_review:  ['approved', 'rejected', 'draft'],
  approved:   ['delivered', 'superseded', 'draft'],
  delivered:  ['superseded'],
  rejected:   ['draft'],
  superseded: [],
}

// Only 'draft' is a valid initial status (G6 §8 — outputs begin in draft).
export const VALID_INSERT_STATUSES: OutputStatus[] = ['draft']
