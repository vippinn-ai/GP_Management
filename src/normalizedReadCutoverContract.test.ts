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
  });
});
