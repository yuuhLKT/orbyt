import type { TaskStatus } from '../types/domain';

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ['triaging', 'canceled'],
  triaging: ['awaiting_context', 'awaiting_approval', 'blocked', 'failed', 'canceled'],
  awaiting_context: ['triaging', 'canceled'],
  awaiting_approval: ['blocked', 'canceled'],
  queued: [],
  running: [],
  awaiting_review: ['completed', 'canceled'],
  needs_reconciliation: [],
  completed: [],
  blocked: ['pending', 'canceled'],
  failed: ['triaging', 'canceled'],
  canceled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return transitions[from].includes(to);
}

export function availableTransitions(from: TaskStatus): readonly TaskStatus[] {
  return transitions[from];
}
