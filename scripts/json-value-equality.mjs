import { isDeepStrictEqual } from "node:util";

export function sameJsonValue(left, right) {
  return isDeepStrictEqual(left, right);
}

function timestampInstantMicros(value) {
  if (typeof value !== "string") return undefined;
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/);
  if (!match) return undefined;
  const wholeSecondMs = Date.parse(`${match[1]}.000${match[3]}`);
  if (!Number.isFinite(wholeSecondMs)) return undefined;
  return BigInt(wholeSecondMs) * 1000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}

export function sameAppStateIdentity(left, right) {
  if (!left || typeof left !== "object" || Array.isArray(left) || !right || typeof right !== "object" || Array.isArray(right)) {
    return false;
  }
  const leftInstant = timestampInstantMicros(left.updated_at);
  const rightInstant = timestampInstantMicros(right.updated_at);
  if (leftInstant === undefined || rightInstant === undefined || leftInstant !== rightInstant) return false;
  const { updated_at: _leftUpdatedAt, ...leftRest } = left;
  const { updated_at: _rightUpdatedAt, ...rightRest } = right;
  return isDeepStrictEqual(leftRest, rightRest);
}
