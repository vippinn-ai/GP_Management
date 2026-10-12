import { describe, expect, it } from "vitest";
import { validateRaceQueues } from "./hopMutationRace";

const conflict = { id: "op-loser", kind: "pauseSession", status: "conflict", entityType: "session", entityId: "session-race" };
const args = { origin: [], observer: [conflict], status: 400, rejectionCode: "session_not_open", mutationId: "op-loser", mutationKind: "pauseSession", sessionId: "session-race" };
describe("race scenario queue isolation", () => {
  it("accepts both successful empty queues", () => {
    expect(validateRaceQueues({ ...args, status: 200, observer: [] })).toEqual([]);
  });
  it.each(["saveLiveSessionDetails", "pauseSession", "resumeSession", "addSessionItem", "removeSessionItem"])("preserves exact expected %s conflict without clearing or exposing payload", (kind) => {
    const input = { ...args, mutationKind: kind, observer: [{ ...conflict, kind, payload: { private: "not evidence" } }] };
    const before = structuredClone(input);
    expect(validateRaceQueues(input)).toEqual([{ ...conflict, kind }]);
    expect(input).toEqual(before);
  });
  it.each(["id", "kind", "status", "entityType", "entityId"])("rejects mismatched conflict %s", (key) => {
    expect(() => validateRaceQueues({ ...args, observer: [{ ...conflict, [key]: "unexpected" }] })).toThrow();
  });
  it.each([[], [conflict, conflict], null, { invalidJson: "invalid" }, [null]])("rejects missing, duplicate or malformed conflicts %j", (observer) => {
    expect(() => validateRaceQueues({ ...args, observer })).toThrow();
  });
  it("rejects a residual winner queue or residual successful competitor", () => {
    expect(() => validateRaceQueues({ ...args, origin: [conflict] })).toThrow();
    expect(() => validateRaceQueues({ ...args, status: 200 })).toThrow();
  });
  it("rejects unexpected status, rejection code and missing command identity", () => {
    expect(() => validateRaceQueues({ ...args, status: 500 })).toThrow();
    expect(() => validateRaceQueues({ ...args, rejectionCode: "invalid_session_timing" })).toThrow();
    expect(() => validateRaceQueues({ ...args, mutationId: "" })).toThrow();
  });
});
