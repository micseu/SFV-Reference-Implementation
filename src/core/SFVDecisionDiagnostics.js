import { snapshotContext, contextFromSnapshot } from '../rulehost/contextFromSnapshot.js';

/**
 * Opt-in, rule-agnostic decision evidence. Both live runtimes capture the *same*
 * context API, pending observation batch and rule state immediately BEFORE
 * onObservationBatch(). The real rule is then invoked exactly once.
 * No diagnostic data is given to the rule or added to its input batch.
 */
export const SFV_DECISION_DIAGNOSTIC_VERSION = 1;

export function captureDecisionInputs(rule, context, observations) {
  const stateBefore = rule.getState?.();
  return {
    schemaVersion: SFV_DECISION_DIAGNOSTIC_VERSION,
    rule: rule.name ?? rule.constructor.name,
    timeS: context.getCurrentTime(),
    context: snapshotContext(context),
    observations: structuredClone(observations),
    stateBefore: stateBefore === undefined ? null : structuredClone(stateBefore)
  };
}

export function finalizeDecisionDiagnostic(inputs, rule, decision) {
  const after = rule.getState?.();
  const estimator = after?.estimator?.state ?? null;
  const safe = rule.estimator?.getSafeKbps?.();
  return {
    ...inputs,
    stateAfterObservation: after === undefined ? null : structuredClone(after),
    safeThroughputKbps: Number.isFinite(safe) ? safe : null,
    throughputSamples: estimator?.samples ? structuredClone(estimator.samples) : null,
    decision: structuredClone(decision)
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

/** Reproduce an opt-in record with the ORIGINAL rule class, not a reimplementation. */
export function replayRecordedDecision(record, RuleClass) {
  if (record?.schemaVersion !== SFV_DECISION_DIAGNOSTIC_VERSION || !record.context ||
      !Array.isArray(record.observations) || !record.decision || record.stateBefore === null ||
      !RuleClass || typeof RuleClass !== 'function') {
    throw new TypeError('Replay requires a complete v1 diagnostic, a restorable rule state and its original rule class');
  }
  const rule = new RuleClass();
  if (typeof rule.setState !== 'function') throw new TypeError('Rule must implement setState() for replay');
  rule.setState(structuredClone(record.stateBefore));
  const context = contextFromSnapshot(record.context);
  rule.onObservationBatch?.(structuredClone(record.observations), context);
  const result = rule.getSwitchRequest(context) ?? {actions: []};
  const actions = result.actions ?? [];
  const ordered = [...actions.filter(a => a.actionType === 'ABORT'),
    ...actions.filter(a => a.actionType !== 'ABORT')];
  const actual = {rule: result.rule ?? rule.name ?? rule.constructor.name,
    reason: result.reason ?? null, actions: ordered};
  const expected = {rule: record.decision.rule,
    reason: record.decision.reason ?? null, actions: record.decision.actions};
  return {passed: JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected)),
    actual, expected};
}
