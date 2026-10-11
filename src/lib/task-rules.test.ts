import { describe, expect, it } from 'vitest';
import { canTransition } from './task-rules';

describe('task state transitions', () => {
  it('keeps execution queueing behind the supervised run command', () => {
    expect(canTransition('awaiting_approval', 'queued')).toBe(false);
    expect(canTransition('pending', 'queued')).toBe(false);
    expect(canTransition('awaiting_review', 'queued')).toBe(false);
  });

  it('requires review before marking work complete', () => {
    expect(canTransition('running', 'completed')).toBe(false);
    expect(canTransition('awaiting_review', 'completed')).toBe(true);
  });

  it('does not allow terminal tasks to restart', () => {
    expect(canTransition('completed', 'queued')).toBe(false);
    expect(canTransition('canceled', 'pending')).toBe(false);
  });

  it('allows a failed triage to be retried', () => {
    expect(canTransition('failed', 'triaging')).toBe(true);
  });

  it('does not expose reconciliation as a manual task transition', () => {
    expect(canTransition('needs_reconciliation', 'queued')).toBe(false);
  });
});
