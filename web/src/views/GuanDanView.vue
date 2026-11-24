<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { ArrowLeft, Spade, Users } from "lucide-vue-next";
import { api, errorCode, notify } from "../api";
import { useRoomSync } from "../roomSync";
import { useGuanDanList } from "../useGameSession";

const route = useRoute();
const router = useRouter();
const { t, locale } = useI18n();
const id = String(route.params.id);
const { snapshot, error, start } = useRoomSync(id);
const enabled = computed(() => Boolean(snapshot.value));
const { games, loaded, failed, refresh } = useGuanDanList(id, enabled);
const creating = ref(false);
const enteringId = ref<string | null>(null);
const closingId = ref<string | null>(null);
const host = computed(
  () =>
    snapshot.value?.role === "host" ||
    Boolean(snapshot.value?.permissions?.includes("games")),
);
const closed = computed(() => snapshot.value?.room.state !== "active");

onMounted(() => {
  void start();
});
function goBack() {
  void router.push({ path: `/room/${id}`, query: { tab: "games" } });
}
async function createTable() {
  if (!host.value || creating.value || closed.value) return;
  creating.value = true;
  try {
    await api(`/rooms/${id}/guandan-games`, "POST", {});
    await refresh();
  } catch (error) {
    notify(t("error." + errorCode(error)));
  } finally {
    creating.value = false;
  }
}
async function closeTable(tableId: string) {
  if (!host.value || closingId.value || closed.value) return;
  closingId.value = tableId;
  try {
    await api(
      `/rooms/${id}/guandan-games/${encodeURIComponent(tableId)}/close`,
      "POST",
      {},
    );
    await refresh();
  } catch (error) {
    notify(t("error." + errorCode(error)));
  } finally {
    closingId.value = null;
  }
}
async function enterTable(tableId: string) {
  if (enteringId.value || closed.value) return;
  const gameWindow = window.open("about:blank", "_blank");
  if (!gameWindow) {
    notify(t("ui.popupBlocked"));
    return;
  }
  gameWindow.opener = null;
  gameWindow.document.title = t("game.guandan");
  enteringId.value = tableId;
  try {
    const result = await api<{ token: string }>(
      `/rooms/${id}/guandan-games/${encodeURIComponent(tableId)}/session`,
      "POST",
      {},
    );
    gameWindow.location.replace(
      `/guandan/?launch=${encodeURIComponent(result.token)}`,
    );
  } catch (error) {
    gameWindow.close();
    notify(t("error." + errorCode(error)));
  } finally {
    enteringId.value = null;
  }
}
</script>

