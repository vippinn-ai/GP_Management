import { describe, expect, it } from "vitest";
import {
  evaluateStagingApiUrlAnchor,
  STAGING_API_URL,
  STAGING_PROJECT_REF,
  type StagingApiUrlAnchorState
} from "./stagingApiUrlAnchorModel";

const cleanState: StagingApiUrlAnchorState = {
  database: "postgres",
  organizationActive: true,
  apiUrl: null,
  identities: []
};

describe("staging API URL anchor decision model", () => {
  it("allows the missing-setting bootstrap", () => {
    expect(evaluateStagingApiUrlAnchor(cleanState)).toEqual({
      allowed: true,
      apiUrlAfter: STAGING_API_URL,
      idempotentRerun: false
    });
  });

  it("allows an exact-match rerun after success or an interrupted post-ALTER step", () => {
    expect(evaluateStagingApiUrlAnchor({ ...cleanState, apiUrl: STAGING_API_URL })).toEqual({
      allowed: true,
      apiUrlAfter: STAGING_API_URL,
      idempotentRerun: true
    });
  });

  it.each([
    `https://wrong.example/${STAGING_PROJECT_REF}`,
    `https://${STAGING_PROJECT_REF}.supabase.co.evil.example`,
    "https://rrdwbxvuwrbxefarxnse.supabase.co"
  ])("rejects a non-exact existing URL: %s", (apiUrl) => {
    expect(evaluateStagingApiUrlAnchor({ ...cleanState, apiUrl })).toEqual({ allowed: false, reason: "api_url" });
  });

  it("rejects a conflicting environment identity", () => {
    expect(evaluateStagingApiUrlAnchor({
      ...cleanState,
      identities: [{ environment: "production", projectRef: "rrdwbxvuwrbxefarxnse" }]
    })).toEqual({ allowed: false, reason: "environment_identity" });
  });

  it("accepts an exact staging identity on an idempotent rerun", () => {
    expect(evaluateStagingApiUrlAnchor({
      ...cleanState,
      apiUrl: STAGING_API_URL,
      identities: [{ environment: "staging", projectRef: STAGING_PROJECT_REF }]
    }).allowed).toBe(true);
  });

  it("rejects the wrong database or inactive organization", () => {
    expect(evaluateStagingApiUrlAnchor({ ...cleanState, database: "template1" })).toEqual({ allowed: false, reason: "database" });
    expect(evaluateStagingApiUrlAnchor({ ...cleanState, organizationActive: false })).toEqual({ allowed: false, reason: "organization" });
  });
});
