import { expect, test, type Locator } from "@playwright/test";
import { createFailurePreservingCleanup } from "../../../src/qa/failurePreservingCleanup";
import { capturedCompetingInstant, capturedItemId, exactItemDelta, validateCapturedHopEnd, validateRaceQueues } from "../../../src/qa/hopMutationRace";
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
  sale_variant_id: string | null;
  sold_as_pack_of: number | string | null;
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

function safeCommandEvidence(command: CapturedRpcRequest) {
  const url = new URL(command.url);
  return { urlPath: url.pathname, body: command.body };
}

function safeResponseEvidence(status: number, body: unknown) {
  const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  return {
    status,
    eventId: typeof record.event_id === "string" ? record.event_id : null,
    mutationId: typeof record.mutation_id === "string" ? record.mutation_id : null,
    rejectionCode: rpcRejectionCode(record)
  };
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

async function timedSubmitOutcome(command: Awaited<ReturnType<typeof interceptSingleRpcCommand>>, body: unknown) {
  try {
    return { ok: true as const, submission: await timedSubmit(command, body) };
  } catch (error) {
    return { ok: false as const, errorType: error instanceof Error ? error.name : "UnknownError" };
  }
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

test("hop serializes safely against timing, pause, resume, add-item, and remove-item mutations", async ({ browser }, testInfo) => {
  const finalization = createFailurePreservingCleanup();
  test.setTimeout(15 * 60_000);
  const rpcEvidence: RpcEvidence[] = [];
  const scenarioDiagnostics: Array<Record<string, unknown>> = [];
  const evidence: Array<Record<string, unknown>> = [];
  const unresolvedSourceIds = new Set<string>();
  const dialogs: string[] = [];
  let primaryError: unknown;
  let activeOrigin: Awaited<ReturnType<typeof createObserver>> | undefined;
  let activeObserver: Awaited<ReturnType<typeof createObserver>> | undefined;
  let activeHopCommand: Awaited<ReturnType<typeof interceptSingleRpcCommand>> | undefined;
  let activeMutationCommand: Awaited<ReturnType<typeof interceptSingleRpcCommand>> | undefined;

  try {
    for (const kind of ["timing", "pause", "resume", "add-item", "remove-item"] as RaceKind[]) {
      const originContext = await createObserver(browser);
      activeOrigin = originContext;
      const observer = await createObserver(browser);
      activeObserver = observer;
      const page = originContext.page;
      const originRequests: CapturedRpcRequest[] = [];
      const observerRequests: CapturedRpcRequest[] = [];
      captureAuthenticatedRestRequests(page, originRequests);
      captureAuthenticatedRestRequests(observer.page, observerRequests);
      captureRpcEvidence(page, "origin", rpcEvidence);
      captureRpcEvidence(observer.page, "observer", rpcEvidence);
      const originErrors = capturePageErrors(page);
      const observerErrors = capturePageErrors(observer.page);
      page.on("dialog", (dialog) => {
        dialogs.push(dialog.message());
        void dialog.dismiss();
      });
      observer.page.on("dialog", (dialog) => {
        dialogs.push(dialog.message());
        void dialog.dismiss();
      });
      await signIn(page, credentials("A"));
      await signIn(observer.page, credentials("B"));
      const origin = identityFrom(originRequests);
      const second = identityFrom(observerRequests);
      expect(second.actorId, "Hop mutation races require distinct authenticated actors.").not.toBe(origin.actorId);
      const customerName = `QA Hop Race ${runId} ${kind}`;
      await page.getByRole("button", { name: "Live Dashboard", exact: true }).click().catch(() => undefined);
      await startSession(page, station, customerName);
      const startedSourceId = rpcEvidence.findLast((entry) => entry.rpc === "start_session" && entry.status < 300)?.entityId;
      expect(startedSourceId).toBeTruthy();
      unresolvedSourceIds.add(startedSourceId!);
      await observer.page.reload({ waitUntil: "domcontentloaded" });
      await waitForSynced(observer.page);
      await expect(stationCard(observer.page, station)).toContainText(customerName);

      const fixtureTiming = await openManagedSession(observer.page, station);
      await fixtureTiming.getByRole("button", { name: "Edit Customer Details", exact: true }).click();
      await fixtureTiming.getByLabel("Session Start Time", { exact: true }).fill(await browserDateTimeLocal(observer.page, -15));
      const fixtureTimingResponse = observer.page.waitForResponse((candidate) =>
        candidate.url().includes("/rest/v1/rpc/save_live_session_details") && candidate.request().method() === "POST"
      );
      await fixtureTiming.getByRole("button", { name: "Save Session Details", exact: true }).click();
      expect((await fixtureTimingResponse).status(), "The -15 minute fixture start edit must be acknowledged before the race.").toBe(200);
      await waitForSynced(observer.page);
      await fixtureTiming.getByRole("button", { name: "Close", exact: true }).click();

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

      const sourceId = startedSourceId!;
      const [sessionBeforeRace, pauseLogsBeforeRace, itemsBeforeRace] = await Promise.all([
        readRestRows<{ id: string; status: string; started_at: string }>(page, origin.restBase, origin.headers, "sessions", {
          organization_id: `eq.${organizationId}`, id: `eq.${sourceId}`, select: "id,status,started_at"
        }),
        readRestRows<{ id: string; paused_at: string; resumed_at: string | null }>(page, origin.restBase, origin.headers, "session_pause_logs", {
          organization_id: `eq.${organizationId}`, session_id: `eq.${sourceId}`, select: "id,paused_at,resumed_at", order: "id.asc"
        }),
        readRestRows<SessionItemRow>(page, origin.restBase, origin.headers, "session_items", {
          organization_id: `eq.${organizationId}`, session_id: `eq.${sourceId}`, select: "id,inventory_item_id,name,quantity,unit_price,sale_variant_id,sold_as_pack_of", order: "id.asc"
        })
      ]);
      expect(sessionBeforeRace).toHaveLength(1);
      const mutationCommand = await interceptSingleRpcCommand(observer.page, mutationPattern);
      activeMutationCommand = mutationCommand;
      const mutationTriggeredAtMs = Date.now();
      await triggerMutation();
      const capturedMutation = await mutationCommand.captured;
      const mutationParts = nestedPayload(capturedMutation);
      const mutationId = String(mutationParts.envelope.mutation_id ?? "");
      const mutationAuditId = auditIdFrom(capturedMutation);
      expect(mutationId).toBeTruthy();
      expect(mutationAuditId).toBeTruthy();
      expect(String(mutationParts.envelope.entity_id ?? "")).toBe(sourceId);
      expect(mutationCommand.captureCount()).toBe(1);
      const originManaged = await openManagedSession(page, station);
      await originManaged.getByRole("button", { name: "Proceed to Checkout", exact: true }).click();
      const close = page.getByRole("dialog", { name: "Close Session Bill", exact: true });
      await close.getByLabel(/Game hop - close station without billing/).check();
      const hopCommand = await interceptSingleRpcCommand(page, "**/rest/v1/rpc/hop_session_v2");
      activeHopCommand = hopCommand;
      await close.getByRole("button", { name: "Confirm Game Hop", exact: true }).click();
      const capturedHop = await hopCommand.captured;
      const hopParts = nestedPayload(capturedHop);
      const hopMutationId = String(hopParts.envelope.mutation_id ?? "");
      const hopAuditId = auditIdFrom(capturedHop);
      expect(String(hopParts.envelope.entity_id ?? "")).toBe(sourceId);
      expect(hopMutationId).toBeTruthy();
      expect(hopAuditId).toBeTruthy();
      expect(hopCommand.captureCount()).toBe(1);
      const endValidation = validateCapturedHopEnd({
        capturedEnd: hopParts.payload.effective_ended_at,
        capturedAtMs: Date.now(),
        canonicalStartedAt: sessionBeforeRace[0].started_at,
        pauseLogs: pauseLogsBeforeRace,
        competingInstantMs: capturedCompetingInstant(kind, mutationParts.payload)
      });
      const mutationHeldMs = Date.now() - mutationTriggeredAtMs;
      expect(mutationHeldMs, "Captured competing command must be submitted inside the operational RPC timeout budget.").toBeLessThanOrEqual(12_000);
      const submissions = await Promise.all([
        timedSubmitOutcome(hopCommand, capturedHop.body),
        timedSubmitOutcome(mutationCommand, capturedMutation.body)
      ]);
      if (!submissions[0].ok || !submissions[1].ok) {
        await attachJson(testInfo, `operational-v2-hop-mutation-${kind}-transport-failure`, {
          runId, kind, sourceId,
          hopCommand: safeCommandEvidence(capturedHop), mutationCommand: safeCommandEvidence(capturedMutation),
          submissions: submissions.map((entry) => entry.ok
            ? { state: "fulfilled", status: entry.submission.response.status(), startedAt: entry.submission.startedAt, completedAt: entry.submission.completedAt, elapsedMs: entry.submission.elapsedMs }
            : { state: "rejected", errorType: entry.errorType })
        });
        throw new Error("Hop race transport failed; see sanitized attachment.");
      }
      const hopSubmission = submissions[0].submission;
      const mutationSubmission = submissions[1].submission;
      const bodies = await Promise.allSettled([
        readApiResponseBody(hopSubmission.response),
        readApiResponseBody(mutationSubmission.response)
      ]);
      if (bodies[0].status !== "fulfilled" || bodies[1].status !== "fulfilled") {
        await attachJson(testInfo, `operational-v2-hop-mutation-${kind}-body-failure`, {
          runId, kind, sourceId,
          hopCommand: safeCommandEvidence(capturedHop), mutationCommand: safeCommandEvidence(capturedMutation),
          responses: [hopSubmission.response.status(), mutationSubmission.response.status()],
          bodies: bodies.map((entry) => entry.status === "fulfilled" ? { state: "fulfilled" } : { state: "rejected", errorType: entry.reason instanceof Error ? entry.reason.name : "UnknownError" })
        });
        throw new Error("Hop race response parsing failed; see sanitized attachment.");
      }
      const hopBody = bodies[0].value;
      const mutationBody = bodies[1].value;
      const hopResponse = hopSubmission.response;
      const mutationResponse = mutationSubmission.response;
      await attachJson(testInfo, `operational-v2-hop-mutation-${kind}-responses`, {
        runId, kind, sourceId, endValidation, mutationHeldMs,
        hopCommand: safeCommandEvidence(capturedHop), mutationCommand: safeCommandEvidence(capturedMutation),
        hopResponse: safeResponseEvidence(hopResponse.status(), hopBody),
        mutationResponse: safeResponseEvidence(mutationResponse.status(), mutationBody),
        hopSubmission: { startedAt: hopSubmission.startedAt, completedAt: hopSubmission.completedAt, elapsedMs: hopSubmission.elapsedMs },
        mutationSubmission: { startedAt: mutationSubmission.startedAt, completedAt: mutationSubmission.completedAt, elapsedMs: mutationSubmission.elapsedMs }
      });
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
          organization_id: `eq.${organizationId}`, session_id: `eq.${sourceId}`, select: "id,inventory_item_id,name,quantity,unit_price,sale_variant_id,sold_as_pack_of", order: "id.asc"
        }),
        readRestRows<{ id: string; description: string; quantity: number | string; unit_price: number | string; linked_session_id: string | null; inventory_item_id: string | null; sale_variant_id: string | null; sold_as_pack_of: number | string | null }>(
          page, origin.restBase, origin.headers, "bill_lines",
          { organization_id: `eq.${organizationId}`, bill_id: `eq.${billId}`, select: "id,description,quantity,unit_price,linked_session_id,inventory_item_id,sale_variant_id,sold_as_pack_of", order: "id.asc" }
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
      await attachJson(testInfo, `operational-v2-hop-mutation-${kind}-before-assertions`, {
        runId, sourceId, billId, kind, mutationStatus: mutationResponse.status(),
        sessions, pauseLogs, itemsAfterBill, billLines, events, hopAudits, mutationAudits
      });
      const billedInventory = billLines.filter((line) => line.inventory_item_id);
      expect(billedInventory.every((line) => line.linked_session_id === null)).toBe(true);
      expect(billedInventory.map((line) => ({
        inventoryItemId: line.inventory_item_id, name: line.description,
        saleVariantId: line.sale_variant_id, soldAsPackOf: line.sold_as_pack_of === null ? null : Number(line.sold_as_pack_of),
        quantity: Number(line.quantity), unitPrice: Number(line.unit_price)
      })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual(
        itemsAfterBill.map((item) => ({
          inventoryItemId: item.inventory_item_id, name: Number(item.sold_as_pack_of) ? `${item.name} (Pack of ${Number(item.sold_as_pack_of)})` : item.name,
          saleVariantId: item.sale_variant_id, soldAsPackOf: item.sold_as_pack_of === null ? null : Number(item.sold_as_pack_of),
          quantity: Number(item.quantity), unitPrice: Number(item.unit_price)
        })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      );
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({ id: sourceId, status: "closed", close_disposition: "billed", closed_bill_id: billId });
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

      if (kind === "timing") {
        if (mutationResponse.status() === 200) {
          const intendedStartedAt = String(mutationParts.payload.startedAt ?? "");
          expect(intendedStartedAt).toBeTruthy();
          expect(Date.parse(sessions[0].started_at)).toBe(Date.parse(intendedStartedAt));
        } else {
          expect(Date.parse(sessions[0].started_at), "Rejected timing mutation must leave canonical start unchanged.")
            .toBe(Date.parse(sessionBeforeRace[0].started_at));
        }
      }
      if (kind === "pause") {
        if (mutationResponse.status() === 200) {
          expect(pauseLogs).toHaveLength(pauseLogsBeforeRace.length + 1);
          const newPauses = pauseLogs.filter((row) => !pauseLogsBeforeRace.some((before) => before.id === row.id));
          expect(newPauses).toHaveLength(1);
          expect(newPauses[0].resumed_at, "Successful competing pause must be closed by the hop.").not.toBeNull();
        } else {
          expect(pauseLogs, "Rejected pause mutation must not create a pause row.").toEqual(pauseLogsBeforeRace);
        }
      }
      if (kind === "add-item") {
        const itemId = capturedItemId(kind, mutationParts.payload);
        const delta = exactItemDelta(itemsBeforeRace.map((row) => row.id), itemsAfterBill.map((row) => row.id));
        expect(delta).toEqual(mutationResponse.status() === 200 ? { added: [itemId], removed: [] } : { added: [], removed: [] });
        expect(billLines.some((row) => row.id === `line-item-${itemId}`)).toBe(mutationResponse.status() === 200);
      }
      if (kind === "remove-item") {
        const itemId = capturedItemId(kind, mutationParts.payload);
        const delta = exactItemDelta(itemsBeforeRace.map((row) => row.id), itemsAfterBill.map((row) => row.id));
        expect(delta).toEqual(mutationResponse.status() === 200 ? { added: [], removed: [itemId] } : { added: [], removed: [] });
        expect(billLines.some((row) => row.id === `line-item-${itemId}`)).toBe(mutationResponse.status() !== 200);
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
        hopCommand: safeCommandEvidence(capturedHop),
        mutationCommand: safeCommandEvidence(capturedMutation),
        hopSubmission: { startedAt: hopSubmission.startedAt, completedAt: hopSubmission.completedAt, elapsedMs: hopSubmission.elapsedMs },
        mutationSubmission: { startedAt: mutationSubmission.startedAt, completedAt: mutationSubmission.completedAt, elapsedMs: mutationSubmission.elapsedMs },
        sessionBeforeRace,
        pauseLogsBeforeRace,
        itemsBeforeRace,
        sessions,
        pauseLogs,
        itemsAfterBill,
        billLines,
        events,
        hopAudits,
        mutationAudits
      });
      const originQueue = await readPendingOperationalMutations(page);
      const observerQueue = await readPendingOperationalMutations(observer.page);
      const expectedKind = {
        timing: "saveLiveSessionDetails", pause: "pauseSession", resume: "resumeSession",
        "add-item": "addSessionItem", "remove-item": "removeSessionItem"
      }[kind];
      const safeQueue = (queue: unknown) => Array.isArray(queue) ? queue.map((entry) => ({
        id: entry?.id, kind: entry?.kind, status: entry?.status, entityType: entry?.entityType, entityId: entry?.entityId
      })) : { malformed: true };
      await attachJson(testInfo, `operational-v2-hop-mutation-${kind}-queue-before-disposal`, {
        kind, mutationId, sourceId, mutationStatus: mutationResponse.status(),
        origin: safeQueue(originQueue), observer: safeQueue(observerQueue)
      });
      const sanitizedObserverQueue = validateRaceQueues({
        origin: originQueue, observer: observerQueue, status: mutationResponse.status(),
        rejectionCode: rpcRejectionCode(mutationBody), mutationId, mutationKind: expectedKind, sessionId: sourceId
      });
      if (mutationResponse.status() === 400) {
        await expect(observer.page.getByText("1 conflict", { exact: true })).toBeVisible();
        await expect(observer.page.getByText("Pending sync.", { exact: false })).toHaveCount(0);
      } else {
        await expect(observer.page.getByText("1 conflict", { exact: true })).toHaveCount(0);
      }
      expect(originErrors, `${kind} fresh origin must have no unexpected page errors.`).toEqual({ consoleErrors: [], pageErrors: [] });
      expect(observerErrors, `${kind} fresh observer must have no unexpected page errors.`).toEqual({ consoleErrors: [], pageErrors: [] });
      scenarioDiagnostics.push({
        kind, originActorId: origin.actorId, observerActorId: second.actorId,
        mutationStatus: mutationResponse.status(), originErrors, observerErrors,
        originPendingOperationalMutations: [], observerPendingOperationalMutations: sanitizedObserverQueue
      });
      await originContext.context.close();
      activeOrigin = undefined;
      await observer.context.close();
      activeObserver = undefined;
    }

    expect(evidence.map((entry) => entry.kind)).toEqual(["timing", "pause", "resume", "add-item", "remove-item"]);
    expect([...unresolvedSourceIds]).toEqual([]);
    expect(scenarioDiagnostics.map((entry) => entry.kind)).toEqual(["timing", "pause", "resume", "add-item", "remove-item"]);
    await attachJson(testInfo, "operational-v2-hop-mutation-races", { runId, evidence, dialogs, rpcEvidence, scenarioDiagnostics });
  } catch (error) {
    primaryError = error;
  } finally {
    activeHopCommand?.cancel();
    activeMutationCommand?.cancel();
    await finalization.run("hop command disposal", () => activeHopCommand?.dispose());
    await finalization.run("mutation command disposal", () => activeMutationCommand?.dispose());
    await finalization.run("cleanup ledger evidence", () => attachJson(testInfo, "operational-v2-hop-mutation-cleanup-ledger", {
      runId,
      unresolvedSourceIds: [...unresolvedSourceIds],
      failed: Boolean(primaryError)
    }));
    await finalization.run("origin failure screenshot", () => activeOrigin ? attachFailureScreenshot(testInfo, activeOrigin.page, "hop-mutation-races-origin-failure") : undefined);
    await finalization.run("observer failure screenshot", () => activeObserver ? attachFailureScreenshot(testInfo, activeObserver.page, "hop-mutation-races-observer-failure") : undefined);
    await finalization.run("origin context close", () => activeOrigin?.context.close());
    await finalization.run("observer context close", () => activeObserver?.context.close());
  }
  if (primaryError) throw primaryError;
  finalization.throwIfFailed();
  if (unresolvedSourceIds.size) throw new Error("Hop mutation races left exact unresolved staging sessions; reconcile before another run.");
});
