<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { ArrowLeft, BookOpen, Layers, Sparkles } from "lucide-vue-next";
import { useRoomSync } from "../roomSync";
import { useGameList, useGameSession } from "../useGameSession";
import UnoPanel from "../components/UnoPanel.vue";
import Modal from "../components/Modal.vue";

const route = useRoute();
const router = useRouter();
const { t, locale } = useI18n();
const id = String(route.params.id);
const gameId = computed(() =>
  route.params.gameId ? String(route.params.gameId) : null,
);
const { snapshot, error, start } = useRoomSync(id);
const enabled = computed(() => Boolean(snapshot.value));
const {
  games: unoGames,
  busy: creating,
  loaded: listLoaded,
  failed: listFailed,
  refresh: refreshList,
  create,
} = useGameList(id, "uno", enabled);
const {
  game,
  busy: acting,
  loaded: gameLoaded,
  failed: gameFailed,
  refresh: refreshGame,
  act,
} = useGameSession(
  id,
  gameId,
  computed(() => Boolean(snapshot.value && gameId.value)),
);
const language = ref(locale.value.startsWith("zh") ? "zh" : "en");
const playerCount = ref(4);
const rulesOpen = ref(false);
const myId = computed(() => snapshot.value?.participant_id || "");
const host = computed(
  () =>
    snapshot.value?.role === "host" ||
    Boolean(snapshot.value?.permissions?.includes("games")),
);
const closed = computed(() => snapshot.value?.room.state !== "active");
const uno = computed(() =>
  game.value?.kind === "uno" && game.value.id === gameId.value
    ? game.value
    : null,
);
const busy = computed(() => creating.value || acting.value);
const loaded = computed(() =>
  gameId.value ? gameLoaded.value : listLoaded.value,
);
const failed = computed(() =>
  gameId.value ? gameFailed.value : listFailed.value,
);

onMounted(() => {
  void start();
});
function goBack() {
  void router.push({ path: `/room/${id}`, query: { tab: "games" } });
}
function goLobby() {
  void router.push(`/room/${id}/uno`);
}
function enterUno(tableId: string) {
  void router.push(`/room/${id}/uno/${tableId}`);
}
async function refresh() {
  await Promise.all([refreshList(), refreshGame()]);
}
async function createUno(configuration?: {
  language: string;
  player_count: number;
}) {
  if (!host.value || busy.value || closed.value) return;
  const created = await create({
    kind: "uno",
    language: configuration?.language || language.value,
    player_count: configuration?.player_count || playerCount.value,
  });
  if (created) await router.push(`/room/${id}/uno/${created.id}`);
}
function handleAct(action: string, extra: Record<string, unknown> = {}) {
  if (action === "create")
    return createUno({
      language: String(extra.language || language.value),
      player_count: Number(extra.player_count || playerCount.value),
    });
  return act(action, extra);
}
</script>

