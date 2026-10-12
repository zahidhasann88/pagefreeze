/**
 * Consecutive-failure notification policy.
 *
 * Pure functions so the policy can be tested exhaustively with a fake clock and without
 * a database. The rule is deliberately quiet:
 *
 *   - notify once when the failure streak first reaches the threshold
 *   - stay silent while the streak keeps growing (no alert storm)
 *   - notify once again when a capture succeeds after a streak that *was* notified
 *   - never notify for a streak that never reached the threshold
 */

export interface FailureState {
  /** Streak length *before* this attempt. */
  consecutiveFailures: number;
  /** Whether a failure alert has already been sent for the current streak. */
  failureNotified: boolean;
}

export type FailureDecision =
  | { action: 'none'; state: FailureState }
  | { action: 'notify-failure'; state: FailureState }
  | { action: 'notify-recovery'; state: FailureState };

export interface FailurePolicyOptions {
  /** Notify once the streak reaches this length. Must be >= 1. */
  threshold: number;
}

/** Apply a failed capture to the state and decide whether to notify. */
export function onFailure(state: FailureState, options: FailurePolicyOptions): FailureDecision {
  const threshold = Math.max(1, options.threshold);
  const next = state.consecutiveFailures + 1;

  // Only fire on the exact transition to the threshold, and only if we have not already
  // notified for this streak.
  if (next === threshold && !state.failureNotified) {
    return {
      action: 'notify-failure',
      state: { consecutiveFailures: next, failureNotified: true },
    };
  }

  return {
    action: 'none',
    state: { consecutiveFailures: next, failureNotified: state.failureNotified },
  };
}

/** Apply a successful capture to the state and decide whether to notify recovery. */
export function onSuccess(state: FailureState, _options: FailurePolicyOptions): FailureDecision {
  if (state.consecutiveFailures > 0 && state.failureNotified) {
    return {
      action: 'notify-recovery',
      state: { consecutiveFailures: 0, failureNotified: false },
    };
  }
  return {
    action: 'none',
    state: { consecutiveFailures: 0, failureNotified: false },
  };
}

/**
 * Convenience for tests and the demo: replay a sequence of outcomes and return the
 * notifications that would have been sent.
 */
export function simulateStreak(
  outcomes: Array<'success' | 'failure'>,
  options: FailurePolicyOptions,
): Array<{ index: number; action: 'notify-failure' | 'notify-recovery'; streak: number }> {
  let state: FailureState = { consecutiveFailures: 0, failureNotified: false };
  const events: Array<{
    index: number;
    action: 'notify-failure' | 'notify-recovery';
    streak: number;
  }> = [];

  outcomes.forEach((outcome, index) => {
    const decision = outcome === 'failure' ? onFailure(state, options) : onSuccess(state, options);
    state = decision.state;
    if (decision.action !== 'none') {
      events.push({
        index,
        action: decision.action,
        streak: decision.action === 'notify-failure' ? state.consecutiveFailures : index,
      });
    }
  });

  return events;
}
