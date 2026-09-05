import { expect, test } from "@playwright/test";
import { attachJson, credentials, signIn } from "./support/app";

const runId = process.env.E2E_RUN_ID ?? "missing-run-id";
const searchPlaceholder = "Search bill #, customer name or phone...";

test("bill-register search retains its input node, focus, and scroll position while normalized results refresh", async ({ page }, testInfo) => {
  await signIn(page, credentials("A"));
  await page.getByRole("button", { name: "Bill Register", exact: true }).click();

  const main = page.locator("main.main-content.is-bills-tab");
  const search = page.getByPlaceholder(searchPlaceholder);
  await expect(search).toBeVisible();
  await expect(page.getByText("Normalized history active", { exact: true })).toBeVisible();

  await search.focus();
  await main.evaluate((element) => {
    element.scrollTop = Math.min(120, element.scrollHeight - element.clientHeight);
  });
  const inputHandle = await search.elementHandle();
  if (!inputHandle) throw new Error("The bill-register search input was not attached before typing.");
  const before = await page.evaluate((placeholder) => {
    const mainElement = document.querySelector("main.main-content.is-bills-tab");
    return {
      activePlaceholder: document.activeElement?.getAttribute("placeholder") ?? null,
      mainScrollTop: mainElement?.scrollTop ?? null,
      windowScrollY: window.scrollY
    };
  }, searchPlaceholder);

  await page.keyboard.type("B");
  await expect(search).toHaveValue("B");
  await expect(page.getByText("Normalized history active", { exact: true })).toBeVisible();

  const inputStillConnected = await inputHandle.evaluate((element) => element.isConnected);
  const after = await page.evaluate((placeholder) => {
    const mainElement = document.querySelector("main.main-content.is-bills-tab");
    return {
      activePlaceholder: document.activeElement?.getAttribute("placeholder") ?? null,
      expectedPlaceholder: placeholder,
      mainScrollTop: mainElement?.scrollTop ?? null,
      windowScrollY: window.scrollY
    };
  }, searchPlaceholder);

  await attachJson(testInfo, "bill-register-search-stability", {
    runId,
    viewport: page.viewportSize(),
    typedValue: await search.inputValue(),
    inputStillConnected,
    before,
    after
  });

  expect(inputStillConnected, "Typing must not replace the focused search input DOM node.").toBe(true);
  expect(after.activePlaceholder, "The bill-register search must retain keyboard focus.").toBe(searchPlaceholder);
  expect(after.mainScrollTop, "Refreshing normalized results must not reset the bill-register scroll position.").toBe(before.mainScrollTop);
});
