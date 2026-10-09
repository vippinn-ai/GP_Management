import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

const continuationSpec = read("tests/e2e/staging/operational-lifecycle-v2-continuations.e2e.ts");
const hopRaceSpec = read("tests/e2e/staging/operational-lifecycle-v2-hop-mutation-races.e2e.ts");
const downstreamSpec = read("tests/e2e/staging/operational-lifecycle-v2-downstream-parity.e2e.ts");
const app = read("src/App.tsx");
const phase10 = read("supabase/phase10-financial-v2-rpcs.sql");

describe("hopped-session billing transition contract", () => {
  it("keeps the source hopped and unbilled before checkout, then requires billed with the exact bill ID", () => {
    const hoppedBeforeBilling = 'close_disposition: "hopped", closed_bill_id: null';
    const helperAfterBilling = 'close_disposition: "billed", closed_bill_id: body.bill_id';
    const unitSaleAfterBilling = 'close_disposition: "billed", closed_bill_id: billId';

    expect(continuationSpec).toContain(hoppedBeforeBilling);
    expect(continuationSpec).toContain(helperAfterBilling);
    expect(continuationSpec).toContain(unitSaleAfterBilling);
    expect(continuationSpec.indexOf(hoppedBeforeBilling)).toBeLessThan(continuationSpec.indexOf(unitSaleAfterBilling));
    expect(continuationSpec).not.toMatch(/close_disposition: "hopped", closed_bill_id: (?:body\.bill_id|billId)/);
  });

  it("requires the hop-race source to become billed after checkout and rejects line-local hopped/non-null literals", () => {
    expect(hopRaceSpec).toContain(
      'expect(sessions[0]).toMatchObject({ id: sourceId, status: "closed", close_disposition: "billed", closed_bill_id: billId })'
    );

    const operationalSpecs = fs
      .readdirSync(path.join(process.cwd(), "tests/e2e/staging"))
      .filter((name) => name.startsWith("operational-lifecycle-v2-") && name.endsWith(".e2e.ts"));
    const hoppedSessionLiterals = operationalSpecs.flatMap((name) =>
      read(`tests/e2e/staging/${name}`)
        .split(/\r?\n/)
        .map((line, index) => ({ name, line, lineNumber: index + 1 }))
        .filter(({ line }) => /close_(?:disposition|bill_id)/.test(line) && /["']hopped["']/.test(line) && /closed_bill_id/.test(line))
    );

    expect(hoppedSessionLiterals.length).toBeGreaterThan(0);
    for (const literal of hoppedSessionLiterals) {
      expect(literal.line, `${literal.name}:${literal.lineNumber} hopped literals must remain unbilled`).toMatch(/closed_bill_id\s*:\s*null\b/);
    }
  });

  it("matches the application patch and Phase 10 server-authoritative billed disposition", () => {
    expect(app).toContain('targetSession.closeDisposition = "billed";');
    expect(app).toContain('hoppedSession.closeDisposition = "billed";');
    expect(app.indexOf('hoppedSession.closedBillId = billId;')).toBeLessThan(app.indexOf('hoppedSession.closeDisposition = "billed";'));

    expect(phase10).toContain("source.value->>'closeDisposition' <> 'billed'");
    expect(phase10).toContain("closed_bill_id = v_bill_id, close_disposition = 'billed'");
    expect(phase10).toContain("'closedBillId', v_bill_id, 'closeDisposition', 'billed'");
  });

  it("retains item, inventory, movement, receipt, and reload evidence around the corrected assertion", () => {
    for (const contract of [
      "expect(itemsAfterHop.map(canonicalItem)).toEqual(itemsAfterStart.map(canonicalItem))",
      "expect(inventoryAfterHop).toEqual(inventoryAfterStart)",
      "expect(billedItems).toEqual(itemsAfterStart.map(canonicalItem))",
      "inventoryAfterBill.find((row) => row.id === before.id)",
      "billStockMovements.filter((row) => row.item_id === before.id)",
      'await page.reload({ waitUntil: "domcontentloaded" })'
    ]) {
      expect(continuationSpec).toContain(contract);
    }

    expect(downstreamSpec).toContain("const desktop = await receiptSnapshot(page, billNumber!)");
    expect(downstreamSpec).toContain('await page.reload({ waitUntil: "domcontentloaded" })');
    expect(downstreamSpec).toContain("expect(afterRefresh.receiptText).toBe(desktop.receiptText)");
    expect(downstreamSpec).toContain("expect(mobile.receiptText).toBe(desktop.receiptText)");
    expect(downstreamSpec).toContain("expect(afterLogin.receiptText).toBe(desktop.receiptText)");
  });
});
