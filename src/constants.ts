import type { Role, TabId } from "./types";

export const DEFAULT_INVENTORY_CATEGORIES = ["Beverages", "Food", "Refill Sheesha", "Arcade", "Cigarettes"];

const CATEGORY_ICONS: Record<string, string> = {
  Beverages: "🍶",
  Food: "🍽️",
  Cigarettes: "🚬",
  "Refill Sheesha": "🏺",
  "Herbal Pot": "🏺",
  Arcade: "🎮"
};

export function getCategoryIcon(category: string): string {
  return CATEGORY_ICONS[category] ?? "📦";
}
export const DEFAULT_EXPENSE_CATEGORIES = ["Utilities", "Rent", "Internet", "Salary", "Supplies", "Maintenance"];

export const tabsByRole: Record<Role, Array<{ id: TabId; label: string }>> = {
  admin: [
    { id: "dashboard", label: "Live Dashboard" },
    { id: "sale", label: "Consumables Tab" },
    { id: "inventory", label: "Inventory" },
    { id: "bills", label: "Bill Register" },
    { id: "reports", label: "Analytics" },
    { id: "customers", label: "Customer Profiles" },
    { id: "settings", label: "Settings" },
    { id: "users", label: "Users" }
  ],
  manager: [
    { id: "dashboard", label: "Live Dashboard" },
    { id: "sale", label: "Consumables Tab" },
    { id: "inventory", label: "Inventory" },
    { id: "bills", label: "Bill Register" },
    { id: "reports", label: "Analytics" },
    { id: "settings", label: "Settings" }
  ],
  receptionist: [
    { id: "dashboard", label: "Live Dashboard" },
    { id: "sale", label: "Consumables Tab" },
    { id: "bills", label: "Bill Register" }
  ]
};

/** All tabs that can be granted to a user beyond their role default. */
export const ALL_TABS: Array<{ id: TabId; label: string }> = [
  { id: "dashboard", label: "Live Dashboard" },
  { id: "sale", label: "Consumables Tab" },
  { id: "inventory", label: "Inventory" },
  { id: "bills", label: "Bill Register" },
  { id: "reports", label: "Analytics" },
  { id: "customers", label: "Customer Profiles" },
  { id: "settings", label: "Settings" },
  { id: "users", label: "Users" }
];
