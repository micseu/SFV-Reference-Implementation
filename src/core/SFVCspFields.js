/** VQEG CSP snapshot fields (aligned with pilot ``CspFields`` / ``Observation.csp_fields``). */

const FIELD_KEYS = [
  'updated_at_s',
  'plan_downlink_mbps',
  'achieved_throughput_mbps',
  'rtt_ms',
  'loss_rate',
  'congestion_rate',
];

export function normalizeCspFields(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const key of FIELD_KEYS) {
    const v = raw[key];
    out[key] = v === undefined ? null : v;
  }
  if (out.updated_at_s !== null && !Number.isFinite(out.updated_at_s)) {
    throw new TypeError('csp_fields.updated_at_s must be a finite number when present');
  }
  for (const key of FIELD_KEYS) {
    if (key === 'updated_at_s') continue;
    const v = out[key];
    if (v !== null && !Number.isFinite(v)) {
      throw new TypeError(`csp_fields.${key} must be a finite number or null`);
    }
  }
  return Object.freeze(out);
}

export function cspFieldsEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return FIELD_KEYS.every((key) => a[key] === b[key]);
}
