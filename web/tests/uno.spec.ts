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

async function game(context: BrowserContext, path: string) {
  const response = await context.request.get("/api/v1" + path);
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

async function actOnGame(
  context: BrowserContext,
  roomId: string,
  current: {
    id: string;
    version: number;
    round?: number;
    phase: string;
    tie?: boolean;
  },
  action: string,
  extra: Record<string, unknown> = {},
) {
  return post(context, `/rooms/${roomId}/games/${current.id}`, {
    action,
    version: current.version,
    game_id: current.id,
    round: current.round || 0,
    phase: current.phase,
    tie: current.tie || false,
    ...extra,
  });
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

async function openGames(page: Page, host = false) {
  await page
    .locator(host ? ".tabs" : ".guest-bottom")
    .getByRole("button", { name: "Games", exact: true })
    .click();
}

async function expectHandBelowTable(page: Page) {
  const table = await page.locator(".uno-table").boundingBox();
  const hand = await page.locator(".uno-hand-dock").boundingBox();
  expect(table).not.toBeNull();
  expect(hand).not.toBeNull();
  expect(hand!.x).toBeCloseTo(table!.x, 0);
  expect(hand!.y).toBeCloseTo(table!.y + table!.height, 0);
  expect(hand!.width).toBeCloseTo(table!.width, 0);
  if ((page.viewportSize()?.width || 0) <= 1000) {
    const side = await page.locator(".uno-side-panel").boundingBox();
    expect(side).not.toBeNull();
    expect(side!.y).toBeGreaterThanOrEqual(hand!.y + hand!.height);
  }
}

test("UNO: multiplayer seats, private hands, real turns and mobile layout", async ({
  browser,
  baseURL,
}) => {
  const contexts: BrowserContext[] = [];
  try {
    const host = await browser.newContext({ baseURL });
    contexts.push(host);
    await authenticateHost(host);
    const room = await post(host, "/rooms", {
      name: "UNO night UNO 之夜",
      duration: 7200,
      retention: 86400,
    });
    const guest = await browser.newContext({
      baseURL,
      viewport: { width: 390, height: 844 },
    });
    contexts.push(guest);
    await post(guest, "/join", { code: room.code, name: "UNO Guest" });

    const hostPage = await host.newPage();
    await hostPage.goto("/room/" + room.id);
    await hostPage.locator("#language").selectOption("en");
    await openGames(hostPage, true);
    const unoEntry = hostPage.locator(".game-library article").filter({
      has: hostPage.getByRole("heading", { name: "UNO", exact: true }),
    });
    await unoEntry.getByRole("button", { name: "Enter UNO" }).click();
    await expect(hostPage).toHaveURL("/room/" + room.id + "/uno");
    await expect(hostPage.locator(".uno-topbar")).toBeVisible();
    await expect(hostPage.locator(".app-header")).toHaveCount(0);
    await expect(hostPage.locator("#uno-player-count")).toHaveValue("4");
    await hostPage.screenshot({
      path: "test-results/uno-setup-1280.png",
      fullPage: true,
    });
    await hostPage.getByRole("button", { name: "Create table" }).click();
    await expect(hostPage).toHaveURL(
      new RegExp(`/room/${room.id}/uno/[^/]+$`),
    );
    const gameId = hostPage.url().split("/").pop()!;
    await expect(hostPage.locator(".uno-lobby")).toBeVisible();
    await hostPage.getByRole("button", { name: "Take a seat" }).click();
    await expect(
      hostPage.getByRole("button", { name: "Start game" }),
    ).toBeEnabled();

    const guestPage = await guest.newPage();
    await guestPage.goto("/room/" + room.id + "/uno/" + gameId);
    await guestPage.locator("#language").selectOption("en");
    await expect(guestPage.locator(".uno-lobby")).toBeVisible();
    await guestPage.getByRole("button", { name: "Take a seat" }).click();
    await expect(hostPage.locator(".uno-lobby")).toContainText("2 / 4");
    await expect(hostPage.locator(".uno-lobby")).toContainText(
      "2 AI players will fill the empty seats",
    );

    const gameURL = "/rooms/" + room.id + "/games/" + gameId;
    const created = await game(host, gameURL);
    expect(created.kind).toBe("uno");
    expect(created.language).toBe("en");
    expect(created.player_count).toBe(4);
    expect(created.players).toHaveLength(2);
    await hostPage.getByRole("button", { name: "Start game" }).click();
    await expect(hostPage.locator(".uno-table")).toBeVisible();
    await expect(guestPage.locator(".uno-table")).toBeVisible();
    await expectHandBelowTable(hostPage);
    await expectHandBelowTable(guestPage);
    await hostPage.screenshot({
      path: "test-results/uno-table-1280.png",
      fullPage: true,
    });

    const started = await game(host, gameURL);
    expect(started.players).toHaveLength(4);
    expect(
      started.players.filter((player: { ai?: boolean }) => player.ai),
    ).toHaveLength(2);
    const hands = new Map<BrowserContext, number[]>();
    for (const [context, page] of [
      [host, hostPage],
      [guest, guestPage],
    ] as const) {
      const view = await game(context, gameURL);
      expect(view.mine.hand).toHaveLength(7);
      expect(view.mine.playable_card_ids).toEqual(expect.any(Array));
      for (const player of view.players) expect(player.hand).toBeUndefined();
      const ids = view.mine.hand.map((card: { id: number }) => card.id);
      hands.set(context, ids);
      await expect(page.locator(".uno-hand [data-card-id]")).toHaveCount(7);
      const visibleIds = await page
        .locator(".uno-hand [data-card-id]")
        .evaluateAll((cards) =>
          cards
            .map((card) => Number(card.getAttribute("data-card-id")))
            .sort((a, b) => a - b),
        );
      expect(visibleIds).toEqual([...ids].sort((a, b) => a - b));
    }
    for (const id of hands.get(host)!)
      expect(hands.get(guest)).not.toContain(id);

    const hostSnapshot = await (
      await host.request.get("/api/v1/rooms/" + room.id + "/snapshot")
    ).json();
    const guestSnapshot = await (
      await guest.request.get("/api/v1/rooms/" + room.id + "/snapshot")
    ).json();
    const actorIsHost =
      started.current_player_id === hostSnapshot.participant_id;
    const actor = actorIsHost ? host : guest;
    const actorPage = actorIsHost ? hostPage : guestPage;
    const actorId = actorIsHost
      ? hostSnapshot.participant_id
      : guestSnapshot.participant_id;
    expect([
      hostSnapshot.participant_id,
      guestSnapshot.participant_id,
    ]).toContain(started.current_player_id);
    const before = await game(actor, gameURL);
    expect(before.current_player_id).toBe(actorId);
    expect(before.phase).toBe("turn");
    let played = false;
    const playable: number[] = before.mine.playable_card_ids;
    if (playable.length) {
      const card = before.mine.hand.find(
        (candidate: { id: number }) => candidate.id === playable[0],
      );
      await actorPage.locator(`[data-card-id="${playable[0]}"]`).click();
      if (card.type === "wild" || card.type === "wildDrawFour")
        await actorPage.locator('.uno-color-choice[data-color="red"]').click();
      played = true;
    } else {
      await actorPage.locator(".uno-draw").click();
      await expect
        .poll(async () => (await game(actor, gameURL)).phase)
        .toBe("drawn");
      const drawn = await game(actor, gameURL);
      expect(drawn.current_player_id).toBe(actorId);
      for (const id of drawn.mine.playable_card_ids)
        expect(id).toBe(drawn.mine.drawn_card_id);
      await actorPage.locator(".uno-pass").click();
    }
    await expect
      .poll(async () => (await game(actor, gameURL)).version)
      .toBeGreaterThan(before.version);
    const after = await game(actor, gameURL);
    expect(after.mine.hand).toHaveLength(
      before.mine.hand.length + (played ? -1 : 1),
    );
    const nextPlayer = after.players.find(
      (player: { id: string }) => player.id === after.current_player_id,
    );
    expect(nextPlayer.ai).toBeFalsy();

    const beforeReload = await game(actor, gameURL);
    await actorPage.reload();
    await expect(actorPage).toHaveURL("/room/" + room.id + "/uno/" + gameId);
    await expect(actorPage.locator(".uno-hand")).toBeVisible();
    const restored = await game(actor, gameURL);
    expect(restored.version).toBe(beforeReload.version);
    expect(restored.current_player_id).toBe(beforeReload.current_player_id);
    expect(restored.mine.hand).toEqual(beforeReload.mine.hand);
    await expect(actorPage.locator(".uno-hand [data-card-id]")).toHaveCount(
      restored.mine.hand.length,
    );

    for (const width of [320, 390, 768]) {
      await guestPage.setViewportSize({ width, height: 900 });
      await expectHandBelowTable(guestPage);
      expect(
        await guestPage.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await guestPage.setViewportSize({ width: 320, height: 900 });
    const handWidth = await guestPage
      .locator(".uno-hand")
      .evaluate((element) => ({
        client: element.clientWidth,
        scroll: element.scrollWidth,
      }));
    expect(handWidth.client).toBeGreaterThan(0);
    expect(handWidth.scroll).toBeGreaterThan(handWidth.client);
    await guestPage.screenshot({
      path: "test-results/uno-table-320.png",
      fullPage: true,
    });

    await hostPage.getByRole("button", { name: "Back to room" }).click();
    await expect(hostPage).toHaveURL("/room/" + room.id + "?tab=games");
    await expect(hostPage.locator(".game-center")).toBeVisible();
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("UNO: rules dialog, complete game result and play again", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120000);
  const host = await browser.newContext({ baseURL });
  try {
    await authenticateHost(host);
    const room = await post(host, "/rooms", {
      name: "UNO result test",
      duration: 7200,
      retention: 86400,
    });
    const page = await host.newPage();
    await page.goto("/room/" + room.id + "/uno");
    await page.locator("#language").selectOption("en");

    await page.getByRole("button", { name: "How to play UNO" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").locator("li")).toHaveCount(6);
    await page.getByRole("button", { name: "Got it" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.locator("#uno-player-count").focus();
    await page.locator("#uno-player-count").press("Home");
    await expect(page.locator("#uno-player-count")).toHaveValue("2");
    await page.getByRole("button", { name: "Create table" }).click();
    await expect(page).toHaveURL(new RegExp(`/room/${room.id}/uno/[^/]+$`));
    const gameId = page.url().split("/").pop()!;
    await page.getByRole("button", { name: "Take a seat" }).click();
    await page.getByRole("button", { name: "Start game" }).click();
    await expect(page.locator(".uno-table")).toBeVisible();

    const gameURL = "/rooms/" + room.id + "/games/" + gameId;
    async function waitForVersion(version: number) {
      await expect
        .poll(async () => (await game(host, gameURL)).version)
        .toBeGreaterThan(version);
    }
    let turns = 0;
    for (; turns < 240; turns++) {
      let current = await game(host, gameURL);
      if (current.phase === "finished") break;
      const playable: number[] = current.mine.playable_card_ids;
      let cardId: number | undefined;
      if (current.phase === "turn") {
        if (!playable.length) {
          await expect(page.locator(".uno-draw")).toBeEnabled();
          await page.locator(".uno-draw").click();
          await waitForVersion(current.version);
          continue;
        }
        cardId = playable[0];
      } else if (current.phase === "drawn") {
        if (!playable.length) {
          await expect(page.locator(".uno-pass")).toBeEnabled();
          await page.locator(".uno-pass").click();
          await waitForVersion(current.version);
          continue;
        }
        cardId = current.mine.drawn_card_id;
      } else {
        throw new Error("Unexpected UNO phase: " + current.phase);
      }

      const me = current.players.find(
        (player: { id: string }) => player.id === current.current_player_id,
      );
      if (current.mine.hand.length === 2 && !me.uno_declared) {
        const declare = page.getByRole("button", { name: "Call UNO!" });
        await expect(declare).toBeEnabled();
        await declare.click();
        await expect(
          page.getByRole("button", { name: "UNO called!" }),
        ).toBeVisible();
        current = await game(host, gameURL);
      }
      const card = current.mine.hand.find(
        (candidate: { id: number }) => candidate.id === cardId,
      );
      const cardButton = page.locator(`[data-card-id="${cardId}"]`);
      await expect(cardButton).toBeEnabled();
      await cardButton.click();
      if (card.type === "wild" || card.type === "wildDrawFour") {
        const color = page.locator('.uno-color-choice[data-color="red"]');
        await expect(color).toBeVisible();
        await color.click();
      }
      await waitForVersion(current.version);
    }

    const finished = await game(host, gameURL);
    expect(turns).toBeLessThan(240);
    expect(finished.phase).toBe("finished");
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog")).toContainText(/You won!|wins!/);
    await page.getByRole("button", { name: "Play again" }).click();
    await expect(page.locator(".uno-lobby")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const nextGameId = page.url().split("/").pop();
    expect(nextGameId).not.toBe(gameId);
    expect((await game(host, gameURL)).phase).toBe("finished");
  } finally {
    await host.close();
  }
});

test("UNO: two tables isolate turns, private hands and deep links", async ({
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
      name: "Two independent UNO tables",
      duration: 7200,
      retention: 86400,
    });
    await post(guest, "/join", { code: room.code, name: "Second table guest" });
    const collection = "/rooms/" + room.id + "/games";
    const first = await post(host, collection, {
      action: "create",
      kind: "uno",
      language: "en",
      player_count: 2,
    });
    const second = await post(host, collection, {
      action: "create",
      kind: "uno",
      language: "en",
      player_count: 2,
    });
    expect(second.id).not.toBe(first.id);
    const firstURL = collection + "/" + first.id;
    const secondURL = collection + "/" + second.id;

    const hostPage = await host.newPage();
    await hostPage.goto(`/room/${room.id}/uno/${first.id}`);
    await hostPage.locator("#language").selectOption("en");
    await hostPage.getByRole("button", { name: "Take a seat" }).click();
    await hostPage.getByRole("button", { name: "Start game" }).click();
    await expect(hostPage.locator(".uno-table")).toBeVisible();

    const guestPage = await guest.newPage();
    await guestPage.goto(`/room/${room.id}/uno/${second.id}`);
    await guestPage.locator("#language").selectOption("en");
    await guestPage.getByRole("button", { name: "Take a seat" }).click();
    await expect(guestPage.locator(".uno-lobby-summary")).toContainText("1 / 2");
    const secondLobby = await game(host, secondURL);
    await actOnGame(host, room.id, secondLobby, "start");
    await expect(guestPage.locator(".uno-table")).toBeVisible();

    const hostView = await game(host, firstURL);
    const guestView = await game(guest, secondURL);
    expect(hostView.mine.hand).toHaveLength(7);
    expect(guestView.mine.hand).toHaveLength(7);
    for (const view of [hostView, guestView])
      for (const player of view.players) expect(player.hand).toBeUndefined();
    expect((await game(host, secondURL)).mine?.hand).toBeUndefined();
    expect((await game(guest, firstURL)).mine?.hand).toBeUndefined();
    await expect(hostPage.locator(".uno-hand [data-card-id]")).toHaveCount(7);
    await expect(guestPage.locator(".uno-hand [data-card-id]")).toHaveCount(7);

    async function move(page: Page, context: BrowserContext, path: string) {
      const before = await game(context, path);
      expect(before.phase).toBe("turn");
      const playable: number[] = before.mine.playable_card_ids;
      if (playable.length) {
        const card = before.mine.hand.find(
          (candidate: { id: number }) => candidate.id === playable[0],
        );
        await page.locator(`[data-card-id="${playable[0]}"]`).click();
        if (card.type === "wild" || card.type === "wildDrawFour")
          await page.locator('.uno-color-choice[data-color="red"]').click();
      } else {
        await page.locator(".uno-draw").click();
      }
      await expect
        .poll(async () => (await game(context, path)).version)
        .toBeGreaterThan(before.version);
      return before;
    }

    const secondBeforeFirstMove = await game(guest, secondURL);
    const firstBeforeMove = await move(hostPage, host, firstURL);
    const firstAfterMove = await game(host, firstURL);
    expect(firstAfterMove.version).toBeGreaterThan(firstBeforeMove.version);
    expect((await game(guest, secondURL)).version).toBe(
      secondBeforeFirstMove.version,
    );

    const firstBeforeSecondMove = await game(host, firstURL);
    const secondBeforeMove = await move(guestPage, guest, secondURL);
    expect((await game(guest, secondURL)).version).toBeGreaterThan(
      secondBeforeMove.version,
    );
    expect((await game(host, firstURL)).version).toBe(
      firstBeforeSecondMove.version,
    );

    const firstBeforeReload = await game(host, firstURL);
    const secondBeforeReload = await game(guest, secondURL);
    await Promise.all([hostPage.reload(), guestPage.reload()]);
    await expect(hostPage).toHaveURL(`/room/${room.id}/uno/${first.id}`);
    await expect(guestPage).toHaveURL(`/room/${room.id}/uno/${second.id}`);
    await expect(hostPage.locator(".uno-hand")).toBeVisible();
    await expect(guestPage.locator(".uno-hand")).toBeVisible();
    expect((await game(host, firstURL)).mine.hand).toEqual(
      firstBeforeReload.mine.hand,
    );
    expect((await game(guest, secondURL)).mine.hand).toEqual(
      secondBeforeReload.mine.hand,
    );

    await hostPage
      .getByRole("button", { name: "Back to UNO lobby" })
      .click();
    await expect(hostPage).toHaveURL(`/room/${room.id}/uno`);
    await expect(hostPage.locator(".uno-table-card")).toHaveCount(2);
    await expect(
      hostPage.locator(`.uno-table-card[data-game-id="${first.id}"]`),
    ).toBeVisible();
    await expect(
      hostPage.locator(`.uno-table-card[data-game-id="${second.id}"]`),
    ).toBeVisible();
    const summaries = (await game(host, collection + "?kind=uno")).games;
    expect(summaries).toHaveLength(2);
    for (const summary of summaries) {
      expect(summary.players).toBeUndefined();
      expect(summary.mine).toBeUndefined();
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("UNO: create beside another active game without changing it", async ({
  browser,
  baseURL,
}) => {
  const host = await browser.newContext({ baseURL });
  try {
    await authenticateHost(host);
    const room = await post(host, "/rooms", {
      name: "UNO independent creation test",
      duration: 7200,
      retention: 86400,
    });
    const collection = "/rooms/" + room.id + "/games";
    const undercover = await post(host, collection, {
      action: "create",
      kind: "undercover",
      language: "en",
    });
    expect(undercover.phase).toBe("lobby");

    const page = await host.newPage();
    await page.goto("/room/" + room.id + "/uno");
    await page.locator("#language").selectOption("en");
    await expect(page.locator(".uno-other-game-warning")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Create table" }),
    ).toBeEnabled();

    await page.locator("#uno-player-count").focus();
    await page.locator("#uno-player-count").press("Home");
    await page.getByRole("button", { name: "Create table" }).click();
    await expect(page).toHaveURL(new RegExp(`/room/${room.id}/uno/[^/]+$`));
    const gameId = page.url().split("/").pop()!;
    const uno = await game(host, collection + "/" + gameId);
    expect(uno.kind).toBe("uno");
    expect(uno.phase).toBe("lobby");
    expect(uno.player_count).toBe(2);

    const original = await game(host, collection + "/" + undercover.id);
    expect(original.version).toBe(undercover.version);
    expect(original.phase).toBe("lobby");
    expect(original.result).not.toBe("cancelled");
  } finally {
    await host.close();
  }
});
