export interface DecodedResponseBodyEvidence {
  body: Uint8Array | null;
  bodyBytes: number;
  parsedJson?: unknown;
  error?: "response-body-unavailable" | "response-json-invalid";
}

export interface CriticalResponseOutcome {
  status: number;
  api: boolean;
  javascript: boolean;
  bodyBytes: number;
}

export function isSuccessfulCriticalResponse(response: CriticalResponseOutcome): boolean {
  if (response.status < 200 || response.status >= 400) return false;
  if (!response.api && !response.javascript) return true;
  return response.status === 204 || response.status === 304 || response.bodyBytes > 0;
}

export async function readDecodedResponseBody(
  readBody: () => Promise<Uint8Array>,
  parseJson: boolean
): Promise<DecodedResponseBodyEvidence> {
  let body: Uint8Array;
  try {
    body = await readBody();
  } catch {
    return { body: null, bodyBytes: -1, error: "response-body-unavailable" };
  }

  if (!parseJson) return { body, bodyBytes: body.byteLength };
  try {
    return {
      body,
      bodyBytes: body.byteLength,
      parsedJson: JSON.parse(new TextDecoder().decode(body))
    };
  } catch {
    return { body, bodyBytes: -1, error: "response-json-invalid" };
  }
}
