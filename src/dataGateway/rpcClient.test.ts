import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationalMutation } from "../operationalSync";
import { clearCachedNormalizedOrganizationIdForTests } from "./normalizedOrganization";
import {
  buildOperationalRpcPayload,
  getOperationalRpcFunctionName,
  invokeOperationalMutationRpc,
  mapOperationalRpcResult,
  type OperationalRpcError
} from "./rpcClient";

function createMutation(overrides: Partial<OperationalMutation> = {}): OperationalMutation {
  return {
    id: "op-1",
    kind: "addCustomerTabItem",
    label: "Add Coke",
    userId: "user-1",
    createdAt: "2026-06-20T10:00:00.000Z",
    baseVersion: 42,
    status: "pending",
    entityType: "customer_tab",
    entityId: "tab-1",
    payload: {
      customerTabId: "tab-1",
      quantityDelta: 1,
      line: {
        id: "line-1",
        inventoryItemId: "item-coke",
        name: "Coke",
        quantity: 1,
        unitPrice: 40,
        addedAt: "2026-06-20T10:00:00.000Z"
      },
      auditLog: {
        id: "audit-1",
        action: "customer_tab_item_added",
        entityType: "customer_tab",
        entityId: "tab-1",
        message: "Added Coke.",
        createdAt: "2026-06-20T10:00:00.000Z",
        userId: "user-1"
      }
    },
    ...overrides
  };
}

