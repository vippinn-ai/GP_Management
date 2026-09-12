import { expect, test, type Locator } from "@playwright/test";
import {
  attachFailureScreenshot,
  attachJson,
  browserDateTimeLocal,
  capturePageErrors,
  captureRpcEvidence,
  credentials,
  createObserver,
  interceptSingleRpcCommand,
  openManagedSession,
  readApiResponseBody,
  readPendingOperationalMutations,
  signIn,
  startSession,
  stationCard,
  type RpcEvidence,
  waitForSynced
} from "./support/app";

const runId = process.env.E2E_RUN_ID ?? "missing-run-id";
const station = process.env.E2E_PAUSE_STATION?.trim() || "8 Ball Pool";
type RaceKind = "timing" | "pause" | "resume" | "add-item" | "remove-item";

async function chooseFirstAvailableItem(modal: Locator) {
  const adder = modal.locator(".session-item-adder");
  await adder.getByLabel("Search inventory item", { exact: true }).focus();
  const option = adder.locator("button.sellable-picker-option:enabled").first();
  await expect(option, "The staging catalog must expose one safely sellable session item.").toBeVisible();
  const itemName = (await option.locator("strong").innerText()).trim();
  await option.click();
  return { adder, itemName };
}

async function addFixtureItem(modal: Locator) {
  const { adder, itemName } = await chooseFirstAvailableItem(modal);
  const response = modal.page().waitForResponse((candidate) =>
    candidate.url().includes("/rest/v1/rpc/add_session_item") && candidate.request().method() === "POST"
  );
  await adder.getByRole("button", { name: "Add Item", exact: true }).click();
  expect((await response).status()).toBe(200);
  await waitForSynced(modal.page());
  await expect(modal.locator(".session-item-row").filter({ hasText: itemName })).toBeVisible();
  return itemName;
}

