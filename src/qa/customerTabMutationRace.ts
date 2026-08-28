export const CUSTOMER_TAB_MUTATION_MODES = [
  "add_item",
  "update_item",
  "remove_item",
  "apply_combo"
] as const;

export const CUSTOMER_TAB_MUTATION_SCENARIOS = [
  "checkout_first",
  "mutation_first",
  "simultaneous"
] as const;

export type CustomerTabMutationMode = typeof CUSTOMER_TAB_MUTATION_MODES[number];
export type CustomerTabMutationScenario = typeof CUSTOMER_TAB_MUTATION_SCENARIOS[number];
export type CustomerTabMutationRacePhase = "all" | "remaining-eleven";
export type CustomerTabMutationRaceCase = {
  mode: CustomerTabMutationMode;
  scenario: CustomerTabMutationScenario;
};
export type CustomerTabRaceWinner = "checkout" | "mutation";

export type CustomerTabMutationContract = {
  rpc: string;
  mutationKind: string;
  eventType: string;
  auditAction: string | null;
  expectedAuditCount: 0 | 1;
  expectedReservationDelta: number;
  createsComboApplication: boolean;
};

export const CUSTOMER_TAB_MUTATION_CONTRACTS: Record<CustomerTabMutationMode, CustomerTabMutationContract> = {
  add_item: {
    rpc: "add_customer_tab_item",
    mutationKind: "addCustomerTabItem",
    eventType: "add_customer_tab_item",
    auditAction: "customer_tab_item_added",
    expectedAuditCount: 1,
    expectedReservationDelta: 1,
    createsComboApplication: false
  },
  update_item: {
    rpc: "update_customer_tab_item_quantity",
    mutationKind: "updateCustomerTabItemQuantity",
    eventType: "update_customer_tab_item_quantity",
    auditAction: null,
    expectedAuditCount: 0,
    expectedReservationDelta: 1,
    createsComboApplication: false
  },
  remove_item: {
    rpc: "remove_customer_tab_item",
    mutationKind: "removeCustomerTabItem",
    eventType: "remove_customer_tab_item",
    auditAction: "customer_tab_item_removed",
    expectedAuditCount: 1,
    expectedReservationDelta: -1,
    createsComboApplication: false
  },
  apply_combo: {
    rpc: "apply_customer_tab_combo",
    mutationKind: "applyCustomerTabCombo",
    eventType: "apply_customer_tab_combo",
    auditAction: "customer_tab_combo_applied",
    expectedAuditCount: 1,
    expectedReservationDelta: 1,
    createsComboApplication: true
  }
};

export function parseExactCustomerTabMutationModes(value: string | undefined): CustomerTabMutationMode[] {
  const parsed = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (
    parsed.length !== CUSTOMER_TAB_MUTATION_MODES.length ||
    parsed.some((entry, index) => entry !== CUSTOMER_TAB_MUTATION_MODES[index])
  ) {
    throw new Error("Customer-tab race modes must match the reviewed exact ordered selection.");
  }
  return parsed as CustomerTabMutationMode[];
}

export function parseExactCustomerTabMutationScenarios(value: string | undefined): CustomerTabMutationScenario[] {
  const parsed = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (
    parsed.length !== CUSTOMER_TAB_MUTATION_SCENARIOS.length ||
    parsed.some((entry, index) => entry !== CUSTOMER_TAB_MUTATION_SCENARIOS[index])
  ) {
    throw new Error("Customer-tab race scenarios must match the reviewed exact ordered selection.");
  }
  return parsed as CustomerTabMutationScenario[];
}

export function parseCustomerTabMutationRacePhase(value: string | undefined): CustomerTabMutationRacePhase {
  if (value === "all" || value === "remaining-eleven") return value;
  throw new Error("Customer-tab race phase must be exactly all or remaining-eleven.");
}

export function selectedCustomerTabMutationRaceCases(
  phase: CustomerTabMutationRacePhase
): CustomerTabMutationRaceCase[] {
  return CUSTOMER_TAB_MUTATION_MODES.flatMap((mode) =>
    CUSTOMER_TAB_MUTATION_SCENARIOS.map((scenario) => ({ mode, scenario }))
  ).filter(({ mode, scenario }) =>
    phase !== "remaining-eleven" || mode !== "add_item" || scenario !== "checkout_first"
  );
}

export function expectedCustomerTabRaceWinner(scenario: CustomerTabMutationScenario): CustomerTabRaceWinner | null {
  if (scenario === "checkout_first") return "checkout";
  if (scenario === "mutation_first") return "mutation";
  return null;
}

export function expectedCustomerTabRaceLoserCode(winner: CustomerTabRaceWinner) {
  return winner === "checkout" ? "customer_tab_not_open" : "source_item_mismatch";
}

export function classifyCustomerTabRaceResponses(
  checkoutStatus: number,
  mutationStatus: number
): CustomerTabRaceWinner {
  if (checkoutStatus === 200 && mutationStatus === 400) return "checkout";
  if (checkoutStatus === 400 && mutationStatus === 200) return "mutation";
  throw new Error(`Customer-tab race must have one HTTP 200 winner and one HTTP 400 loser; received ${checkoutStatus}/${mutationStatus}.`);
}
