import { expect, test, type Locator } from "@playwright/test";
import {
  attachFailureScreenshot,
  attachJson,
  authenticatedJwtSubject,
  browserDateTimeLocal,
  captureAuthenticatedRestRequests,
  capturePageErrors,
  captureRpcEvidence,
  credentials,
  createObserver,
  interceptSingleRpcCommand,
  openManagedSession,
  readApiResponseBody,
  readPendingOperationalMutations,
  readRestRows,
  rpcRejectionCode,
  signIn,
  startSession,
  stationCard,
  type CapturedRpcRequest,
  type RpcEvidence,
  waitForSynced
} from "./support/app";

const runId = process.env.E2E_RUN_ID ?? "missing-run-id";
const organizationId = "org-primary";
const station = process.env.E2E_PAUSE_STATION?.trim() || "8 Ball Pool";
type RaceKind = "timing" | "pause" | "resume" | "add-item" | "remove-item";

interface Identity {
  actorId: string;
  restBase: string;
  headers: Record<string, string>;
}

interface SessionItemRow {
  id: string;
  inventory_item_id: string | null;
  name: string;
  quantity: number | string;
  unit_price: number | string;
}

function identityFrom(requests: CapturedRpcRequest[]): Identity {
  const captured = [...requests].reverse().find((entry) => entry.headers.apikey && entry.headers.authorization);
  if (!captured) throw new Error("No authenticated staging REST request was captured.");
  const url = new URL(captured.url);
  const markerAt = url.pathname.indexOf("/rest/v1");
  if (markerAt < 0) throw new Error("Captured request is not a Supabase REST request.");
  return {
    actorId: authenticatedJwtSubject(captured.headers),
    restBase: `${url.origin}${url.pathname.slice(0, markerAt)}/rest/v1`,
    headers: {
      apikey: captured.headers.apikey,
      authorization: captured.headers.authorization,
      "content-type": "application/json"
    }
  };
}

function nestedPayload(command: CapturedRpcRequest) {
  const outer = command.body && typeof command.body === "object" && !Array.isArray(command.body)
    ? command.body as Record<string, unknown>
    : {};
  const envelope = outer.payload && typeof outer.payload === "object" && !Array.isArray(outer.payload)
    ? outer.payload as Record<string, unknown>
    : {};
  const payload = envelope.payload && typeof envelope.payload === "object" && !Array.isArray(envelope.payload)
    ? envelope.payload as Record<string, unknown>
    : {};
  return { envelope, payload };
}

function auditIdFrom(command: CapturedRpcRequest) {
  const { payload } = nestedPayload(command);
  if (typeof payload.audit_log_id === "string") return payload.audit_log_id;
  const auditLog = payload.auditLog && typeof payload.auditLog === "object" && !Array.isArray(payload.auditLog)
    ? payload.auditLog as Record<string, unknown>
    : {};
  return typeof auditLog.id === "string" ? auditLog.id : null;
}

