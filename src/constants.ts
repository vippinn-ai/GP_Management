import type { Role, TabId } from "./types";

export const DEFAULT_INVENTORY_CATEGORIES = ["Beverages", "Food", "Refill Sheesha", "Arcade"];
export const DEFAULT_EXPENSE_CATEGORIES = ["Utilities", "Rent", "Internet", "Salary", "Supplies", "Maintenance"];

export const tabsByRole: Record<Role, Array<{ id: TabId; label: string }>> = {
  admin: [
    { id: "dashboard", label: "Live Dashboard" },
    { id: "sale", label: "Consumables Tab" },
    { id: "inventory", label: "Inventory" },
    { id: "reports", label: "Reports" },
    { id: "customers", label: "Customer Profiles" },
    { id: "settings", label: "Settings" },
    { id: "users", label: "Users" }
  ],
  manager: [
    { id: "dashboard", label: "Live Dashboard" },
    { id: "sale", label: "Consumables Tab" },
    { id: "inventory", label: "Inventory" },
    { id: "reports", label: "Reports" },
    { id: "settings", label: "Settings" }
  ],
  receptionist: [
    { id: "dashboard", label: "Live Dashboard" },
    { id: "sale", label: "Consumables Tab" }
  ]
};
