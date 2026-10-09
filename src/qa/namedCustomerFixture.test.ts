import { describe, expect, it, vi } from "vitest";
import { namedCustomerFixture, verifyNamedCustomerFixture } from "./namedCustomerFixture";

const visitAt = "2026-10-09T10:00:00.000Z";
const identity = { restBase: "https://staging.invalid/rest/v1", headers: {} };
function fixture(rpc = "start_session") {
  const source = { id: "run-1-session", customerName: "QA run-1", customerPhone: "" };
  const command = { payload: { [rpc === "start_session" ? "session" : "tab"]: source, customer: namedCustomerFixture(source.id, source.customerName, visitAt) } };
  const row = { id: source.id, organization_id: "org-primary", customer_id: "canonical-customer", customer_name: source.customerName, customer_phone: null, raw_data: { customerId: "canonical-customer", customerName: source.customerName, customerPhone: "" } };
  const profile = { id: "canonical-customer", organization_id: "org-primary", name: source.customerName, phone: null };
  const request = { get: vi.fn().mockResolvedValueOnce({ status: () => 200, json: async () => [row] }).mockResolvedValueOnce({ status: () => 200, json: async () => [profile] }) };
  return { command, row, profile, request };
}
describe("named customer fixtures", () => {
  it("binds unique candidate identity and exact visit time", () => {
    expect(namedCustomerFixture("run-1", " QA one ", visitAt)).toEqual({ id: "run-1-customer", name: "QA one", phone: "", visitAt });
    expect(namedCustomerFixture("run-2", "QA two", visitAt).id).not.toBe(namedCustomerFixture("run-1", "QA one", visitAt).id);
  });
  it("carries the persisted source customer into each competing continuation", () => {
    for (const id of ["next-session", "next-tab"]) {
      expect(namedCustomerFixture(id, "QA chain", visitAt, { sourceIds: ["source"], customerId: "persisted-source-customer" }).id).toBe("persisted-source-customer");
    }
    expect(() => namedCustomerFixture("next", "QA chain", visitAt, { sourceIds: ["source"], customerId: undefined })).toThrow("canonical");
  });
  it("rejects a same-name continuation that persists a different customer ID", async () => {
    const f = fixture();
    const command = { payload: { ...f.command.payload, session: { ...f.command.payload.session, continuedFromSessionIds: ["source"] } } };
    await expect(verifyNamedCustomerFixture(f.request, identity, "org-primary", "start_session", command)).rejects.toThrow("source customer identity");
  });
  it.each([["", "QA", visitAt], ["run", " ", visitAt], ["run", "QA", "invalid"]])("rejects invalid identity inputs", (id, name, at) => {
    expect(() => namedCustomerFixture(id, name, at)).toThrow();
  });
  it.each(["start_session", "open_customer_tab"])("verifies persisted canonical source/profile for %s", async rpc => {
    const f = fixture(rpc);
    // The server may reuse a same-name profile rather than the requested new ID.
    expect(await verifyNamedCustomerFixture(f.request, identity, "org-primary", rpc, f.command)).toBe("canonical-customer");
    expect(f.request.get).toHaveBeenCalledTimes(2);
    expect(f.request.get.mock.calls[1][0]).toContain("id=eq.canonical-customer");
  });
  it.each(["start_session", "open_customer_tab"])("preserves canonical identity in a source-first %s continuation", async rpc => {
    const f = fixture(rpc);
    const key = rpc === "start_session" ? "session" : "tab";
    const command = { payload: { ...f.command.payload, [key]: { ...f.command.payload[key], continuedFromSessionIds: ["existing-source"] }, customer: namedCustomerFixture("next-consumer", "QA run-1", visitAt, { sourceIds: ["existing-source"], customerId: "canonical-customer" }) } };
    expect(await verifyNamedCustomerFixture(f.request, identity, "org-primary", rpc, command)).toBe("canonical-customer");
  });
  it.each(["missing profile", "wrong tenant", "wrong name", "missing link", "raw mismatch"])("fails closed: %s", async kind => {
    const f = fixture();
    if (kind === "missing profile") f.request.get.mockReset().mockResolvedValueOnce({ status: () => 200, json: async () => [f.row] }).mockResolvedValueOnce({ status: () => 200, json: async () => [] });
    if (kind === "wrong tenant") f.profile.organization_id = "other";
    if (kind === "wrong name") f.profile.name = "wrong";
    if (kind === "missing link") f.row.customer_id = "";
    if (kind === "raw mismatch") f.row.raw_data.customerId = "wrong";
    await expect(verifyNamedCustomerFixture(f.request, identity, "org-primary", "start_session", f.command)).rejects.toThrow();
  });
  it("does not alter anonymous fixture semantics or inspect unrelated RPCs", async () => {
    const request = { get: vi.fn() };
    await verifyNamedCustomerFixture(request, identity, "org-primary", "start_session", { payload: { session: { id: "anonymous" } } });
    await verifyNamedCustomerFixture(request, identity, "org-primary", "hop_session_v2", {});
    expect(request.get).not.toHaveBeenCalled();
  });
  it("rejects missing customer payload before any persistence reads", async () => {
    const f = fixture();
    await expect(verifyNamedCustomerFixture(f.request, identity, "org-primary", "start_session", { payload: { session: f.command.payload.session } })).rejects.toThrow("payload");
    expect(f.request.get).not.toHaveBeenCalled();
  });
  it.each(["source", "customer"])("rejects missing %s identity before reads", async part => {
    const f = fixture();
    if (part === "source") f.command.payload.session.id = "";
    else f.command.payload.customer.id = "";
    await expect(verifyNamedCustomerFixture(f.request, identity, "org-primary", "start_session", f.command)).rejects.toThrow("payload");
    expect(f.request.get).not.toHaveBeenCalled();
  });
});