async function timedSubmit(command: Awaited<ReturnType<typeof interceptSingleRpcCommand>>, body: unknown) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const response = await command.submit(body);
  return {
    response,
    startedAt,
    completedAt: new Date().toISOString(),
    elapsedMs: Math.round((performance.now() - started) * 100) / 100
  };
}

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
  const originRequests: CapturedRpcRequest[] = [];
  const observerRequests: CapturedRpcRequest[] = [];
  captureAuthenticatedRestRequests(page, originRequests);
  captureAuthenticatedRestRequests(observer.page, observerRequests);
  const rpcEvidence: RpcEvidence[] = [];
  captureRpcEvidence(page, "origin", rpcEvidence);
  captureRpcEvidence(observer.page, "observer", rpcEvidence);
  const originErrors = capturePageErrors(page);
  const observerErrors = capturePageErrors(observer.page);
  const evidence: Array<Record<string, unknown>> = [];
  const unresolvedSourceIds = new Set<string>();
  const dialogs: string[] = [];
  let primaryError: unknown;
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
    const origin = identityFrom(originRequests);
    const second = identityFrom(observerRequests);
    expect(second.actorId, "Hop mutation races require distinct authenticated actors.").not.toBe(origin.actorId);
    for (const kind of ["timing", "pause", "resume", "add-item", "remove-item"] as RaceKind[]) {
      const customerName = `QA Hop Race ${runId} ${kind}`;
      let fixtureItemName: string | undefined;
      let attemptedItemName: string | undefined;
      await page.getByRole("button", { name: "Live Dashboard", exact: true }).click().catch(() => undefined);
      await startSession(page, station, customerName);
      const startedSourceId = rpcEvidence.findLast((entry) => entry.rpc === "start_session" && entry.status < 300)?.entityId;
      expect(startedSourceId).toBeTruthy();
      unresolvedSourceIds.add(startedSourceId!);
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
        fixtureItemName = await addFixtureItem(setup);
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
        const { adder, itemName } = await chooseFirstAvailableItem(observerManaged);
        attemptedItemName = itemName;
        mutationPattern = "**/rest/v1/rpc/add_session_item";
        triggerMutation = () => adder.getByRole("button", { name: "Add Item", exact: true }).click();
      } else {
        const itemRow = observerManaged.locator(".session-item-row").filter({ has: observerManaged.getByRole("button", { name: "Remove", exact: true }) }).first();
        await expect(itemRow).toBeVisible();
        attemptedItemName = fixtureItemName;
        mutationPattern = "**/rest/v1/rpc/remove_session_item";
        triggerMutation = () => itemRow.getByRole("button", { name: "Remove", exact: true }).click();
      }

      const mutationCommand = await interceptSingleRpcCommand(observer.page, mutationPattern);
      activeMutationCommand = mutationCommand;
      await triggerMutation();
      const capturedMutation = await mutationCommand.captured;
      const hopParts = nestedPayload(capturedHop);
      const mutationParts = nestedPayload(capturedMutation);
      const sourceId = String(hopParts.envelope.entity_id ?? "");
      const hopMutationId = String(hopParts.envelope.mutation_id ?? "");
      const mutationId = String(mutationParts.envelope.mutation_id ?? "");
      const hopAuditId = auditIdFrom(capturedHop);
      const mutationAuditId = auditIdFrom(capturedMutation);
      expect(sourceId).toBeTruthy();
      expect(sourceId).toBe(startedSourceId);
      expect(hopMutationId).toBeTruthy();
      expect(mutationId).toBeTruthy();
      expect(hopAuditId).toBeTruthy();
      expect(mutationAuditId).toBeTruthy();
      const itemsBeforeRace = await readRestRows<SessionItemRow>(page, origin.restBase, origin.headers, "session_items", {
        organization_id: `eq.${organizationId}`,
        session_id: `eq.${sourceId}`,
        select: "id,inventory_item_id,name,quantity,unit_price",
        order: "id.asc"
      });
      expect(hopCommand.captureCount()).toBe(1);
      expect(mutationCommand.captureCount()).toBe(1);
      const [hopSubmission, mutationSubmission] = await Promise.all([
        timedSubmit(hopCommand, capturedHop.body),
        timedSubmit(mutationCommand, capturedMutation.body)
      ]);
      const hopResponse = hopSubmission.response;
      const mutationResponse = mutationSubmission.response;
      const [hopBody, mutationBody] = await Promise.all([
        readApiResponseBody(hopResponse),
        readApiResponseBody(mutationResponse)
      ]);
      expect(hopResponse.status(), `${kind} hop must commit exactly once`).toBe(200);
      expect([200, 400], `${kind} competing mutation has a legal serialized outcome`).toContain(mutationResponse.status());
      if (mutationResponse.status() === 400) {
        expect(rpcRejectionCode(mutationBody), `${kind} loser must be the exact terminal-state rejection`).toBe("session_not_open");
      }
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
      const billId = billEvidence!.billId!;
      unresolvedSourceIds.delete(sourceId);
      const [sessions, pauseLogs, itemsAfterBill, billLines, events, hopAudits, mutationAudits] = await Promise.all([
        readRestRows<{ id: string; status: string; close_disposition: string | null; closed_bill_id: string | null; started_at: string; raw_data: Record<string, unknown> }>(
          page, origin.restBase, origin.headers, "sessions",
          { organization_id: `eq.${organizationId}`, id: `eq.${sourceId}`, select: "id,status,close_disposition,closed_bill_id,started_at,raw_data" }
        ),
        readRestRows<{ id: string; paused_at: string; resumed_at: string | null }>(page, origin.restBase, origin.headers, "session_pause_logs", {
          organization_id: `eq.${organizationId}`, session_id: `eq.${sourceId}`, select: "id,paused_at,resumed_at", order: "id.asc"
        }),
        readRestRows<SessionItemRow>(page, origin.restBase, origin.headers, "session_items", {
          organization_id: `eq.${organizationId}`, session_id: `eq.${sourceId}`, select: "id,inventory_item_id,name,quantity,unit_price", order: "id.asc"
        }),
        readRestRows<{ id: string; description: string; linked_session_id: string | null; inventory_item_id: string | null }>(
          page, origin.restBase, origin.headers, "bill_lines",
          { organization_id: `eq.${organizationId}`, bill_id: `eq.${billId}`, linked_session_id: `eq.${sourceId}`, select: "id,description,linked_session_id,inventory_item_id", order: "id.asc" }
        ),
        readRestRows<{ id: string; created_by: string; metadata: { mutation_id?: string } }>(page, origin.restBase, origin.headers, "operational_events", {
          organization_id: `eq.${organizationId}`, "metadata->>mutation_id": `in.(${hopMutationId},${mutationId})`, select: "id,created_by,metadata"
        }),
        readRestRows<{ id: string; user_id: string }>(page, origin.restBase, origin.headers, "audit_logs", {
          organization_id: `eq.${organizationId}`, id: `eq.${hopAuditId}`, select: "id,user_id"
        }),
        readRestRows<{ id: string; user_id: string }>(page, origin.restBase, origin.headers, "audit_logs", {
          organization_id: `eq.${organizationId}`, id: `eq.${mutationAuditId}`, select: "id,user_id"
        })
      ]);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({ id: sourceId, status: "closed", close_disposition: "hopped", closed_bill_id: billId });
      expect(pauseLogs.filter((row) => row.resumed_at === null), `${kind} must not leave an open pause`).toEqual([]);
      const hopEvents = events.filter((event) => event.metadata.mutation_id === hopMutationId);
      const mutationEvents = events.filter((event) => event.metadata.mutation_id === mutationId);
      expect(hopEvents).toEqual([{ id: hopBody.event_id, created_by: origin.actorId, metadata: expect.objectContaining({ mutation_id: hopMutationId }) }]);
      expect(hopAudits).toEqual([{ id: hopAuditId, user_id: origin.actorId }]);
      expect(mutationEvents, `${kind} mutation event cardinality`).toHaveLength(mutationResponse.status() === 200 ? 1 : 0);
      expect(mutationAudits, `${kind} mutation audit cardinality`).toHaveLength(mutationResponse.status() === 200 ? 1 : 0);
      if (mutationResponse.status() === 200) {
        expect(mutationEvents[0]).toMatchObject({ id: mutationBody.event_id, created_by: second.actorId });
        expect(mutationAudits[0]).toEqual({ id: mutationAuditId, user_id: second.actorId });
      }

      if (kind === "timing" && mutationResponse.status() === 200) {
        const intendedStartedAt = String(mutationParts.payload.startedAt ?? "");
        expect(intendedStartedAt).toBeTruthy();
        expect(Date.parse(sessions[0].started_at)).toBe(Date.parse(intendedStartedAt));
      }
      if (kind === "add-item") {
        expect(attemptedItemName).toBeTruthy();
        const persisted = itemsAfterBill.some((row) => row.name === attemptedItemName);
        const billed = billLines.some((row) => row.inventory_item_id && row.description === attemptedItemName);
        expect(persisted).toBe(mutationResponse.status() === 200);
        expect(billed).toBe(mutationResponse.status() === 200);
      }
      if (kind === "remove-item") {
        expect(attemptedItemName).toBeTruthy();
        const persisted = itemsAfterBill.some((row) => row.name === attemptedItemName);
        const billed = billLines.some((row) => row.inventory_item_id && row.description === attemptedItemName);
        expect(persisted).toBe(mutationResponse.status() !== 200);
        expect(billed).toBe(mutationResponse.status() !== 200);
      }
      evidence.push({
        kind,
        hopStatus: hopResponse.status(),
        mutationStatus: mutationResponse.status(),
        hopBody,
        mutationBody,
        hopMutationId,
        mutationId,
        billId,
        capturedHop,
        capturedMutation,
        hopSubmission: { startedAt: hopSubmission.startedAt, completedAt: hopSubmission.completedAt, elapsedMs: hopSubmission.elapsedMs },
        mutationSubmission: { startedAt: mutationSubmission.startedAt, completedAt: mutationSubmission.completedAt, elapsedMs: mutationSubmission.elapsedMs },
        itemsBeforeRace,
        sessions,
        pauseLogs,
        itemsAfterBill,
        billLines,
        events,
        hopAudits,
        mutationAudits
      });
    }

    expect(evidence.map((entry) => entry.kind)).toEqual(["timing", "pause", "resume", "add-item", "remove-item"]);
    expect(await readPendingOperationalMutations(page)).toEqual([]);
    expect(await readPendingOperationalMutations(observer.page)).toEqual([]);
    expect([...unresolvedSourceIds]).toEqual([]);
    expect(originErrors).toEqual({ consoleErrors: [], pageErrors: [] });
    expect(observerErrors).toEqual({ consoleErrors: [], pageErrors: [] });
    await attachJson(testInfo, "operational-v2-hop-mutation-races", { runId, evidence, dialogs, rpcEvidence, originErrors, observerErrors });
  } catch (error) {
    primaryError = error;
  } finally {
    activeHopCommand?.cancel();
    activeMutationCommand?.cancel();
    await activeHopCommand?.dispose().catch(() => undefined);
    await activeMutationCommand?.dispose().catch(() => undefined);
    await attachJson(testInfo, "operational-v2-hop-mutation-cleanup-ledger", {
      runId,
      unresolvedSourceIds: [...unresolvedSourceIds],
      failed: Boolean(primaryError)
    });
    await attachFailureScreenshot(testInfo, page, "hop-mutation-races-origin-failure");
    await attachFailureScreenshot(testInfo, observer.page, "hop-mutation-races-observer-failure");
    await observer.context.close();
  }
  if (primaryError) throw primaryError;
  if (unresolvedSourceIds.size) throw new Error("Hop mutation races left exact unresolved staging sessions; reconcile before another run.");
});
