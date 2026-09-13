import { isDeepStrictEqual } from "node:util";

export function sameJsonValue(left, right) {
  return isDeepStrictEqual(left, right);
}
