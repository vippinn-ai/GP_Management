import { readFile } from "node:fs/promises";
import { expect, test, type Download } from "@playwright/test";
import * as XLSX from "xlsx";
import { createFailurePreservingCleanup } from "../../../src/qa/failurePreservingCleanup";
import {
  assertNoPageErrors,
  attachFailureScreenshot,
  attachJson,
  capturePageErrors,
  credentials,
  signIn
} from "./support/app";

async function readDownload(download: Download): Promise<Buffer> {
  const failure = await download.failure();
  expect(failure).toBeNull();
  const path = await download.path();
  if (!path) throw new Error(`Playwright did not retain ${download.suggestedFilename()}.`);
  return readFile(path);
}

test("normalized reports export complete CSV, Excel, and PDF files", async ({ page }, testInfo) => {
  const finalization = createFailurePreservingCleanup();
  const errors = capturePageErrors(page);
  const browserChunks: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (/(?:xlsx|jspdf)[^/]*-[^/]+\.js$/i.test(pathname)) browserChunks.push(pathname);
  });

  try {
    await signIn(page, credentials("A"));
    await page.getByRole("button", { name: "Analytics", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Operational Reports", exact: true })).toBeVisible();
    await expect(page.getByText("Report range is loaded from backend report data.", { exact: true })).toBeVisible();

    const rangeText = await page.locator(".report-range-chip .muted").last().innerText();
    const range = rangeText.match(/(\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/);
    expect(range, `Unable to parse the rendered report range: ${rangeText}`).not.toBeNull();
    const fileStem = `report-${range![1]}-${range![2]}`;

    const [csvDownload] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Export CSV", exact: true }).click()
    ]);
    expect(browserChunks).toEqual([]);
    const xlsxStartedAt = performance.now();
    const [xlsxDownload] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Export Excel", exact: true }).click()
    ]);
    const xlsxMs = performance.now() - xlsxStartedAt;
    expect(browserChunks.filter((path) => /xlsx-/i.test(path))).toHaveLength(1);
    expect(browserChunks.filter((path) => /jspdf[^/]*-/i.test(path))).toHaveLength(0);
    const pdfStartedAt = performance.now();
    const [pdfDownload] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Export PDF", exact: true }).click()
    ]);
    const pdfMs = performance.now() - pdfStartedAt;
    expect(browserChunks.filter((path) => /jspdf[^/]*-/i.test(path))).toHaveLength(1);

    expect(csvDownload.suggestedFilename()).toBe(`${fileStem}.csv`);
    expect(xlsxDownload.suggestedFilename()).toBe(`${fileStem}.xlsx`);
    expect(pdfDownload.suggestedFilename()).toBe(`${fileStem}.pdf`);

    const [csvBuffer, xlsxBuffer, pdfBuffer] = await Promise.all([
      readDownload(csvDownload),
      readDownload(xlsxDownload),
      readDownload(pdfDownload)
    ]);
    const csvText = csvBuffer.toString("utf8");
    expect(csvText).toContain("Bill Number,Date,Station,Customer,Payment Mode,Total,Status");
    expect(csvText).toContain("BILL-20260820-006");

    const workbook = XLSX.read(xlsxBuffer, { type: "buffer" });
    expect(workbook.SheetNames).toContain("Daily Report");
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets["Daily Report"]);
    expect(rows.some((row) => row.billNumber === "BILL-20260820-006")).toBe(true);

    expect(pdfBuffer.subarray(0, 4).toString("ascii")).toBe("%PDF");
    expect(pdfBuffer.byteLength).toBeGreaterThan(500);
    expect(xlsxMs).toBeLessThanOrEqual(2_000);
    expect(pdfMs).toBeLessThanOrEqual(2_000);
    assertNoPageErrors(errors);

    await attachJson(testInfo, "release-a-report-export-evidence", {
      range: { from: range![1], to: range![2] },
      files: {
        csv: { name: csvDownload.suggestedFilename(), bytes: csvBuffer.byteLength },
        xlsx: { name: xlsxDownload.suggestedFilename(), bytes: xlsxBuffer.byteLength, rows: rows.length },
        pdf: { name: pdfDownload.suggestedFilename(), bytes: pdfBuffer.byteLength }
      },
      browserChunks,
      timingsMs: { xlsx: xlsxMs, pdf: pdfMs },
      verifiedBillNumber: "BILL-20260820-006"
    });
  } finally {
    await finalization.run("failure screenshot", () => attachFailureScreenshot(testInfo, page, "report-export-failure"));
  }
  finalization.throwIfFailed();
});

for (const exporter of [
  { name: "spreadsheet", route: "**/assets/xlsx-*.js", button: "Export Excel", error: "Unable to load the spreadsheet exporter" },
  { name: "PDF", route: "**/assets/jspdf*.js", button: "Export PDF", error: "Unable to load the PDF exporter" }
] as const) {
  test(`a failed ${exporter.name} chunk is visible and succeeds after an explicit reload`, async ({ page }, testInfo) => {
    const finalization = createFailurePreservingCleanup();
    const errors = capturePageErrors(page);
    const alertPromise = new Promise<string>((resolve) => {
      page.once("dialog", async (dialog) => {
        resolve(dialog.message());
        await dialog.accept();
      });
    });
    try {
      await signIn(page, credentials("A"));
      await page.getByRole("button", { name: "Analytics", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Operational Reports", exact: true })).toBeVisible();
      await expect(page.getByText("Report range is loaded from backend report data.", { exact: true })).toBeVisible();
      await page.route(exporter.route, (route) => route.abort("failed"));
      await page.getByRole("button", { name: exporter.button, exact: true }).click();
      const alertMessage = await alertPromise;
      expect(alertMessage).toContain(exporter.error);

      await page.unroute(exporter.route);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Analytics", exact: true }).click();
      await expect(page.getByText("Report range is loaded from backend report data.", { exact: true })).toBeVisible();
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("button", { name: exporter.button, exact: true }).click()
      ]);
      const bytes = await readDownload(download);
      expect(bytes.byteLength).toBeGreaterThan(500);
      await attachJson(testInfo, `release-a-${exporter.name.toLowerCase()}-export-recovery-evidence`, {
        exporter: exporter.name,
        alertMessage,
        recoveredFilename: download.suggestedFilename(),
        recoveredBytes: bytes.byteLength
      });
      assertNoPageErrors(errors);
    } finally {
      await finalization.run("export route cleanup", () => page.unroute(exporter.route));
      await finalization.run("failure screenshot", () => attachFailureScreenshot(testInfo, page, `report-${exporter.name.toLowerCase()}-export-recovery-failure`));
    }
    finalization.throwIfFailed();
  });
}
