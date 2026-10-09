import { expect, it } from "vitest";
import { captureRpcResponse, type RpcEvidence } from "./rpcEvidenceCollector";

const response = (json: () => Promise<unknown>) => ({ url: () => "https://staging.invalid/rest/v1/rpc/commit_checkout_bill_v2", request: () => ({ method: () => "POST" }), status: () => 400, json });
it("retains rejection code before a failing status assertion without raw private fields", async () => {
  const evidence: RpcEvidence[] = [];
  const r = response(async () => ({ code: "P0001", details: JSON.stringify({ code: "invalid_customer_scope", details: { bill_id: "bill-qa", session_id: "session-qa", mutation_id: "mutation-qa", private: "secret" } }), message: "secret", hint: "secret" }));
  await captureRpcResponse(r, "origin", evidence);
  expect(() => expect(r.status()).toBe(200)).toThrow();
  expect(evidence[0]).toMatchObject({ status: 400, errorCode: "invalid_customer_scope", sqlState: "P0001", rpc: "commit_checkout_bill_v2", billId: "bill-qa", entityId: "session-qa", mutationId: "mutation-qa" });
  expect(JSON.stringify(evidence)).not.toContain("secret");
});
it("keeps status for unreadable bodies", async () => {
  const evidence: RpcEvidence[] = [];
  await captureRpcResponse(response(async () => { throw new Error("secret"); }), "origin", evidence);
  expect(evidence[0]).toMatchObject({ status: 400, bodyReadFailed: true });
});
it("discards adversarial success fields in an error envelope", async () => {
  const evidence: RpcEvidence[] = [];
  await captureRpcResponse(response(async () => ({ code: "P0001", entity_id: "secret", bill_id: "secret", mutation_id: "secret", bill_number: "secret", event_id: "secret", server_time: "secret", changed_rows: { token: "secret" }, message: "secret", hint: "secret" })), "origin", evidence);
  expect(JSON.stringify(evidence)).not.toContain("secret");
  expect(evidence[0]).toMatchObject({ rpc: "commit_checkout_bill_v2", status: 400, sqlState: "P0001" });
});
it("bounds a hung body without leaking a late rejection", async () => {
  const evidence: RpcEvidence[] = [];
  await captureRpcResponse(response(() => new Promise(() => {})), "origin", evidence, 5);
  expect(evidence[0]).toMatchObject({ status: 400, bodyReadFailed: true });
});
