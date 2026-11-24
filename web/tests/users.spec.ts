import { test, expect } from "@playwright/test";
import { hostSession } from "./host-session";

test("administrator manages users and deleting an account revokes its access", async ({
  browser,
  context,
  page,
  baseURL,
}) => {
  const username = `e2e-user-${Date.now()}`;
  const password = "managed-user-password-2026";
  const roomName = `Managed room ${Date.now()}`;
  await hostSession(context);
  await page.goto("/");
  await page.locator("#language").selectOption("en");
  await page.getByRole("link", { name: "Manage users", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "User management", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".user-card", { hasText: "e2e-host" })).toHaveCount(
    0,
  );

  await page
    .getByRole("button", { name: "Add user", exact: true })
    .first()
    .click();
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel(/^Password/).fill(password);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Add user", exact: true })
    .click();
  const userRow = page.locator(".user-card", { hasText: username });
  await expect(userRow).toBeVisible();
  await expect(userRow).toContainText("No rooms");

  const userContext = await browser.newContext({ baseURL });
  try {
    const userPage = await userContext.newPage();
    await userPage.goto("/login");
    await userPage.locator("#language").selectOption("en");
    await userPage.getByLabel("Username", { exact: true }).fill(username);
    await userPage.getByLabel(/^Password/).fill(password);
    await userPage
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    await expect(
      userPage.getByRole("heading", { name: "Your rooms", exact: true }),
    ).toBeVisible();
    await expect(userPage.locator(".eyebrow")).toHaveText("User");
    await expect(
      userPage.getByRole("link", { name: "Manage users" }),
    ).toHaveCount(0);
    expect((await userPage.request.get("/api/v1/users")).status()).toBe(403);

    await userPage.goto("/admin/users");
    await userPage.waitForURL((url) => new URL(url).pathname === "/");
    await expect(
      userPage.getByRole("heading", { name: "Your rooms", exact: true }),
    ).toBeVisible();

    await userPage
      .getByRole("button", { name: "Create a room", exact: true })
      .first()
      .click();
    await userPage.getByLabel("Room name", { exact: true }).fill(roomName);
    await userPage
      .getByRole("button", { name: "Create & invite", exact: true })
      .click();
    await userPage.waitForURL("**/room/**");
    await userPage.getByRole("button", { name: "Close", exact: true }).click();
    await userPage.goto("/");
    await page.reload();
    await expect(
      page.locator(".user-card", { hasText: username }),
    ).toContainText("1 room");

    await userPage
      .getByRole("button", { name: "Sign out", exact: true })
      .click();
    await expect(
      userPage.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await userPage.getByLabel("Username", { exact: true }).fill(username);
    await userPage.getByLabel(/^Password/).fill(password);
    await userPage
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    await expect(
      userPage.locator(".room-card", { hasText: roomName }),
    ).toBeVisible();

    await userRow
      .getByRole("button", { name: `Delete ${username}`, exact: true })
      .click();
    const confirmation = page.getByRole("dialog");
    await expect(confirmation).toContainText("owned rooms (1 total)");
    const deleteButton = confirmation.getByRole("button", {
      name: "Delete",
      exact: true,
    });
    await expect(deleteButton).toBeDisabled();
    await confirmation
      .getByLabel("Type the username to confirm deletion", { exact: true })
      .fill(username);
    await expect(deleteButton).toBeEnabled();
    await deleteButton.click();
    await expect(userRow).toHaveCount(0);

    await userPage.reload();
    await userPage.waitForURL("**/login");
    await expect(
      userPage.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeVisible();
    const status = await (await userPage.request.get("/api/v1/status")).json();
    expect(status.authenticated).toBe(false);
  } finally {
    await userContext.close();
  }
});
