import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActivityPanel } from "./ActivityPanel";

const event = {
  id: "activity-1",
  occurredAt: "2026-09-06T10:32:14Z",
  actorUserId: "user-1",
  actorName: "Reception Desk",
  actorUsername: "desk",
  actorRole: "receptionist",
  action: "session_item_added",
  category: "inventory" as const,
  entityType: "session",
  entityId: "session-1",
  entityLabel: "Playstation · Vansh Jalam",
  summary: "Added Herbal Flavour worth Rs 200.",
  details: { audit_id: "audit-1" },
  sourceKind: "audit_log" as const,
  legacy: false
};

function renderPanel(overrides: Partial<Parameters<typeof ActivityPanel>[0]> = {}) {
  const props: Parameters<typeof ActivityPanel>[0] = {
    events: [event],
    users: [{ id: "user-1", name: "Reception Desk", username: "desk", role: "receptionist", active: true }],
    filters: {},
    loading: false,
    loadingMore: false,
    error: "",
    hasMore: false,
    remote: true,
    onApplyFilters: vi.fn(),
    onRefresh: vi.fn(),
    onLoadMore: vi.fn(),
    ...overrides
  };
  return { props, ...render(<ActivityPanel {...props} />) };
}

describe("ActivityPanel", () => {
  it("shows who, what, exact IST time, and record identity", () => {
    renderPanel();
    expect(screen.getByText("Added Herbal Flavour worth Rs 200.")).toBeInTheDocument();
    expect(screen.getAllByText(/Reception Desk/)).toHaveLength(2);
    expect(screen.getByText(/Playstation · Vansh Jalam/)).toBeInTheDocument();
    expect(screen.getAllByText(/IST/).length).toBeGreaterThan(0);
    expect(screen.getByText("Server activity")).toBeInTheDocument();
  });

  it("keeps search focused while typing and applies filters only on submit", () => {
    const { props } = renderPanel();
    const search = screen.getByPlaceholderText("Customer, bill, action, session, item...");
    search.focus();
    fireEvent.change(search, { target: { value: "Vansh" } });

    expect(search).toHaveFocus();
    expect(props.onApplyFilters).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(props.onApplyFilters).toHaveBeenCalledWith(expect.objectContaining({ search: "Vansh" }));
  });

  it("exposes retry and cursor pagination controls", () => {
    const { props } = renderPanel({ hasMore: true, error: "Read failed" });
    expect(screen.getByRole("alert")).toHaveTextContent("Read failed");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(props.onRefresh).toHaveBeenCalledTimes(1);
  });
});
