import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import fs from "node:fs";

async function post(context: BrowserContext, path: string, data: unknown) {
  const response = await context.request.post("/api/v1" + path, {
    headers: { "X-RoomDeck-Request": "1" },
    data,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

async function get(context: BrowserContext, path: string) {
  const response = await context.request.get("/api/v1" + path);
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

async function authenticateHost(context: BrowserContext) {
  const status = await (await context.request.get("/api/v1/status")).json();
  if (status.setup_required)
    await post(context, "/setup", {
      token: fs
        .readFileSync(
          process.env.ROOMDECK_SETUP_TOKEN_FILE ||
            "../.local/e2e-data/setup-token",
          "utf8",
        )
        .trim(),
      username: "e2e-host",
      password: "test-only-strong-password-2026",
    });
  else
    await post(context, "/login", {
      username: "e2e-host",
      password: "test-only-strong-password-2026",
    });
}

async function enterTable(page: Page, gameId: string) {
  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    page
      .locator(`.guandan-table-card[data-game-id="${gameId}"]`)
      .getByRole("button", { name: "Enter table" })
      .click(),
  ]);
  await expect(popup.locator(".waiting-shell")).toBeVisible();
  const nativeId = new URL(popup.url()).searchParams.get("room");
  expect(nativeId).toMatch(/^rd_/);
  await expect(popup.locator(".waiting-title .eyebrow")).toHaveText(
    `ROOM / ${nativeId}`,
  );
  return { popup, nativeId: nativeId! };
}

test("GuanDan: two managed tables run independently and recover the selected table", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120000);
  const contexts: BrowserContext[] = [];
  try {
    const host = await browser.newContext({ baseURL });
    const guest = await browser.newContext({ baseURL });
    contexts.push(host, guest);
    await authenticateHost(host);
    const room = await post(host, "/rooms", {
      name: "Two independent GuanDan tables",
      duration: 7200,
      retention: 86400,
    });
    await post(guest, "/join", {
      code: room.code,
      name: "Second table guest",
    });

    const hostPage = await host.newPage();
    await hostPage.goto(`/room/${room.id}/guandan`);
    await hostPage.locator("#language").selectOption("en");
    for (const count of [1, 2]) {
      await hostPage
        .getByRole("button", { name: "Create Guandan table" })
        .click();
      await expect(hostPage.locator(".guandan-table-card")).toHaveCount(count);
    }
    const tableIds = await hostPage
      .locator(".guandan-table-card")
      .evaluateAll((cards) =>
        cards.map((card) => card.getAttribute("data-game-id")!),
      );
    expect(new Set(tableIds).size).toBe(2);

    const guestPage = await guest.newPage();
    await guestPage.goto(`/room/${room.id}/guandan`);
    await guestPage.locator("#language").selectOption("en");
    await expect(guestPage.locator(".guandan-table-card")).toHaveCount(2);

    const first = await enterTable(hostPage, tableIds[0]);
    const second = await enterTable(guestPage, tableIds[1]);
    expect(second.nativeId).not.toBe(first.nativeId);
    await expect(first.popup.locator(".seat-grid")).toContainText("e2e-host");
    await expect(first.popup.locator(".seat-grid")).not.toContainText(
      "Second table guest",
    );
    await expect(second.popup.locator(".seat-grid")).toContainText(
      "Second table guest",
    );
    await expect(second.popup.locator(".seat-grid")).not.toContainText(
      "e2e-host",
    );

    const collection = `/rooms/${room.id}/guandan-games`;
    await first.popup.getByRole("button", { name: /开始游戏/ }).click();
    await expect(first.popup.locator(".game-screen")).toBeVisible();
    await expect(first.popup.locator(".game-header__identity")).toContainText(
      `GUANDAN / 房间 ${first.nativeId}`,
    );
    await expect(second.popup.locator(".waiting-shell")).toBeVisible();
    await expect
      .poll(async () => {
        const listed = await get(host, collection);
        return listed.games.find(
          (table: { id: string }) => table.id === tableIds[0],
        )?.in_game;
      })
      .toBe(true);
    expect(
      (await get(host, collection)).games.find(
        (table: { id: string }) => table.id === tableIds[1],
      ).in_game,
    ).toBe(false);

    await second.popup.getByRole("button", { name: /开始游戏/ }).click();
    await expect(second.popup.locator(".game-screen")).toBeVisible();
    await expect(second.popup.locator(".game-header__identity")).toContainText(
      `GUANDAN / 房间 ${second.nativeId}`,
    );
    await expect(first.popup.locator(".game-screen")).toBeVisible();
    await expect
      .poll(async () => {
        const listed = await get(host, collection);
        return listed.games.every(
          (table: { in_game: boolean }) => table.in_game,
        );
      })
      .toBe(true);
    for (const tableId of tableIds)
      await expect(
        hostPage.locator(`.guandan-table-card[data-game-id="${tableId}"]`),
      ).toContainText("Game in progress", { timeout: 15000 });

    const anonymous = await browser.newContext({ baseURL });
    contexts.push(anonymous);
    const direct = await anonymous.newPage();
    await direct.goto(
      `/guandan/?room=${encodeURIComponent(first.nativeId)}`,
    );
    await expect(direct.locator(".lobby-shell")).toBeVisible();
    await expect(direct.locator("#room-id")).toHaveValue(first.nativeId);
    await expect(direct.locator(".room-card")).toHaveCount(0);
    await direct.locator("#player-name").fill("Unauthorised visitor");
    await direct.getByRole("button", { name: /进入房间/ }).click();
    await expect(direct.getByRole("alert")).toContainText(
      "该房间需要有效的房间会话",
    );
    await expect(direct.locator(".waiting-shell")).toHaveCount(0);

    await first.popup.close();
    const launch = await post(
      host,
      `${collection}/${tableIds[0]}/session`,
      {},
    );
    const exchanged = await post(host, "/internal/guandan-exchange", {
      token: launch.token,
    });
    expect(exchanged.roomId).toBe(first.nativeId);
    expect(exchanged.roomId).not.toBe(second.nativeId);
    expect(exchanged.managed).toBe(true);

    const restored = await host.newPage();
    await restored.goto(
      `/guandan/?launch=${encodeURIComponent(launch.token)}`,
    );
    await expect(restored.locator(".game-screen")).toBeVisible();
    await expect(restored.locator(".game-header__identity")).toContainText(
      `GUANDAN / 房间 ${first.nativeId}`,
    );
    expect(new URL(restored.url()).searchParams.get("room")).toBe(
      first.nativeId,
    );
    await expect(second.popup.locator(".game-screen")).toBeVisible();
    await expect(second.popup.locator(".game-header__identity")).toContainText(
      `GUANDAN / 房间 ${second.nativeId}`,
    );
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
