import { expect, test } from "@playwright/test";
import { singleSessionItemRemoveButton } from "../staging/support/sessionItemSelectors";

const row = (action = '<button type="button">Remove</button>') =>
  `<div class="session-item-row"><div><strong>Cola</strong></div><div class="session-item-actions"><span>1 x 50</span>${action}</div></div>`;
const modal = (rows: string) => `<div role="dialog" aria-label="8 Ball Pool">${rows}</div>`;

test.beforeEach(async ({ page }) => {
  await page.route("**/*", (route) => route.abort("blockedbyclient"));
});

test("relative row filter finds and clicks the single Remove inside the managed dialog", async ({ page }) => {
  await page.setContent(`${row()}${modal(row('<span>Combo included</span>') + row('<button onclick="this.dataset.clicked=\'yes\'">Remove</button>'))}<div role="dialog" aria-label="Other">${row()}</div>`);
  const managed = page.getByRole("dialog", { name: "8 Ball Pool", exact: true });
  // Reproduce the old ancestor-relative bug against the real nested row shape.
  await expect(managed.locator(".session-item-row").filter({ has: managed.getByRole("button", { name: "Remove", exact: true }) })).toHaveCount(0);
  const button = await singleSessionItemRemoveButton(managed);
  await button.click();
  await expect(button).toHaveAttribute("data-clicked", "yes");
  await expect(page.locator('[data-clicked="yes"]')).toHaveCount(1);
});

for (const [name, rows] of [
  ["missing", row('<span>Combo included</span>')],
  ["duplicate rows", row() + row()],
  ["duplicate buttons", row('<button>Remove</button><button>Remove</button>')],
  ["prefix-only label", row('<button>Remove All</button>')],
  ["disabled", row('<button disabled>Remove</button>')],
  ["hidden", `<div hidden>${row()}</div>`]
]) {
  test(`fails closed for ${name}`, async ({ page }) => {
    await page.setContent(`${row()}${modal(rows)}`);
    await expect(singleSessionItemRemoveButton(page.getByRole("dialog", { name: "8 Ball Pool", exact: true }))).rejects.toThrow();
  });
}
