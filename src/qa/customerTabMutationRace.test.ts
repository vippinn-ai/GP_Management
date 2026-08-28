import { describe, expect, it } from "vitest";
import {
  CUSTOMER_TAB_MUTATION_CONTRACTS,
  CUSTOMER_TAB_MUTATION_MODES,
  CUSTOMER_TAB_MUTATION_SCENARIOS,
  classifyCustomerTabRaceResponses,
  expectedCustomerTabRaceLoserCode,
  expectedCustomerTabRaceWinner,
  parseCustomerTabMutationRacePhase,
  parseExactCustomerTabMutationModes,
  parseExactCustomerTabMutationScenarios,
  selectedCustomerTabMutationRaceCases
} from "./customerTabMutationRace";

describe("customer-tab mutation race contract", () => {
  it("binds all four distinct operational RPCs in reviewed order", () => {
    expect(CUSTOMER_TAB_MUTATION_MODES).toEqual(["add_item", "update_item", "remove_item", "apply_combo"]);
    expect(Object.values(CUSTOMER_TAB_MUTATION_CONTRACTS).map(({ rpc }) => rpc)).toEqual([
      "add_customer_tab_item",
      "update_customer_tab_item_quantity",
      "remove_customer_tab_item",
      "apply_customer_tab_combo"
    ]);
    expect(new Set(Object.values(CUSTOMER_TAB_MUTATION_CONTRACTS).map(({ mutationKind }) => mutationKind)).size).toBe(4);
  });

  it("records SQL-accurate audit and logical reservation effects", () => {
    expect(CUSTOMER_TAB_MUTATION_CONTRACTS.add_item).toMatchObject({ expectedAuditCount: 1, expectedReservationDelta: 1 });
    expect(CUSTOMER_TAB_MUTATION_CONTRACTS.update_item).toMatchObject({ expectedAuditCount: 0, expectedReservationDelta: 1 });
    expect(CUSTOMER_TAB_MUTATION_CONTRACTS.remove_item).toMatchObject({ expectedAuditCount: 1, expectedReservationDelta: -1 });
    expect(CUSTOMER_TAB_MUTATION_CONTRACTS.apply_combo).toMatchObject({ expectedAuditCount: 1, expectedReservationDelta: 1, createsComboApplication: true });
  });

  it("fails closed unless every mode and ordering is exact", () => {
    expect(parseExactCustomerTabMutationModes(CUSTOMER_TAB_MUTATION_MODES.join(","))).toEqual(CUSTOMER_TAB_MUTATION_MODES);
    expect(parseExactCustomerTabMutationScenarios(CUSTOMER_TAB_MUTATION_SCENARIOS.join(","))).toEqual(CUSTOMER_TAB_MUTATION_SCENARIOS);
    expect(() => parseExactCustomerTabMutationModes("add_item,remove_item")).toThrow(/exact ordered selection/);
    expect(() => parseExactCustomerTabMutationModes("update_item,add_item,remove_item,apply_combo")).toThrow(/exact ordered selection/);
    expect(() => parseExactCustomerTabMutationScenarios("simultaneous")).toThrow(/exact ordered selection/);
  });

  it("selects only the eleven unexecuted cases for the reviewed remaining phase", () => {
    expect(parseCustomerTabMutationRacePhase("all")).toBe("all");
    expect(parseCustomerTabMutationRacePhase("remaining-eleven")).toBe("remaining-eleven");
    expect(() => parseCustomerTabMutationRacePhase(undefined)).toThrow(/exactly all or remaining-eleven/);
    expect(() => parseCustomerTabMutationRacePhase("remaining")).toThrow(/exactly all or remaining-eleven/);

    const all = selectedCustomerTabMutationRaceCases("all");
    const remaining = selectedCustomerTabMutationRaceCases("remaining-eleven");
    expect(all).toHaveLength(12);
    expect(remaining).toHaveLength(11);
    expect(remaining).not.toContainEqual({ mode: "add_item", scenario: "checkout_first" });
    expect(remaining).toEqual(all.slice(1));
  });

  it("requires exactly one canonical response winner", () => {
    expect(classifyCustomerTabRaceResponses(200, 400)).toBe("checkout");
    expect(classifyCustomerTabRaceResponses(400, 200)).toBe("mutation");
    expect(() => classifyCustomerTabRaceResponses(200, 200)).toThrow(/one HTTP 200 winner/);
    expect(() => classifyCustomerTabRaceResponses(400, 400)).toThrow(/one HTTP 200 winner/);
  });

  it("binds deterministic winner directions and stable loser codes", () => {
    expect(CUSTOMER_TAB_MUTATION_SCENARIOS.map(expectedCustomerTabRaceWinner)).toEqual(["checkout", "mutation", null]);
    expect(expectedCustomerTabRaceLoserCode("checkout")).toBe("customer_tab_not_open");
    expect(expectedCustomerTabRaceLoserCode("mutation")).toBe("source_item_mismatch");
  });
});