<template>
  <main class="guandan-page">
    <header class="guandan-topbar">
      <button class="guandan-brand" type="button" @click="goBack">
        <Spade :size="23" />{{ t("game.guandan") }}
      </button>
      <span v-if="snapshot" class="guandan-room-name">{{
        snapshot.room.name
      }}</span>
      <div class="guandan-topbar-actions">
        <label class="guandan-language" :aria-label="t('app.language')">
          <select id="language" v-pretty-select v-model="locale">
            <option value="zh">简体中文</option>
            <option value="en">English</option>
          </select>
        </label>
        <button
          class="guandan-text-button"
          type="button"
          :aria-label="t('game.uno.backRoom')"
          @click="goBack"
        >
          <ArrowLeft :size="16" /><span>{{ t("game.uno.backRoom") }}</span>
        </button>
      </div>
    </header>

    <section v-if="!snapshot" class="guandan-access-state">
      <Spade :size="48" />
      <p v-if="error" role="alert">{{ t("error." + error) }}</p>
      <p v-else>{{ t("app.loading") }}</p>
      <button v-if="error" class="guandan-secondary-button" @click="goBack">
        {{ t("game.uno.backRoom") }}
      </button>
    </section>

    <template v-else>
      <section class="guandan-hero">
        <p class="guandan-eyebrow">TABLE LOBBY</p>
        <h1>{{ t("game.guandanLobbyTitle") }}</h1>
        <p>{{ t("game.guandanLobbyHelp") }}</p>
        <button
          v-if="host"
          class="guandan-primary-button"
          :disabled="creating || closed"
          @click="createTable"
        >
          {{ creating ? t("app.working") : t("game.guandanCreate") }}
        </button>
        <p v-else class="guandan-wait-host">{{ t("game.waitHost") }}</p>
      </section>

      <p v-if="failed" class="guandan-offline" role="status">
        {{ t("error.GUANDAN_UNAVAILABLE") }}
        <button @click="refresh">{{ t("activity.retry") }}</button>
      </p>

      <section class="guandan-directory" aria-labelledby="guandan-tables-title">
        <div class="guandan-directory-heading">
          <h2 id="guandan-tables-title">{{ t("game.tables") }}</h2>
          <span>{{ t("game.tableCount", { n: games.length }) }}</span>
        </div>
        <p v-if="!loaded" class="guandan-empty">{{ t("app.loading") }}</p>
        <p v-else-if="!games.length && !failed" class="guandan-empty">
          {{ t("game.guandanEmpty") }}
        </p>
        <div v-else class="guandan-table-grid">
          <article
            v-for="table in games"
            :key="table.id"
            class="guandan-table-card"
            :class="{ unavailable: !table.available }"
            :data-game-id="table.id"
          >
            <div class="guandan-table-heading">
              <strong>{{
                t("game.guandanTableName", { id: table.id.slice(0, 6) })
              }}</strong>
              <span :class="{ available: table.available }">
                {{
                  t(
                    table.available
                      ? "game.guandanAvailable"
                      : "game.guandanUnavailable",
                  )
                }}
              </span>
            </div>
            <div class="guandan-table-stats">
              <span
                ><Users :size="16" />{{
                  t("game.guandanSeats", {
                    count: table.player_count,
                    max: table.max_players,
                  })
                }}</span
              >
              <span>{{
                t(
                  table.closed_at
                    ? "game.guandanClosed"
                    : table.in_game
                      ? "game.guandanInGame"
                      : "game.guandanWaiting",
                )
              }}</span>
            </div>
            <p>{{ t("game.guandanHost", { name: table.host_name }) }}</p>
            <small>{{ table.game_mode }}</small>
            <div class="guandan-table-actions">
              <button
                class="guandan-secondary-button"
                :disabled="
                  enteringId === table.id ||
                  closingId === table.id ||
                  closed ||
                  !table.available ||
                  Boolean(table.closed_at)
                "
                @click="enterTable(table.id)"
              >
                {{
                  enteringId === table.id
                    ? t("app.working")
                    : t("game.guandanEnter")
                }}
              </button>
              <button
                v-if="host && !table.closed_at"
                class="guandan-danger-button"
                :disabled="
                  closingId === table.id ||
                  enteringId === table.id ||
                  closed ||
                  !table.available
                "
                @click="closeTable(table.id)"
              >
                {{
                  closingId === table.id
                    ? t("app.working")
                    : t("game.guandanEnd")
                }}
              </button>
            </div>
          </article>
        </div>
      </section>
    </template>
  </main>
</template>

