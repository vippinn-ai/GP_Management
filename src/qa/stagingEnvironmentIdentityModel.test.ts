import { describe, expect, it } from "vitest";
import {
  evaluateStagingEnvironmentIdentity,
  STAGING_PROJECT_REF,
  STAGING_SYSTEM_IDENTIFIER,
  type StagingEnvironmentState
} from "./stagingEnvironmentIdentityModel";

const cleanState: StagingEnvironmentState = {
  database: "postgres",
  systemIdentifier: STAGING_SYSTEM_IDENTIFIER,
  organizationActive: true,
  identities: []
};

describe("staging environment identity decision model", () => {
  it("allows the first atomic identity installation on the exact physical staging cluster", () => {
    expect(evaluateStagingEnvironmentIdentity(cleanState)).toEqual({ allowed: true, idempotentRerun: false });
  });

  it("allows an exact staging identity rerun", () => {
    expect(evaluateStagingEnvironmentIdentity({
      ...cleanState,
      identities: [{ environment: "staging", projectRef: STAGING_PROJECT_REF }]
    })).toEqual({ allowed: true, idempotentRerun: true });
  });

  it("rejects another physical database even when its logical shape matches", () => {
    expect(evaluateStagingEnvironmentIdentity({
      ...cleanState,
      systemIdentifier: "7623125441096521076"
    })).toEqual({ allowed: false, reason: "system_identifier" });
  });

  it("rejects a conflicting environment identity", () => {
    expect(evaluateStagingEnvironmentIdentity({
      ...cleanState,
      identities: [{ environment: "production", projectRef: "rrdwbxvuwrbxefarxnse" }]
    })).toEqual({ allowed: false, reason: "environment_identity" });
  });

  it("rejects the wrong database or inactive organization", () => {
    expect(evaluateStagingEnvironmentIdentity({ ...cleanState, database: "template1" })).toEqual({ allowed: false, reason: "database" });
    expect(evaluateStagingEnvironmentIdentity({ ...cleanState, organizationActive: false })).toEqual({ allowed: false, reason: "organization" });
  });
});
