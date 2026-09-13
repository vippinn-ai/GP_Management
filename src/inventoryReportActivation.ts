import type {
  AppData,
  Bill,
  CustomerTab,
  InventoryItem,
  InventoryReportModel,
  Session
} from "./types";
import { buildInventoryReportModel, filterInventoryReportModel } from "./utils";

export const EMPTY_INVENTORY_REPORT_MODEL: InventoryReportModel = {
  summary: {
    added: 0,
    deducted: 0,
    manualAdjustments: 0,
    reversals: 0,
    netChange: 0,
    reserved: 0,
    touchedItems: 0
  },
  rows: [],
  details: []
};

export function buildClientInventoryReportForActiveView(options: {
  active: boolean;
  inventoryItems: InventoryItem[];
  stockMovements: AppData["stockMovements"];
  sessions: Session[];
  customerTabs: CustomerTab[];
  bills: Bill[];
  fromDate: string;
  toDate: string;
  search: string;
}): InventoryReportModel {
  if (!options.active) {
    return EMPTY_INVENTORY_REPORT_MODEL;
  }

  return filterInventoryReportModel(
    buildInventoryReportModel(
      options.inventoryItems,
      options.stockMovements,
      options.sessions,
      options.customerTabs,
      options.bills,
      options.fromDate,
      options.toDate
    ),
    options.search
  );
}
