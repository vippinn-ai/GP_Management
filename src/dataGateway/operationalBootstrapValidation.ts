type ValueValidator = (value: unknown, label: string) => void;
type RowValidator = (row: Record<string, unknown>, label: string) => void;

const recordValue: ValueValidator = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Operational bootstrap returned an invalid ${label}.`);
  }
};

const textValue: ValueValidator = (value, label) => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Operational bootstrap returned an invalid ${label}.`);
  }
};

const stringValue: ValueValidator = (value, label) => {
  if (typeof value !== "string") {
    throw new Error(`Operational bootstrap returned an invalid ${label}.`);
  }
};

const booleanValue: ValueValidator = (value, label) => {
  if (typeof value !== "boolean") {
    throw new Error(`Operational bootstrap returned an invalid ${label}.`);
  }
};

const finiteNumber: ValueValidator = (value, label) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Operational bootstrap returned an invalid ${label}.`);
  }
};

const nonNegativeNumber: ValueValidator = (value, label) => {
  finiteNumber(value, label);
  if ((value as number) < 0) throw new Error(`Operational bootstrap returned an invalid ${label}.`);
};

const positiveNumber: ValueValidator = (value, label) => {
  finiteNumber(value, label);
  if ((value as number) <= 0) throw new Error(`Operational bootstrap returned an invalid ${label}.`);
};

const positiveInteger: ValueValidator = (value, label) => {
  positiveNumber(value, label);
  if (!Number.isInteger(value)) throw new Error(`Operational bootstrap returned an invalid ${label}.`);
};

const timestampValue: ValueValidator = (value, label) => {
  textValue(value, label);
  if (Number.isNaN(Date.parse(value as string))) {
    throw new Error(`Operational bootstrap returned an invalid ${label}.`);
  }
};

const optional = (validator: ValueValidator): ValueValidator => (value, label) => {
  if (value !== undefined) validator(value, label);
};

const nullable = (validator: ValueValidator): ValueValidator => (value, label) => {
  if (value !== null) validator(value, label);
};

const optionalNullable = (validator: ValueValidator): ValueValidator => optional(nullable(validator));

const oneOf = (...allowed: string[]): ValueValidator => (value, label) => {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`Operational bootstrap returned an invalid ${label}.`);
  }
};

const stringArray: ValueValidator = (value, label) => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`Operational bootstrap returned an invalid ${label}.`);
  }
};

const tabId = oneOf(
  "dashboard", "sale", "inventory", "bills", "reports", "customers", "activity", "settings", "users"
);
const tabIdArray: ValueValidator = (value, label) => {
  if (!Array.isArray(value)) throw new Error(`Operational bootstrap returned an invalid ${label}.`);
  value.forEach((entry, index) => tabId(entry, `${label}[${index}]`));
};

export function validateOperationalBootstrapTabPermissions(value: unknown, label: string) {
  optionalNullable(tabIdArray)(value, label);
}

function validateKnownFields(
  value: unknown,
  label: string,
  validators: Record<string, ValueValidator>,
  options: { nullable?: boolean; rejectUnexpected?: boolean } = {}
) {
  if (value === null && options.nullable) return;
  recordValue(value, label);
  const record = value as Record<string, unknown>;
  if (options.rejectUnexpected) {
    const unexpected = Object.keys(record).filter((key) => !(key in validators));
    if (unexpected.length > 0) {
      throw new Error(`Operational bootstrap returned unexpected ${label} fields.`);
    }
  }
  for (const [key, validator] of Object.entries(validators)) {
    validator(record[key], `${label}.${key}`);
  }
}

const recordArray = (
  validators: Record<string, ValueValidator>,
  options: { nullable?: boolean; rejectUnexpected?: boolean } = {}
): ValueValidator => (value, label) => {
  if (value === null && options.nullable) return;
  if (!Array.isArray(value)) throw new Error(`Operational bootstrap returned an invalid ${label}.`);
  value.forEach((entry, index) => validateKnownFields(entry, `${label}[${index}]`, validators, options));
};

const pricingRule = {
  id: textValue,
  stationId: textValue,
  label: textValue,
  startMinute: finiteNumber,
  endMinute: finiteNumber,
  hourlyRate: nonNegativeNumber
};

const comboInventorySelection = {
  inventoryItemId: textValue,
  saleVariantId: optionalNullable(textValue),
  name: textValue,
  sourceName: textValue,
  quantity: positiveNumber,
  unitPrice: nonNegativeNumber,
  stockUnitsPerSale: positiveNumber
};

const comboAppliedChoice = {
  groupId: textValue,
  groupLabel: textValue,
  selections: recordArray(comboInventorySelection),
  selection: optionalNullable((value, label) => validateKnownFields(value, label, comboInventorySelection))
};

const rawComboFixedItem = {
  id: textValue,
  sellableOptionId: textValue,
  quantity: positiveInteger
};

const rawComboChoiceGroup = {
  id: textValue,
  label: textValue,
  requiredQuantity: positiveInteger,
  optionIds: stringArray
};

function validateRawData(
  row: Record<string, unknown>,
  label: string,
  validators: Record<string, ValueValidator>
) {
  validateKnownFields(row.raw_data, `${label}.raw_data`, Object.fromEntries(
    Object.entries(validators).map(([key, validator]) => [key, optional(validator)])
  ));
}

const saleLineFields: Record<string, ValueValidator> = {
  id: textValue,
  inventory_item_id: nullable(textValue),
  name: textValue,
  quantity: positiveNumber,
  unit_price: nonNegativeNumber,
  added_at: nullable(timestampValue),
  sold_as_pack_of: nullable(positiveNumber),
  sale_variant_id: nullable(textValue),
  stock_units_per_sale: nullable(positiveNumber),
  combo_application_id: nullable(textValue),
  combo_id: nullable(textValue),
  raw_data: recordValue,
  created_at: timestampValue
};

const rawSaleLineFields: Record<string, ValueValidator> = {
  inventoryItemId: textValue,
  name: textValue,
  quantity: positiveNumber,
  unitPrice: nonNegativeNumber,
  addedAt: timestampValue,
  soldAsPackOf: nullable(positiveNumber),
  saleVariantId: nullable(textValue),
  stockUnitsPerSale: nullable(positiveNumber),
  comboApplicationId: nullable(textValue),
  comboId: nullable(textValue)
};

const comboApplicationFields: Record<string, ValueValidator> = {
  id: textValue,
  combo_id: nullable(textValue),
  combo_name: textValue,
  price: nonNegativeNumber,
  included_minutes: nonNegativeNumber,
  applied_at: nullable(timestampValue),
  fixed_items: recordArray(comboInventorySelection),
  choices: recordArray(comboAppliedChoice),
  raw_data: recordValue,
  created_at: timestampValue
};

const rawComboApplicationFields: Record<string, ValueValidator> = {
  comboId: textValue,
  comboName: textValue,
  price: nonNegativeNumber,
  includedMinutes: nonNegativeNumber,
  appliedAt: timestampValue,
  fixedItems: recordArray(comboInventorySelection),
  choices: recordArray(comboAppliedChoice)
};

function validateFields(row: Record<string, unknown>, label: string, validators: Record<string, ValueValidator>) {
  for (const [key, validator] of Object.entries(validators)) {
    validator(row[key], `${label}.${key}`);
  }
}

function withOrganization(validator: RowValidator): RowValidator {
  return (row, label) => {
    textValue(row.organization_id, `${label}.organization_id`);
    validator(row, label);
  };
}

const validators: Record<string, RowValidator> = {
  profiles: withOrganization((row, label) => validateFields(row, label, {
    id: textValue, name: textValue, username: textValue,
    role: oneOf("admin", "manager", "receptionist"), active: booleanValue,
    tabPermissions: nullable(tabIdArray)
  })),
  inventory_categories: withOrganization((row, label) => validateFields(row, label, { name: textValue })),
  stations: withOrganization((row, label) => {
    validateFields(row, label, {
      id: textValue, name: textValue, mode: oneOf("timed", "unit_sale"), active: booleanValue,
      ltp_enabled: booleanValue, notes: nullable(stringValue), raw_data: recordValue
    });
    validateRawData(row, label, {
      mode: oneOf("timed", "unit_sale"), active: booleanValue, ltpEnabled: booleanValue,
      notes: nullable(stringValue)
    });
  }),
  pricing_rules: withOrganization((row, label) => {
    validateFields(row, label, {
      id: textValue, station_id: nullable(textValue), label: textValue, start_minute: finiteNumber,
      end_minute: finiteNumber, hourly_rate: nonNegativeNumber, raw_data: recordValue
    });
    validateRawData(row, label, {
      stationId: textValue, label: textValue, startMinute: finiteNumber,
      endMinute: finiteNumber, hourlyRate: nonNegativeNumber
    });
  }),
  inventory_items: withOrganization((row, label) => {
    validateFields(row, label, {
      id: textValue, name: textValue, category: nullable(stringValue), price: nonNegativeNumber,
      stock_qty: finiteNumber, low_stock_threshold: nonNegativeNumber, unit: textValue,
      is_reusable: booleanValue, barcode: nullable(stringValue), active: booleanValue,
      archived_at: nullable(timestampValue), archived_by_user_id: nullable(textValue),
      archive_reason: nullable(stringValue), sell_base_item: booleanValue,
      cigarette_pack: nullable(recordValue), raw_data: recordValue
    });
    if (row.cigarette_pack !== null) {
      validateKnownFields(row.cigarette_pack, `${label}.cigarette_pack`, {
        size: positiveInteger, packPrice: nonNegativeNumber
      }, { rejectUnexpected: true });
    }
    validateRawData(row, label, {
      category: nullable(stringValue), price: nonNegativeNumber, stockQty: finiteNumber,
      lowStockThreshold: nonNegativeNumber, unit: textValue, isReusable: booleanValue,
      barcode: nullable(stringValue), active: booleanValue, archivedAt: nullable(timestampValue),
      archivedByUserId: nullable(textValue), archiveReason: nullable(stringValue), sellBaseItem: booleanValue
    });
  }),
  sale_variants: withOrganization((row, label) => {
    validateFields(row, label, {
      inventory_item_id: textValue, id: textValue, name: textValue, price: nonNegativeNumber,
      stock_units_per_sale: positiveNumber, barcode: nullable(stringValue), active: booleanValue,
      raw_data: recordValue
    });
    validateRawData(row, label, {
      name: textValue, price: nonNegativeNumber, stockUnitsPerSale: positiveNumber,
      barcode: nullable(stringValue), active: booleanValue
    });
  }),
  combos: withOrganization((row, label) => {
    validateFields(row, label, {
      id: textValue, name: textValue, type: oneOf("game", "consumables"), active: booleanValue,
      price: nonNegativeNumber, included_minutes: nonNegativeNumber, raw_data: recordValue,
      created_at: timestampValue, updated_at: timestampValue
    });
    validateRawData(row, label, {
      name: textValue, type: oneOf("game", "consumables"), active: booleanValue,
      price: nonNegativeNumber, includedMinutes: nonNegativeNumber, stationIds: stringArray,
      fixedItems: recordArray(rawComboFixedItem), choiceGroups: recordArray(rawComboChoiceGroup),
      createdAt: timestampValue, updatedAt: timestampValue
    });
  }),
  combo_station_targets: withOrganization((row, label) => validateFields(row, label, {
    combo_id: textValue, station_id: textValue
  })),
  combo_fixed_items: withOrganization((row, label) => {
    validateFields(row, label, {
      combo_id: textValue, id: textValue, sellable_option_id: textValue, quantity: positiveInteger,
      raw_data: recordValue, created_at: timestampValue
    });
    validateRawData(row, label, { sellableOptionId: textValue, quantity: positiveInteger });
  }),
  combo_choice_groups: withOrganization((row, label) => {
    validateFields(row, label, {
      combo_id: textValue, id: textValue, label: textValue, required_quantity: positiveInteger,
      raw_data: recordValue, created_at: timestampValue
    });
    validateRawData(row, label, {
      label: textValue, requiredQuantity: positiveInteger, optionIds: stringArray
    });
  }),
  combo_choice_options: withOrganization((row, label) => validateFields(row, label, {
    combo_id: textValue, choice_group_id: textValue, option_id: textValue
  })),
  sessions: withOrganization((row, label) => {
    validateFields(row, label, {
      id: textValue, station_id: nullable(textValue), station_name_snapshot: nullable(stringValue),
      mode: oneOf("timed", "unit_sale"), started_at: nullable(timestampValue), ended_at: nullable(timestampValue),
      status: oneOf("active", "paused", "closed"), customer_id: nullable(textValue),
      customer_name: nullable(stringValue), customer_phone: nullable(stringValue),
      play_mode: oneOf("group", "solo"), ltp_eligible: booleanValue,
      ltp_outcome: nullable(oneOf("won", "lost")), ltp_discount_applied: nullable(booleanValue),
      pricing_snapshot: recordArray(pricingRule), pause_log_ids: stringArray,
      continued_from_session_ids: nullable(stringArray), closed_bill_id: nullable(textValue),
      close_disposition: nullable(oneOf("billed", "rejected", "hopped")),
      close_reason: nullable(stringValue), raw_data: recordValue, created_at: timestampValue
    });
    validateRawData(row, label, {
      stationId: textValue, stationNameSnapshot: stringValue, mode: oneOf("timed", "unit_sale"),
      startedAt: timestampValue, endedAt: nullable(timestampValue), status: oneOf("active", "paused", "closed"),
      customerId: nullable(textValue), customerName: nullable(stringValue), customerPhone: nullable(stringValue),
      playMode: oneOf("group", "solo"), ltpEligible: booleanValue,
      ltpOutcome: nullable(oneOf("won", "lost")), ltpDiscountApplied: nullable(booleanValue),
      pricingSnapshot: recordArray(pricingRule), pauseLogIds: stringArray,
      continuedFromSessionIds: stringArray, closedBillId: nullable(textValue),
      closeDisposition: nullable(oneOf("billed", "rejected", "hopped")), closeReason: nullable(stringValue)
    });
  }),
  session_pause_logs: withOrganization((row, label) => {
    validateFields(row, label, {
      id: textValue, session_id: nullable(textValue), paused_at: nullable(timestampValue),
      resumed_at: nullable(timestampValue), raw_data: recordValue, created_at: timestampValue
    });
    validateRawData(row, label, {
      sessionId: textValue, pausedAt: timestampValue, resumedAt: nullable(timestampValue)
    });
  }),
  session_items: withOrganization((row, label) => {
    validateFields(row, label, { session_id: textValue, ...saleLineFields });
    validateRawData(row, label, rawSaleLineFields);
  }),
  session_combo_applications: withOrganization((row, label) => {
    validateFields(row, label, { session_id: textValue, ...comboApplicationFields });
    validateRawData(row, label, rawComboApplicationFields);
  }),
  customer_tabs: withOrganization((row, label) => {
    validateFields(row, label, {
      id: textValue, customer_id: nullable(textValue), customer_name: textValue,
      customer_phone: nullable(stringValue), status: oneOf("open", "closed"),
      opened_at: nullable(timestampValue), closed_at: nullable(timestampValue),
      continued_from_session_ids: nullable(stringArray), closed_bill_id: nullable(textValue),
      close_disposition: nullable(oneOf("billed", "rejected")), close_reason: nullable(stringValue),
      raw_data: recordValue, created_at: timestampValue
    });
    validateRawData(row, label, {
      customerId: nullable(textValue), customerName: textValue, customerPhone: nullable(stringValue),
      status: oneOf("open", "closed"), createdAt: timestampValue, closedAt: nullable(timestampValue),
      continuedFromSessionIds: stringArray, closedBillId: nullable(textValue),
      closeDisposition: nullable(oneOf("billed", "rejected")), closeReason: nullable(stringValue)
    });
  }),
  customer_tab_items: withOrganization((row, label) => {
    validateFields(row, label, { customer_tab_id: textValue, ...saleLineFields });
    validateRawData(row, label, rawSaleLineFields);
  }),
  customer_tab_combo_applications: withOrganization((row, label) => {
    validateFields(row, label, { customer_tab_id: textValue, ...comboApplicationFields });
    validateRawData(row, label, rawComboApplicationFields);
  })
};

export function validateOperationalBootstrapRow(key: string, row: Record<string, unknown>, label: string) {
  const validator = validators[key];
  if (!validator) throw new Error(`Operational bootstrap has no value contract for ${key}.`);
  validator(row, label);
}