<style scoped>
.guandan-page {
  --guandan-bg: #111714;
  --guandan-panel: #1b2420;
  --guandan-line: rgba(255, 255, 255, 0.11);
  --guandan-muted: #a8b3ad;
  --guandan-accent: #f1ca52;
  min-height: 100vh;
  background:
    radial-gradient(circle at 50% 0, #25392e 0, transparent 46%),
    var(--guandan-bg);
  color: #f6f8f5;
  color-scheme: dark;
}
.guandan-topbar {
  min-height: 68px;
  padding: 8px clamp(14px, 3vw, 44px);
  display: flex;
  align-items: center;
  gap: 20px;
  border-bottom: 1px solid var(--guandan-line);
  background: #141a17;
}
.guandan-brand {
  padding: 0;
  display: inline-flex;
  align-items: center;
  gap: 9px;
  border: 0;
  background: transparent;
  color: var(--guandan-accent);
  font-size: 23px;
  font-weight: 900;
  cursor: pointer;
}
.guandan-room-name {
  min-width: 0;
  overflow: hidden;
  color: var(--guandan-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.guandan-topbar-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
}
.guandan-language select {
  min-height: 44px;
  border: 0;
  background: transparent;
  color: var(--guandan-muted);
}
.guandan-language :deep(.select-field) {
  width: auto;
}
.guandan-language :deep(.select-face) {
  padding: 8px 32px 8px 10px;
  border-color: transparent;
  background: transparent;
  color: var(--guandan-muted);
  white-space: nowrap;
}
.guandan-text-button {
  min-height: 44px;
  padding: 8px 11px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--guandan-muted);
  cursor: pointer;
}
.guandan-text-button:hover {
  background: rgba(255, 255, 255, 0.06);
  color: #fff;
}
.guandan-hero {
  width: min(900px, calc(100% - 32px));
  margin: 0 auto;
  padding: clamp(38px, 7vh, 72px) 0 34px;
  text-align: center;
}
.guandan-eyebrow {
  margin: 0 0 12px;
  color: var(--guandan-accent);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.2em;
}
.guandan-hero h1 {
  margin: 0;
  font-size: clamp(32px, 5vw, 52px);
}
.guandan-hero > p:not(.guandan-eyebrow) {
  max-width: 620px;
  margin: 18px auto 26px;
  color: var(--guandan-muted);
  line-height: 1.8;
}
.guandan-primary-button,
.guandan-secondary-button,
.guandan-danger-button {
  min-height: 46px;
  padding: 0 22px;
  border-radius: 12px;
  font-weight: 800;
  cursor: pointer;
}
.guandan-primary-button {
  border: 0;
  background: var(--guandan-accent);
  color: #1d1d14;
}
.guandan-secondary-button {
  border: 1px solid var(--guandan-line);
  background: #26322c;
  color: #fff;
}
.guandan-danger-button {
  border: 1px solid #8f4c42;
  background: rgba(143, 76, 66, 0.15);
  color: #ffb4a8;
}
.guandan-primary-button:disabled,
.guandan-secondary-button:disabled,
.guandan-danger-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.guandan-wait-host,
.guandan-empty {
  color: var(--guandan-muted);
}
.guandan-offline {
  width: min(1040px, calc(100% - 32px));
  margin: 0 auto 20px;
  padding: 14px 16px;
  border-radius: 12px;
  background: #4b2e23;
  color: #ffd9c7;
  text-align: center;
}
.guandan-offline button {
  margin-left: 8px;
}
.guandan-directory {
  width: min(1040px, calc(100% - 32px));
  margin: 0 auto;
  padding-bottom: 44px;
}
.guandan-directory-heading {
  margin-bottom: 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.guandan-directory-heading h2 {
  margin: 0;
}
.guandan-directory-heading span,
.guandan-table-card p,
.guandan-table-card small {
  color: var(--guandan-muted);
}
.guandan-table-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.guandan-table-card {
  min-width: 0;
  padding: 22px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 13px;
  border: 1px solid var(--guandan-line);
  border-radius: 18px;
  background: rgba(27, 36, 32, 0.94);
}
.guandan-table-card.unavailable {
  border-style: dashed;
}
.guandan-table-heading,
.guandan-table-stats {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.guandan-table-heading > span {
  color: #e3a79b;
  font-size: 12px;
}
.guandan-table-heading > span.available {
  color: #79d99b;
}
.guandan-table-stats {
  justify-content: flex-start;
  flex-wrap: wrap;
  color: #dce5df;
  font-size: 13px;
}
.guandan-table-stats span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.guandan-table-card p,
.guandan-table-card small {
  margin: 0;
}
.guandan-table-actions {
  width: 100%;
  margin-top: auto;
  display: flex;
  gap: 8px;
}
.guandan-table-card button {
  width: 100%;
  flex: 1;
}
.guandan-access-state {
  min-height: calc(100vh - 68px);
  padding: 40px 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
}
@media (max-width: 700px) {
  .guandan-topbar {
    min-height: 60px;
    padding: 6px 10px;
    gap: 10px;
  }
  .guandan-room-name {
    display: none;
  }
  .guandan-brand {
    font-size: 20px;
  }
  .guandan-text-button {
    width: 44px;
    padding: 8px;
    justify-content: center;
  }
  .guandan-text-button span {
    display: none;
  }
  .guandan-language :deep(.select-field) {
    width: 82px;
  }
  .guandan-language :deep(.select-face) {
    padding: 8px 24px 8px 8px;
    font-size: 11px;
  }
  .guandan-table-grid {
    grid-template-columns: 1fr;
  }
}
</style>
