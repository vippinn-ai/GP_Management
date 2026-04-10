import type { AppData } from "./types";

export const seedAppData: AppData = {
  users: [
    {
      id: "user-admin",
      name: "Owner Admin",
      username: "admin",
      password: "admin123",
      role: "admin",
      active: true
    },
    {
      id: "user-manager",
      name: "Floor Manager",
      username: "manager",
      password: "manager123",
      role: "manager",
      active: true
    },
    {
      id: "user-reception",
      name: "Reception Desk",
      username: "reception",
      password: "reception123",
      role: "receptionist",
      active: true
    }
  ],
  businessProfile: {
    name: "BreakPerfect Gaming Lounge",
    logoText: "BP",
    address: "H2/17, 1st Floor, Rohini, Sec-11, Delhi -110085 (ABOVE CRISPY BITES)",
    primaryPhone: "+91 7011287542",
    secondaryPhone: "+91 9354898048",
    receiptFooter: "Thank you for visiting."
  },
  inventoryCategories: ["Beverages", "Food", "Refill Sheesha", "Arcade"],
  stations: [
    {
      id: "station-snooker-start",
      name: "Snooker Start Table",
      mode: "timed",
      active: true,
      ltpEnabled: true
    },
    {
      id: "station-snooker-sharma",
      name: "Snooker Sharma S-2",
      mode: "timed",
      active: true,
      ltpEnabled: true
    },
    {
      id: "station-pool-8",
      name: "8 Ball Pool",
      mode: "timed",
      active: true,
      ltpEnabled: false
    },
    {
      id: "station-playstation",
      name: "Playstation",
      mode: "timed",
      active: true,
      ltpEnabled: false
    }
  ],
  pricingRules: [
    {
      id: "pricing-start-day",
      stationId: "station-snooker-start",
      label: "Day",
      startMinute: 600,
      endMinute: 1260,
      hourlyRate: 400
    },
    {
      id: "pricing-start-night",
      stationId: "station-snooker-start",
      label: "Night",
      startMinute: 1260,
      endMinute: 600,
      hourlyRate: 500
    },
    {
      id: "pricing-sharma-day",
      stationId: "station-snooker-sharma",
      label: "Day",
      startMinute: 600,
      endMinute: 1260,
      hourlyRate: 300
    },
    {
      id: "pricing-sharma-night",
      stationId: "station-snooker-sharma",
      label: "Night",
      startMinute: 1260,
      endMinute: 600,
      hourlyRate: 400
    },
    {
      id: "pricing-pool-day",
      stationId: "station-pool-8",
      label: "Day",
      startMinute: 600,
      endMinute: 1260,
      hourlyRate: 200
    },
    {
      id: "pricing-pool-night",
      stationId: "station-pool-8",
      label: "Night",
      startMinute: 1260,
      endMinute: 600,
      hourlyRate: 300
    },
    {
      id: "pricing-playstation-day",
      stationId: "station-playstation",
      label: "Day",
      startMinute: 600,
      endMinute: 1260,
      hourlyRate: 200
    },
    {
      id: "pricing-playstation-night",
      stationId: "station-playstation",
      label: "Night",
      startMinute: 1260,
      endMinute: 600,
      hourlyRate: 300
    }
  ],
  sessions: [],
  sessionPauseLogs: [],
  customers: [],
  customerTabs: [],
  inventoryItems: [
    {
      id: "item-cold-drink",
      name: "Cold Drink",
      category: "Beverages",
      price: 40,
      stockQty: 24,
      lowStockThreshold: 6,
      unit: "piece",
      isReusable: false,
      barcode: "890000000001",
      active: true
    },
    {
      id: "item-herbal-sheesha",
      name: "Herbal Sheesha",
      category: "Refill Sheesha",
      price: 350,
      stockQty: 8,
      lowStockThreshold: 2,
      unit: "piece",
      isReusable: false,
      barcode: "890000000002",
      active: true
    },
    {
      id: "item-burger",
      name: "Burger",
      category: "Food",
      price: 180,
      stockQty: 12,
      lowStockThreshold: 4,
      unit: "piece",
      isReusable: false,
      barcode: "890000000003",
      active: true
    },
    {
      id: "item-redbull",
      name: "Red Bull",
      category: "Beverages",
      price: 130,
      stockQty: 18,
      lowStockThreshold: 5,
      unit: "piece",
      isReusable: false,
      barcode: "890000000004",
      active: true
    },
    {
      id: "item-sandwich",
      name: "Sandwich",
      category: "Food",
      price: 120,
      stockQty: 14,
      lowStockThreshold: 4,
      unit: "piece",
      isReusable: false,
      barcode: "890000000005",
      active: true
    },
    {
      id: "item-arcade-coins",
      name: "Arcade (2 coins)",
      category: "Arcade",
      price: 10,
      stockQty: 200,
      lowStockThreshold: 20,
      unit: "piece",
      isReusable: false,
      barcode: "890000000006",
      active: true
    }
  ],
  stockMovements: [],
  bills: [],
  payments: [],
  auditLogs: [],
  expenses: [],
  expenseTemplates: []
};
