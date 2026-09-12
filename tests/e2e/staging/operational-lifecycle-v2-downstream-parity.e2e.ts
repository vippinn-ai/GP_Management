import { expect, test } from "@playwright/test";
import {
  attachFailureScreenshot,
  attachJson,
  browserDateTimeLocal,
  captureAuthenticatedRestRequests,
  capturePageErrors,
  captureRpcEvidence,
  credentials,
  openManagedSession,
  readRestRows,
  signIn,
  startSession,
  type CapturedRpcRequest,
  type RpcEvidence,
  waitForSynced
} from "./support/app";

const runId = process.env.E2E_RUN_ID ?? "missing-run-id";
const station = process.env.E2E_PAUSE_STATION?.trim() || "8 Ball Pool";
const organizationId = "org-primary";

function restIdentity(requests: CapturedRpcRequest[]) {
  const captured = [...requests].reverse().find((entry) => entry.headers.apikey && entry.headers.authorization);
  if (!captured) throw new Error("No authenticated REST request was captured.");
  const url = new URL(captured.url);
  const markerAt = url.pathname.indexOf("/rest/v1");
  if (markerAt < 0) throw new Error("Captured request is not a Supabase REST request.");
  return {
    restBase: `${url.origin}${url.pathname.slice(0, markerAt)}/rest/v1`,
    headers: { apikey: captured.headers.apikey, authorization: captured.headers.authorization }
  };
}

async function receiptSnapshot(page: Parameters<typeof waitForSynced>[0], billNumber: string) {
  await page.getByRole("button", { name: "Bill Register", exact: true }).click();
  const search = page.getByPlaceholder("Search bill #, customer name or phone...");
  await search.fill(billNumber);
  const row = page.locator(".bill-register-list-scroll tbody tr").filter({ hasText: billNumber });
  await expect(row).toBeVisible();
  const receipt = page.locator(".thermal-receipt-preview");
  const alreadySelected = await receipt.isVisible().catch(() => false)
    && (await receipt.innerText()).includes(billNumber);
  if (!alreadySelected) await row.click();
  await expect(receipt).toContainText(billNumber);
  return {
    rowText: await row.innerText(),
    receiptText: await receipt.innerText(),
    viewport: page.viewportSize()
  };
}

test("bill, receipt, mobile, hard-refresh, and logout-login consumers retain exact normalized parity", async ({ page }, testInfo) => {
  test.setTimeout(5 * 60_000);
  const requests: CapturedRpcRequest[] = [];
  const rpcEvidence: RpcEvidence[] = [];
  const errors = capturePageErrors(page);
  captureAuthenticatedRestRequests(page, requests);
  captureRpcEvidence(page, "origin", rpcEvidence);
  const customerName = `QA Downstream ${runId}`;
  let billId: string | undefined;
  let billNumber: string | undefined;
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  page.context().on("page", (popup) => void popup.close().catch(() => undefined));

  try {
    await signIn(page, credentials("A"));
    await startSession(page, station, customerName);
    const managed = await openManagedSession(page, station);
    await managed.getByRole("button", { name: "Edit Customer Details", exact: true }).click();
    await managed.getByLabel("Session Start Time", { exact: true }).fill(await browserDateTimeLocal(page, -8));
    await managed.getByRole("button", { name: "Save Session Details", exact: true }).click();
    await waitForSynced(page);
    await managed.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
    const checkout = page.getByRole("dialog", { name: "Close Session Bill", exact: true });
    await checkout.getByLabel("Session End Time", { exact: true }).fill(await browserDateTimeLocal(page, -1));
    const issued = page.waitForResponse((response) =>
      response.url().includes("/rest/v1/rpc/commit_checkout_bill_v2") && response.request().method() === "POST"
    );
    await checkout.getByRole("button", { name: "Issue Bill", exact: true }).click();
    expect((await issued).status()).toBe(200);
    await expect(checkout).toBeHidden();
    await waitForSynced(page);
    const commit = rpcEvidence.findLast((entry) => entry.rpc === "commit_checkout_bill_v2" && entry.status < 300);
    billId = commit?.billId;
    billNumber = commit?.billNumber;
    expect(billId).toBeTruthy();
    expect(billNumber).toBeTruthy();

    const identity = restIdentity(requests);
    const [billRows, lineRows, paymentRows] = await Promise.all([
      readRestRows<{ id: string; bill_number: string; customer_name: string; total: number; amount_paid: number; amount_due: number }>(
        page, identity.restBase, identity.headers, "bills", {
          organization_id: `eq.${organizationId}`, id: `eq.${billId}`, select: "id,bill_number,customer_name,total,amount_paid,amount_due"
        }
      ),
      readRestRows<{ id: string; bill_id: string; line_total: number }>(page, identity.restBase, identity.headers, "bill_lines", {
        organization_id: `eq.${organizationId}`, bill_id: `eq.${billId}`, select: "id,bill_id,line_total"
      }),
      readRestRows<{ id: string; bill_id: string; amount: number; mode: string }>(page, identity.restBase, identity.headers, "payments", {
        organization_id: `eq.${organizationId}`, bill_id: `eq.${billId}`, select: "id,bill_id,amount,mode"
      })
    ]);
    expect(billRows).toHaveLength(1);
    expect(lineRows.length).toBeGreaterThan(0);
    expect(paymentRows).toHaveLength(1);
    expect(Number(billRows[0].total)).toBeCloseTo(lineRows.reduce((total, row) => total + Number(row.line_total), 0), 2);
    expect(Number(billRows[0].amount_paid)).toBe(Number(paymentRows[0].amount));
    const desktop = await receiptSnapshot(page, billNumber!);

    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForSynced(page);
    const afterRefresh = await receiptSnapshot(page, billNumber!);
    expect(afterRefresh.receiptText).toBe(desktop.receiptText);

    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = await receiptSnapshot(page, billNumber!);
    expect(mobile.receiptText).toBe(desktop.receiptText);
    expect(mobile.viewport).toEqual({ width: 390, height: 844 });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "Sign Out", exact: true }).first().click();
    await expect(page.getByRole("button", { name: "Sign In", exact: true })).toBeVisible();
    await signIn(page, credentials("A"));
    const afterLogin = await receiptSnapshot(page, billNumber!);
    expect(afterLogin.receiptText).toBe(desktop.receiptText);
    expect(errors).toEqual({ consoleErrors: [], pageErrors: [] });

    await attachJson(testInfo, "operational-v2-downstream-parity", {
      runId,
      customerName,
      billId,
      billNumber,
      canonical: { bill: billRows[0], lines: lineRows, payments: paymentRows },
      desktop,
      afterRefresh,
      mobile,
      afterLogin,
      dialogs,
      rpcEvidence
    });
  } finally {
    await attachFailureScreenshot(testInfo, page, "downstream-parity-failure");
    if (!billId) throw new Error("Downstream parity bill was not confirmed; reconcile the active session before another run.");
  }
});
