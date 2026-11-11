export function normalizeSchedulingConfig(scheduling = {}) {
  const normalized = {
    requestProgress: false,
    swipeCancellation: true,
    maxConcurrentRequests: Infinity,
    ...scheduling
  };
  if (typeof normalized.swipeCancellation !== 'boolean') {
    throw new TypeError('scheduling.swipeCancellation must be true or false');
  }
  if (
    normalized.maxConcurrentRequests !== Infinity &&
    (!Number.isSafeInteger(normalized.maxConcurrentRequests) ||
      normalized.maxConcurrentRequests < 1)
  ) {
    throw new TypeError('scheduling.maxConcurrentRequests must be a positive integer or Infinity');
  }
  return normalized;
}
