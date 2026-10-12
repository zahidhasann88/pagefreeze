export interface FailureState {
  consecutiveFailures: number;
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

export function onFailure(state: FailureState, options: FailurePolicyOptions): FailureDecision {
  const threshold = Math.max(1, options.threshold);
  const next = state.consecutiveFailures + 1;

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