describe("operational RPC client", () => {
  beforeEach(() => {
    clearCachedNormalizedOrganizationIdForTests();
  });

  it("maps operational mutation kinds to stable RPC function names", () => {
    expect(getOperationalRpcFunctionName("startSession")).toBe("start_session");
    expect(getOperationalRpcFunctionName("pauseSession")).toBe("pause_session");
    expect(getOperationalRpcFunctionName("resumeSession")).toBe("resume_session");
    expect(getOperationalRpcFunctionName("addSessionItem")).toBe("add_session_item");
    expect(getOperationalRpcFunctionName("removeSessionItem")).toBe("remove_session_item");
    expect(getOperationalRpcFunctionName("hopSession")).toBe("hop_session");
    expect(getOperationalRpcFunctionName("rejectSession")).toBe("reject_session");
    expect(getOperationalRpcFunctionName("repeatSessionCombo")).toBe("repeat_session_combo");
    expect(getOperationalRpcFunctionName("openCustomerTab")).toBe("open_customer_tab");
    expect(getOperationalRpcFunctionName("linkCustomerTabContinuation")).toBe("link_customer_tab_continuation");
    expect(getOperationalRpcFunctionName("applyCustomerTabCombo")).toBe("apply_customer_tab_combo");
    expect(getOperationalRpcFunctionName("addCustomerTabItem")).toBe("add_customer_tab_item");
    expect(getOperationalRpcFunctionName("updateCustomerTabItemQuantity")).toBe("update_customer_tab_item_quantity");
    expect(getOperationalRpcFunctionName("removeCustomerTabItem")).toBe("remove_customer_tab_item");
    expect(getOperationalRpcFunctionName("rejectCustomerTab")).toBe("reject_customer_tab");
    expect(getOperationalRpcFunctionName("saveLiveSessionDetails")).toBe("save_live_session_details");
    expect(getOperationalRpcFunctionName("saveLiveCustomerTabDetails")).toBe("save_live_customer_tab_details");
  });

  it("builds a compact RPC envelope from an operational mutation", () => {
    const mutation = createMutation();

    expect(buildOperationalRpcPayload(mutation, "org-primary")).toEqual({
      organization_id: "org-primary",
      mutation_id: "op-1",
      mutation_kind: "addCustomerTabItem",
      label: "Add Coke",
      entity_type: "customer_tab",
      entity_id: "tab-1",
      user_id: "user-1",
      client_created_at: "2026-06-20T10:00:00.000Z",
      base_app_state_version: 42,
      payload: mutation.payload
    });
  });

  it("invokes the mapped Supabase RPC with payload jsonb", async () => {
    const mutation = createMutation();
    const rpc = vi.fn().mockResolvedValue({
      data: {
        mutation_id: "op-1",
        organization_id: "org-primary",
        entity_type: "customer_tab",
        entity_id: "tab-1",
        event_id: "event-1",
        server_time: "2026-06-20T10:00:01.000Z",
        app_state_version: 43,
        server_duration_ms: "125.25",
        changed_rows: { customer_tabs: ["tab-1"] }
      },
      error: null
    });
    const client = { rpc };

    await expect(
      invokeOperationalMutationRpc(mutation, {
        organizationId: "org-primary",
        client: client as never
      })
    ).resolves.toEqual({
      mutationId: "op-1",
      rpcName: "add_customer_tab_item",
      organizationId: "org-primary",
      entityType: "customer_tab",
      entityId: "tab-1",
      eventId: "event-1",
      serverTime: "2026-06-20T10:00:01.000Z",
      appStateVersion: 43,
      serverDurationMs: 125.25,
      changedRows: { customer_tabs: ["tab-1"] },
      raw: {
        mutation_id: "op-1",
        organization_id: "org-primary",
        entity_type: "customer_tab",
        entity_id: "tab-1",
        event_id: "event-1",
        server_time: "2026-06-20T10:00:01.000Z",
        app_state_version: 43,
        server_duration_ms: "125.25",
        changed_rows: { customer_tabs: ["tab-1"] }
      }
    });
    expect(rpc).toHaveBeenCalledWith("add_customer_tab_item", {
      payload: buildOperationalRpcPayload(mutation, "org-primary")
    });
  });

  it("resolves organization once when the caller does not provide an organization id", async () => {
    const mutation = createMutation();
    const maybeSingle = vi.fn().mockResolvedValue({ data: { id: "org-primary" }, error: null });
    const limit = vi.fn(() => ({ maybeSingle }));
    const order = vi.fn(() => ({ limit }));
    const eq = vi.fn(() => ({ order }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    const rpc = vi.fn().mockResolvedValue({
      data: {
        mutation_id: "op-1",
        organization_id: "org-primary",
        entity_type: "customer_tab",
        entity_id: "tab-1"
      },
      error: null
    });
    const client = { from, rpc };

    await invokeOperationalMutationRpc(mutation, { client: client as never });
    await invokeOperationalMutationRpc(mutation, { client: client as never });

    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith("organizations");
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenLastCalledWith("add_customer_tab_item", {
      payload: buildOperationalRpcPayload(mutation, "org-primary")
    });
  });

  it("maps sparse RPC responses back to the mutation identity", () => {
    const mutation = createMutation();

    expect(
      mapOperationalRpcResult({
        data: null,
        mutation,
        organizationId: "org-primary",
        rpcName: "add_customer_tab_item"
      })
    ).toMatchObject({
      mutationId: "op-1",
      rpcName: "add_customer_tab_item",
      organizationId: "org-primary",
      entityType: "customer_tab",
      entityId: "tab-1"
    });
  });

  it("throws a stable operational RPC error when Supabase rejects the call", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: "station_occupied",
        message: "This station was started on another device.",
        details: "station-1"
      }
    });

    await expect(
      invokeOperationalMutationRpc(createMutation({ kind: "startSession", entityType: "session", entityId: "session-1" }), {
        organizationId: "org-primary",
        client: { rpc } as never
      })
    ).rejects.toMatchObject({
      name: "OperationalRpcError",
      code: "station_occupied",
      rpcName: "start_session",
      mutationId: "op-1",
      details: "station-1"
    } satisfies Partial<OperationalRpcError>);
  });

  it("prefers structured RPC error details from Postgres exceptions", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: "P0001",
        message: "This station was started on another device.",
        details: JSON.stringify({
          code: "station_occupied",
          message: "This station was started on another device.",
          details: {
            station_id: "station-1",
            station_name: "Pool Table"
          }
        })
      }
    });

    await expect(
      invokeOperationalMutationRpc(createMutation({ kind: "startSession", entityType: "session", entityId: "session-1" }), {
        organizationId: "org-primary",
        client: { rpc } as never
      })
    ).rejects.toMatchObject({
      name: "OperationalRpcError",
      code: "station_occupied",
      message: "This station was started on another device.",
      rpcName: "start_session",
      mutationId: "op-1",
      details: JSON.stringify({
        station_id: "station-1",
        station_name: "Pool Table"
      })
    } satisfies Partial<OperationalRpcError>);
  });
});
