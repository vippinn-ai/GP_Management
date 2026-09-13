export interface PostgrestPageEvidence {
  requestOffset: string | null;
  requestLimit: string | null;
  contentRange: string | null;
  exactCountRequested: boolean;
}

function normalizedInteger(value: string | null, minimum: number): string | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? String(parsed) : null;
}

export function parsePostgrestPageEvidence(
  requestUrl: string,
  requestPrefer: string | undefined,
  responseContentRange: string | undefined
): PostgrestPageEvidence {
  const url = new URL(requestUrl);
  const contentRange = responseContentRange?.trim() ?? "";
  return {
    requestOffset: normalizedInteger(url.searchParams.get("offset"), 0),
    requestLimit: normalizedInteger(url.searchParams.get("limit"), 1),
    contentRange: /^(?:\d+-\d+|\*)\/\d+$/.test(contentRange) ? contentRange : null,
    exactCountRequested: requestPrefer?.split(",").some((value) => value.trim().toLowerCase() === "count=exact") === true
  };
}
