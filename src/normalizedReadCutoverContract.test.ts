import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(join(process.cwd(), "src", "App.tsx"), "utf8");
const billReaderSource = readFileSync(
  join(process.cwd(), "src", "dataGateway", "normalizedBillRegister.ts"),
  "utf8"
);

describe("normalized Release A read-path contract", () => {
  it("invalidates the normalized Bill Register after a successful financial adjustment", () => {
    const adjustmentSuccess = appSource.match(
      /await commitFinancialAdjustmentPatch\(patch\);[\s\S]*?financialAdjustmentMutationIdsRef\.current\.delete\(mutationKey\);/
    )?.[0];

    expect(adjustmentSuccess).toMatch(
      /if \(normalizedBillHistoryReadsEnabled\) \{\s*refreshNormalizedBillRegister\(\);\s*\}/
    );
    expect(appSource).toMatch(
      /const \[normalizedBillRegisterRefreshSignal, setNormalizedBillRegisterRefreshSignal\] = useState\(0\)/
    );
    expect(appSource).toMatch(
      /snapshot\.refreshedSlices\?\.includes\("bills"\)[\s\S]*?setNormalizedBillRegisterRefreshSignal/
    );
    expect(appSource).toMatch(
      /normalizedBillRegisterQueryKey,\s*normalizedBillRegisterRefreshSignal,\s*hydrateNormalizedBillRegisterPage/
    );
  });

  it("loads checkout-related payments and their source bills for isolated receipt pages", () => {
    expect(billReaderSource).toMatch(/\.in\("related_checkout_bill_id", billIds\)/);
    expect(billReaderSource).toMatch(/collectReceiptRelatedBillIds\(pageRows, checkoutRelatedPaymentRows\)/);
    expect(billReaderSource).toMatch(/\.in\("id", relatedBillIds\)/);
  });

  it("discards a load-more result after a query change or same-query refresh", () => {
    expect(appSource).toMatch(
      /normalizedBillRegisterQueryKeyRef\.current !== requestedQueryKey \|\|\s*normalizedBillRegisterGenerationRef\.current !== requestedGeneration/
    );
    expect(appSource).toMatch(/if \(previous\.queryKey !== requestedQueryKey\) \{\s*return previous;\s*\}/);
    expect(appSource).toMatch(
      /const refreshNormalizedBillRegister = useCallback\(\(\) => \{\s*normalizedBillRegisterGenerationRef\.current \+= 1;/
    );
    expect(appSource).toMatch(
      /const refreshNormalizedBillRegister = useCallback\([\s\S]*?setNormalizedBillRegisterRefreshSignal\(\(previous\) => previous \+ 1\);/
    );
  });

  it("uses a controlled modal for void and refund instead of native dialogs", () => {
    expect(appSource).not.toContain('window.prompt("Enter reason for void/refund:")');
    expect(appSource).not.toContain('window.confirm("OK = refund, Cancel = void")');
    expect(appSource).toContain('setVoidRefundDraft({ billId, reason: "", action: "void" })');
    expect(appSource).toContain('aria-label="Void or refund action"');
    expect(appSource).toContain('return commitFinancialAdjustmentChange(refund ? "Refunding bill..." : "Voiding bill..."');
  });
});