test("hop serializes safely against timing, pause, resume, add-item, and remove-item mutations", async ({ browser, page }, testInfo) => {
  test.setTimeout(15 * 60_000);
  const observer = await createObserver(browser);
  const rpcEvidence: RpcEvidence[] = [];
  captureRpcEvidence(page, "origin", rpcEvidence);
  captureRpcEvidence(observer.page, "observer", rpcEvidence);
  const originErrors = capturePageErrors(page);
  const observerErrors = capturePageErrors(observer.page);
  const evidence: Array<Record<string, unknown>> = [];
  const dialogs: string[] = [];
  let activeHopCommand: Awaited<ReturnType<typeof interceptSingleRpcCommand>> | undefined;
  let activeMutationCommand: Awaited<ReturnType<typeof interceptSingleRpcCommand>> | undefined;
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  observer.page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });

  try {
    await Promise.all([signIn(page, credentials("A")), signIn(observer.page, credentials("B"))]);
    for (const kind of ["timing", "pause", "resume", "add-item", "remove-item"] as RaceKind[]) {
      const customerName = `QA Hop Race ${runId} ${kind}`;
      await page.getByRole("button", { name: "Live Dashboard", exact: true }).click().catch(() => undefined);
      await startSession(page, station, customerName);
      await observer.page.reload({ waitUntil: "domcontentloaded" });
      await waitForSynced(observer.page);
      await expect(stationCard(observer.page, station)).toContainText(customerName);

      if (kind === "resume") {
        const setup = await openManagedSession(observer.page, station);
        const response = observer.page.waitForResponse((candidate) => candidate.url().includes("/rpc/pause_session"));
        await setup.getByRole("button", { name: /Pause Session/ }).click();
        expect((await response).status()).toBe(200);
        await waitForSynced(observer.page);
        await setup.getByRole("button", { name: "Close", exact: true }).click();
      }
      if (kind === "remove-item") {
        const setup = await openManagedSession(observer.page, station);
        await addFixtureItem(setup);
        await setup.getByRole("button", { name: "Close", exact: true }).click();
      }

      await page.reload({ waitUntil: "domcontentloaded" });
      await observer.page.reload({ waitUntil: "domcontentloaded" });
      await Promise.all([waitForSynced(page), waitForSynced(observer.page)]);

      const originManaged = await openManagedSession(page, station);
      await originManaged.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
      const close = page.getByRole("dialog", { name: "Close Session Bill", exact: true });
      await close.getByLabel("Session End Time", { exact: true }).fill(await browserDateTimeLocal(page, -1));
      await close.getByLabel(/Game hop - close station without billing/).check();
      const hopCommand = await interceptSingleRpcCommand(page, "**/rest/v1/rpc/hop_session_v2");
      activeHopCommand = hopCommand;
      await close.getByRole("button", { name: "Confirm Game Hop", exact: true }).click();
      const capturedHop = await hopCommand.captured;

      const observerManaged = await openManagedSession(observer.page, station);
      let mutationPattern: string;
      let triggerMutation: () => Promise<void>;
      if (kind === "timing") {
        await observerManaged.getByRole("button", { name: "Edit Customer Details", exact: true }).click();
        await observerManaged.getByLabel("Session Start Time", { exact: true }).fill(await browserDateTimeLocal(observer.page, -12));
        mutationPattern = "**/rest/v1/rpc/save_live_session_details";
        triggerMutation = () => observerManaged.getByRole("button", { name: "Save Session Details", exact: true }).click();
      } else if (kind === "pause") {
        mutationPattern = "**/rest/v1/rpc/pause_session";
        triggerMutation = () => observerManaged.getByRole("button", { name: /Pause Session/ }).click();
      } else if (kind === "resume") {
        mutationPattern = "**/rest/v1/rpc/resume_session";
        triggerMutation = () => observerManaged.getByRole("button", { name: /Resume Session/ }).click();
      } else if (kind === "add-item") {
        const { adder } = await chooseFirstAvailableItem(observerManaged);
        mutationPattern = "**/rest/v1/rpc/add_session_item";
        triggerMutation = () => adder.getByRole("button", { name: "Add Item", exact: true }).click();
      } else {
        const itemRow = observerManaged.locator(".session-item-row").filter({ has: observerManaged.getByRole("button", { name: "Remove", exact: true }) }).first();
        await expect(itemRow).toBeVisible();
        mutationPattern = "**/rest/v1/rpc/remove_session_item";
        triggerMutation = () => itemRow.getByRole("button", { name: "Remove", exact: true }).click();
      }

      const mutationCommand = await interceptSingleRpcCommand(observer.page, mutationPattern);
      activeMutationCommand = mutationCommand;
      await triggerMutation();
      const capturedMutation = await mutationCommand.captured;
      expect(hopCommand.captureCount()).toBe(1);
      expect(mutationCommand.captureCount()).toBe(1);
      const [hopResponse, mutationResponse] = await Promise.all([
        hopCommand.submit(capturedHop.body),
        mutationCommand.submit(capturedMutation.body)
      ]);
      const [hopBody, mutationBody] = await Promise.all([
        readApiResponseBody(hopResponse),
        readApiResponseBody(mutationResponse)
      ]);
      expect(hopResponse.status(), `${kind} hop must commit exactly once`).toBe(200);
      expect([200, 400], `${kind} competing mutation has a legal serialized outcome`).toContain(mutationResponse.status());
      await Promise.all([hopCommand.dispose(), mutationCommand.dispose()]);
      activeHopCommand = undefined;
      activeMutationCommand = undefined;
      await expect(stationCard(observer.page, station)).toContainText("Available");
      await expect(page.getByRole("dialog", { name: "Continue Customer", exact: true })).toBeVisible();
      await page.getByRole("dialog", { name: "Continue Customer", exact: true })
        .getByRole("button", { name: "Bill & Done", exact: true }).click();
      const bill = page.getByRole("dialog", { name: "Bill Hopped Session", exact: true });
      await bill.getByRole("button", { name: "Issue Bill", exact: true }).click();
      await expect(bill).toBeHidden();
      await waitForSynced(page);
      const hopEvidence = rpcEvidence.findLast((entry) => entry.rpc === "hop_session_v2" && entry.status < 300);
      const billEvidence = rpcEvidence.findLast((entry) => entry.rpc === "commit_checkout_bill_v2" && entry.status < 300);
      expect(hopEvidence?.mutationId).toBeTruthy();
      expect(billEvidence?.billId).toBeTruthy();
      evidence.push({
        kind,
        hopStatus: hopResponse.status(),
        mutationStatus: mutationResponse.status(),
        hopBody,
        mutationBody,
        hopMutationId: hopEvidence?.mutationId,
        billId: billEvidence?.billId
      });
    }

    expect(evidence.map((entry) => entry.kind)).toEqual(["timing", "pause", "resume", "add-item", "remove-item"]);
    expect(await readPendingOperationalMutations(page)).toEqual([]);
    expect(await readPendingOperationalMutations(observer.page)).toEqual([]);
    expect(originErrors.pageErrors).toEqual([]);
    expect(observerErrors.pageErrors).toEqual([]);
    await attachJson(testInfo, "operational-v2-hop-mutation-races", { runId, evidence, dialogs, rpcEvidence, originErrors, observerErrors });
  } finally {
    activeHopCommand?.cancel();
    activeMutationCommand?.cancel();
    await activeHopCommand?.dispose().catch(() => undefined);
    await activeMutationCommand?.dispose().catch(() => undefined);
    await attachFailureScreenshot(testInfo, page, "hop-mutation-races-origin-failure");
    await attachFailureScreenshot(testInfo, observer.page, "hop-mutation-races-observer-failure");
    await observer.context.close();
  }
});
