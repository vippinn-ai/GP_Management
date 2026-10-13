import { expect, type Locator } from "@playwright/test";

// filter.has is evaluated relative to each row: do not repeat the dialog ancestor.
export async function singleSessionItemRemoveButton(modal: Locator) {
  const rows = modal.locator(".session-item-row").filter({
    has: modal.page().getByRole("button", { name: "Remove", exact: true })
  });
  await expect(rows, "The isolated removal fixture must have exactly one removable item.").toHaveCount(1);
  await expect(rows).toBeVisible();
  const button = rows.getByRole("button", { name: "Remove", exact: true });
  await expect(button).toHaveCount(1);
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
  return button;
}
