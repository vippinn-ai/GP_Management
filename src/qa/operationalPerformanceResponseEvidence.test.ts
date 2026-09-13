import { describe, expect, it } from "vitest";
import { readDecodedResponseBody } from "./operationalPerformanceResponseEvidence";

describe("operational performance decoded response evidence", () => {
  it("records decoded bytes and parsed JSON without using wire length", async () => {
    const body = new TextEncoder().encode('[{"version":736}]');

    await expect(readDecodedResponseBody(async () => body, true)).resolves.toEqual({
      body,
      bodyBytes: body.byteLength,
      parsedJson: [{ version: 736 }]
    });
  });

  it("fails closed when the response body cannot be read", async () => {
    await expect(readDecodedResponseBody(async () => {
      throw new Error("transport detail must not leak");
    }, false)).resolves.toEqual({
      body: null,
      bodyBytes: -1,
      error: "response-body-unavailable"
    });
  });

  it("fails closed when required JSON is malformed", async () => {
    const body = new TextEncoder().encode("not-json");

    await expect(readDecodedResponseBody(async () => body, true)).resolves.toEqual({
      body,
      bodyBytes: -1,
      error: "response-json-invalid"
    });
  });
});