<template>
  <main class="uno-page">
    <header class="uno-topbar">
      <button class="uno-brand" type="button" @click="goBack" aria-label="UNO">
        UNO<span>!</span>
      </button>
      <div v-if="snapshot" class="uno-room-name">
        <span class="uno-live-dot" aria-hidden="true"></span>
        <span>{{ snapshot.room.name }}</span>
      </div>
      <div class="uno-topbar-actions">
        <label class="uno-language" :aria-label="t('app.language')">
          <select id="language" v-pretty-select v-model="locale">
            <option value="zh">简体中文</option>
            <option value="en">English</option>
          </select>
        </label>
        <button
          class="uno-text-button"
          type="button"
          :aria-label="t('game.uno.rulesTitle')"
          @click="rulesOpen = true"
        >
          <BookOpen :size="16" /><span>{{ t("game.uno.rulesTitle") }}</span>
        </button>
        <button
          v-if="gameId"
          class="uno-text-button"
          type="button"
          :aria-label="t('game.uno.backLobby')"
          @click="goLobby"
        >
          <Layers :size="16" /><span>{{ t("game.uno.backLobby") }}</span>
        </button>
        <button
          class="uno-text-button"
          type="button"
          :aria-label="t('game.uno.backRoom')"
          @click="goBack"
        >
          <ArrowLeft :size="16" /><span>{{ t("game.uno.backRoom") }}</span>
        </button>
      </div>
    </header>

    <section v-if="!snapshot" class="uno-access-state">
      <div class="uno-result-mark">UNO!</div>
      <p v-if="error" role="alert">{{ t("error." + error) }}</p>
      <p v-else>{{ t("app.loading") }}</p>
      <button v-if="error" class="uno-secondary-button" @click="goBack">
        {{ t("game.uno.backRoom") }}
      </button>
    </section>

    <template v-else>
      <p v-if="failed" class="uno-offline" role="status">
        {{ t("app.offline") }}
        <button @click="refresh">{{ t("activity.retry") }}</button>
      </p>
      <section v-if="!loaded" class="uno-access-state">
        <p>{{ t("app.loading") }}</p>
      </section>

      <template v-else-if="gameId">
        <UnoPanel
          v-if="uno"
          :game="uno"
          :my-id="myId"
          :host="host"
          :closed="closed"
          :busy="busy"
          @act="handleAct"
          @exit="goLobby"
        />
        <section v-else class="uno-access-state">
          <p role="alert">{{ t("error.GAME_MISSING") }}</p>
          <button class="uno-secondary-button" @click="goLobby">
            {{ t("game.uno.backLobby") }}
          </button>
        </section>
      </template>

      <section v-else class="uno-setup-screen">
        <div class="uno-setup-orb red" aria-hidden="true"></div>
        <div class="uno-setup-orb yellow" aria-hidden="true"></div>
        <div class="uno-setup-content">
          <div class="uno-hero">
            <p class="uno-eyebrow">THE CLASSIC CARD GAME</p>
            <img
              class="uno-hero-logo"
              src="/uno/cards/back.jpg"
              :alt="t('game.uno.heroAlt')"
            />
            <h1>{{ t("game.uno.heroTitle") }}<br /><span>UNO.</span></h1>
            <p class="uno-hero-description">{{ t("game.uno.heroHelp") }}</p>
            <div class="uno-feature-row">
              <span>{{ t("game.uno.featurePlayers") }}</span>
              <span>{{ t("game.uno.featureMultiplayer") }}</span>
              <span>{{ t("game.uno.featureAI") }}</span>
            </div>
          </div>

          <form class="uno-setup-card" @submit.prevent="createUno()">
            <div class="uno-setup-card-heading">
              <p class="uno-eyebrow">NEW GAME</p>
              <h2>{{ t("game.uno.createTitle") }}</h2>
              <p>{{ t("game.uno.createHelp") }}</p>
            </div>
            <label class="uno-field-label" for="uno-player-count">
              {{ t("game.uno.players") }}
            </label>
            <div class="uno-count-heading">
              <Sparkles :size="18" />
              <output for="uno-player-count">
                {{ t("game.uno.playerOption", { n: playerCount }) }}
              </output>
            </div>
            <input
              id="uno-player-count"
              v-model.number="playerCount"
              type="range"
              min="2"
              max="8"
              step="1"
              :disabled="!host || busy || closed"
            />
            <div class="uno-range-labels" aria-hidden="true">
              <span v-for="n in 7" :key="n">{{ n + 1 }}</span>
            </div>
            <label class="uno-field-label" for="uno-language">
              {{ t("game.language") }}
            </label>
            <select
              id="uno-language"
              v-model="language"
              class="uno-language-select"
              :disabled="!host || busy || closed"
            >
              <option value="zh">简体中文</option>
              <option value="en">English</option>
            </select>
            <button
              v-if="host"
              class="uno-primary-button uno-start-button"
              type="submit"
              :disabled="busy || closed"
            >
              <span>{{ t("game.uno.createTable") }}</span
              ><span aria-hidden="true">→</span>
            </button>
            <p v-else class="uno-wait-host">{{ t("game.waitHost") }}</p>
            <p class="uno-setup-footnote">{{ t("game.uno.setupFootnote") }}</p>
          </form>
        </div>

        <section class="uno-table-directory" aria-labelledby="uno-tables-title">
          <div class="uno-directory-heading">
            <div>
              <p class="uno-eyebrow">YOUR ROOM</p>
              <h2 id="uno-tables-title">{{ t("game.uno.tables") }}</h2>
            </div>
            <span>{{ t("game.tableCount", { n: unoGames.length }) }}</span>
          </div>
          <p v-if="!unoGames.length && !listFailed" class="uno-empty-tables">
            {{ t("game.uno.noTables") }}
          </p>
          <div v-else class="uno-table-grid">
            <article
              v-for="table in unoGames"
              :key="table.id"
              class="uno-table-card"
              :data-game-id="table.id"
            >
              <div class="uno-table-card-heading">
                <strong>{{
                  t("game.uno.tableName", { id: table.id.slice(0, 6) })
                }}</strong>
                <span>{{ t("game.phase." + table.phase) }}</span>
              </div>
              <p>
                {{
                  t("game.uno.tableSeats", {
                    seats: table.seats,
                    target: table.player_count || table.seats,
                  })
                }}
              </p>
              <small v-if="table.seated">{{ t("game.seated") }}</small>
              <button
                class="uno-secondary-button"
                type="button"
                @click="enterUno(table.id)"
              >
                {{ t("game.uno.enterTable") }}
              </button>
            </article>
          </div>
        </section>
      </section>
    </template>

    <Modal
      v-if="rulesOpen"
      :title="t('game.uno.rulesTitle')"
      @close="rulesOpen = false"
    >
      <div class="uno-rules-copy">
        <p class="uno-eyebrow">HOW TO PLAY</p>
        <ul>
          <li v-for="n in 6" :key="n">{{ t(`game.uno.rule${n}`) }}</li>
        </ul>
        <button class="uno-primary-button" @click="rulesOpen = false">
          {{ t("game.uno.rulesGotIt") }}
        </button>
      </div>
    </Modal>
  </main>
