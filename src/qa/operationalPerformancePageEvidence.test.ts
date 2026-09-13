import { describe, expect, it } from "vitest";
import { parsePostgrestPageEvidence } from "./operationalPerformancePageEvidence";

describe("PostgREST page evidence parser", () => {
  it("derives sanitized page boundaries from Supabase offset/limit URLs", () => {
    expect(parsePostgrestPageEvidence(
      "https://staging.example/rest/v1/stock_movements?select=id%2Cmovement_at&organization_id=eq.org-primary&order=movement_at.desc.nullslast%2Cid.desc&offset=0&limit=1000",
      "return=representation,count=exact",
      "0-999/1506"
    )).toEqual({
      requestOffset: "0",
      requestLimit: "1000",
      contentRange: "0-999/1506",
      exactCountRequested: true
    });

    expect(parsePostgrestPageEvidence(
      "https://staging.example/rest/v1/stock_movements?offset=1000&limit=1000",
      "count=exact",
      "1000-1505/1506"
    )).toEqual({
      requestOffset: "1000",
      requestLimit: "1000",
      contentRange: "1000-1505/1506",
      exactCountRequested: true
    });
  });

  it("accepts the empty exact-count shape without retaining other headers", () => {
    expect(parsePostgrestPageEvidence(
      "https://staging.example/rest/v1/stock_movements?offset=0&limit=1000",
      "count=exact",
      "*/0"
    )).toEqual({
      requestOffset: "0",
      requestLimit: "1000",
      contentRange: "*/0",
      exactCountRequested: true
    });
  });

  it("nulls malformed or absent page metadata and rejects non-exact preference", () => {
    expect(parsePostgrestPageEvidence(
      "https://staging.example/rest/v1/stock_movements?offset=-1&limit=0",
      "return=representation",
      "invalid content range"
    )).toEqual({
      requestOffset: null,
      requestLimit: null,
      contentRange: null,
      exactCountRequested: false
    });
  });
});