</template>

<style scoped>
.uno-page {
  --uno-bg: #101513;
  --uno-panel: #1a211e;
  --uno-panel-light: #222b27;
  --uno-line: rgba(255, 255, 255, 0.1);
  --uno-muted: #a3afa9;
  --uno-text: #f7f8f5;
  --uno-yellow: #ffd53d;
  --uno-red: #ed3838;
  min-height: 100vh;
  background: var(--uno-bg);
  color: var(--uno-text);
  color-scheme: dark;
}
.uno-topbar {
  min-height: 68px;
  padding: 8px clamp(14px, 3vw, 44px);
  display: flex;
  align-items: center;
  gap: 22px;
  border-bottom: 1px solid var(--uno-line);
  background: #141a17;
}
.uno-brand {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--uno-yellow);
  font-size: 30px;
  font-weight: 1000;
  font-style: italic;
  letter-spacing: -0.1em;
  transform: rotate(-4deg);
  cursor: pointer;
}
.uno-brand span {
  color: var(--uno-red);
}
.uno-room-name {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--uno-muted);
  font-size: 12px;
}
.uno-room-name span:last-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.uno-live-dot {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: #58ce82;
  box-shadow: 0 0 10px #58ce82;
}
.uno-topbar-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 5px;
}
.uno-text-button {
  min-height: 44px;
  padding: 8px 11px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--uno-muted);
  font-size: 12px;
  cursor: pointer;
}
.uno-text-button:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--uno-text);
}
.uno-language select {
  min-height: 44px;
  border: 0;
  background: transparent;
  color: var(--uno-muted);
  font-size: 12px;
}
.uno-language :deep(.select-field) {
  width: auto;
}
.uno-language :deep(.select-face) {
  padding: 8px 32px 8px 10px;
  border-color: transparent;
  background: transparent;
  color: var(--uno-muted);
  font-size: 12px;
  white-space: nowrap;
  overflow-wrap: normal;
}
.uno-language :deep(.select-face)::after {
  right: 12px;
}
.uno-language :deep(.select-field:hover .select-face) {
  border-color: transparent;
  background: rgba(255, 255, 255, 0.06);
  color: var(--uno-text);
}
.uno-setup-screen {
  position: relative;
  min-height: calc(100vh - 68px);
  overflow: hidden;
  background: radial-gradient(
    circle at 45% 35%,
    #25352c 0,
    #121916 48%,
    #0d1210 100%
  );
}
.uno-setup-screen::before {
  content: "";
  position: absolute;
  inset: 0;
  opacity: 0.16;
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.04) 1px, transparent 1px);
  background-size: 44px 44px;
}
.uno-setup-orb {
  position: absolute;
  width: 340px;
  height: 340px;
  border-radius: 50%;
  filter: blur(100px);
  opacity: 0.14;
}
.uno-setup-orb.red {
  top: -170px;
  left: -120px;
  background: var(--uno-red);
}
.uno-setup-orb.yellow {
  right: -150px;
  bottom: -190px;
  background: var(--uno-yellow);
}
.uno-setup-content {
  position: relative;
  z-index: 1;
  width: min(1160px, calc(100% - 48px));
  min-height: calc(100vh - 68px);
  margin: auto;
  padding: 44px 0;
  display: grid;
  grid-template-columns: 1.2fr 0.8fr;
  gap: 72px;
  align-items: center;
}
.uno-eyebrow {
  margin: 0 0 10px;
  color: var(--uno-yellow);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.2em;
}
.uno-hero-logo {
  display: block;
  width: min(420px, 92%);
  aspect-ratio: 1024 / 638;
  margin: 18px 0 26px;
  object-fit: cover;
  border-radius: 24px;
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.4);
  transform: rotate(-2deg);
}
.uno-hero h1 {
  margin: 0;
  font-size: clamp(38px, 4.5vw, 64px);
  line-height: 1.13;
  letter-spacing: -0.05em;
}
.uno-hero h1 span {
  color: var(--uno-yellow);
}
.uno-hero-description {
  max-width: 490px;
  margin: 22px 0;
  color: var(--uno-muted);
  font-size: 16px;
  line-height: 1.8;
}
.uno-feature-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.uno-feature-row span {
  padding: 8px 13px;
  border: 1px solid var(--uno-line);
  border-radius: 999px;
  color: #d8dfda;
  background: rgba(255, 255, 255, 0.03);
  font-size: 12px;
}
.uno-setup-card {
  padding: 34px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 28px;
  background: rgba(30, 39, 34, 0.9);
  box-shadow: 0 30px 90px rgba(0, 0, 0, 0.35);
}
.uno-setup-card-heading {
  margin-bottom: 28px;
}
.uno-setup-card h2 {
  margin: 0 0 8px;
  font-size: 28px;
}
.uno-setup-card-heading > p:last-child {
  margin: 0;
  color: var(--uno-muted);
  font-size: 13px;
  line-height: 1.6;
}
.uno-field-label {
  display: block;
  margin: 18px 0 10px;
  color: var(--uno-text);
  font-size: 13px;
  font-weight: 700;
}
.uno-count-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--uno-yellow);
}
.uno-count-heading output {
  font-weight: 800;
}
.uno-setup-card input[type="range"] {
  width: 100%;
  min-height: 44px;
  accent-color: var(--uno-yellow);
  cursor: pointer;
}
.uno-range-labels {
  display: flex;
  justify-content: space-between;
  margin: -4px 4px 12px;
  color: var(--uno-muted);
  font-size: 11px;
}
.uno-language-select {
  width: 100%;
  min-height: 48px;
  padding: 0 12px;
  border: 1px solid var(--uno-line);
  border-radius: 12px;
  background: #121815;
  color: var(--uno-text);
}
.uno-primary-button,
.uno-secondary-button {
  min-height: 46px;
  padding: 0 22px;
  border-radius: 12px;
  font-weight: 800;
  cursor: pointer;
}
.uno-primary-button {
  border: 0;
  background: var(--uno-yellow);
  color: #1a1b14;
  box-shadow: 0 8px 24px rgba(255, 213, 61, 0.14);
}
.uno-primary-button:hover {
  background: #ffe16e;
}
.uno-primary-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.uno-secondary-button {
  border: 1px solid var(--uno-line);
  background: var(--uno-panel-light);
  color: var(--uno-text);
}
.uno-start-button {
  width: 100%;
  min-height: 56px;
  margin-top: 26px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 16px;
}
.uno-setup-footnote,
.uno-wait-host {
  margin: 18px 0 0;
  color: var(--uno-muted);
  font-size: 11px;
  line-height: 1.6;
  text-align: center;
}
.uno-access-state {
  min-height: calc(100vh - 68px);
  padding: 40px 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  text-align: center;
}
.uno-table-directory {
  position: relative;
  z-index: 1;
  width: min(1160px, calc(100% - 48px));
  margin: 0 auto;
  padding: 0 0 44px;
}
.uno-directory-heading {
  margin-bottom: 18px;
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 16px;
}
.uno-directory-heading h2 {
  margin: 0;
}
.uno-directory-heading > span,
.uno-empty-tables {
  color: var(--uno-muted);
}
.uno-table-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}
.uno-table-card {
  min-width: 0;
  padding: 20px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  border: 1px solid var(--uno-line);
  border-radius: 18px;
  background: rgba(30, 39, 34, 0.92);
}
.uno-table-card-heading {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.uno-table-card-heading > span,
.uno-table-card p,
.uno-table-card small {
  margin: 0;
  color: var(--uno-muted);
  font-size: 12px;
}
.uno-table-card small {
  color: var(--uno-yellow);
}
.uno-table-card button {
  width: 100%;
  margin-top: auto;
}
.uno-result-mark {
  color: var(--uno-yellow);
  font-size: 60px;
  font-weight: 1000;
  font-style: italic;
  letter-spacing: -0.09em;
  transform: rotate(-5deg);
}
.uno-offline {
  margin: 0;
  padding: 10px 16px;
  background: #4b2e23;
  color: #ffd9c7;
  text-align: center;
}
.uno-offline button {
  margin-left: 8px;
}
.uno-rules-copy {
  color: var(--uno-muted);
}
.uno-rules-copy ul {
  margin: 16px 0 24px;
  padding-left: 20px;
  font-size: 13px;
  line-height: 1.8;
}
.uno-rules-copy .uno-primary-button {
  width: 100%;
}
@media (max-width: 900px) {
  .uno-setup-content {
    gap: 34px;
  }
  .uno-table-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 700px) {
  .uno-topbar {
    min-height: 60px;
    gap: 10px;
    padding: 6px 10px;
  }
  .uno-brand {
    font-size: 25px;
  }
  .uno-room-name {
    display: none;
  }
  .uno-text-button {
    width: 44px;
    padding: 8px;
    justify-content: center;
  }
  .uno-text-button span {
    display: none;
  }
  .uno-language :deep(.select-field) {
    width: 82px;
  }
  .uno-language :deep(.select-face) {
    padding: 8px 24px 8px 8px;
    font-size: 11px;
  }
  .uno-language :deep(.select-face)::after {
    right: 9px;
  }
  .uno-setup-content {
    width: min(480px, calc(100% - 28px));
    min-height: auto;
    grid-template-columns: 1fr;
    gap: 28px;
    padding: 30px 0;
  }
  .uno-hero {
    text-align: center;
  }
  .uno-hero-logo {
    width: 260px;
    margin: 14px auto 20px;
    border-radius: 16px;
  }
  .uno-hero h1 {
    font-size: 36px;
  }
  .uno-hero-description {
    margin: 16px auto;
    font-size: 14px;
  }
  .uno-feature-row {
    justify-content: center;
  }
  .uno-setup-card {
    padding: 24px;
  }
  .uno-table-directory {
    width: min(480px, calc(100% - 28px));
    padding-bottom: 30px;
  }
  .uno-table-grid {
    grid-template-columns: 1fr;
  }
}
@media (prefers-reduced-motion: reduce) {
  .uno-hero-logo,
  .uno-brand {
    transform: none;
  }
}
</style>
