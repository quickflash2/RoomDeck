<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Bot, Crown, UserRound } from "lucide-vue-next";
import Modal from "./Modal.vue";
import type { Game, GamePlayer, UnoCard, UnoColor } from "../types";

const props = defineProps<{
  game: Game;
  myId: string;
  host: boolean;
  closed: boolean;
  busy: boolean;
}>();
const emit = defineEmits<{
  act: [action: string, extra?: Record<string, unknown>];
  exit: [];
}>();
const { t } = useI18n();
const pendingCard = ref<UnoCard | null>(null);
const resultDismissed = ref(false);
const selectableColors: Exclude<UnoColor, "wild">[] = [
  "red",
  "yellow",
  "blue",
  "green",
];
const colorPrefixes = {
  red: "Red",
  yellow: "Yellow",
  blue: "Blue",
  green: "Green",
} as const;
const colorOrder = { red: 0, yellow: 1, blue: 2, green: 3, wild: 4 } as const;
const seatPositions: Record<number, [number, number][]> = {
  1: [[50, 10]],
  2: [
    [25, 12],
    [75, 12],
  ],
  3: [
    [18, 19],
    [50, 9],
    [82, 19],
  ],
  4: [
    [10, 44],
    [24, 11],
    [76, 11],
    [90, 44],
  ],
  5: [
    [8, 45],
    [16, 14],
    [38, 8],
    [70, 8],
    [91, 20],
  ],
  6: [
    [7, 46],
    [10, 18],
    [29, 8],
    [57, 8],
    [82, 11],
    [93, 40],
  ],
  7: [
    [6, 50],
    [7, 25],
    [19, 10],
    [42, 7],
    [66, 7],
    [86, 13],
    [94, 39],
  ],
  8: [
    [7, 57],
    [7, 29],
    [18, 11],
    [40, 6],
    [64, 6],
    [85, 12],
    [94, 31],
    [93, 59],
  ],
};

const me = computed(() =>
  props.game.players.find((player) => player.id === props.myId),
);
const targetPlayers = computed(
  () => props.game.player_count || Math.max(2, props.game.players.length),
);
const missingPlayers = computed(() =>
  Math.max(0, targetPlayers.value - props.game.players.length),
);
const currentPlayer = computed(() =>
  props.game.players.find(
    (player) => player.id === props.game.current_player_id,
  ),
);
const winner = computed(() =>
  props.game.players.find((player) => player.id === props.game.winner_id),
);
const hand = computed(() => props.game.mine?.hand || []);
const sortedHand = computed(() =>
  [...hand.value].sort(
    (a, b) => colorOrder[a.color] - colorOrder[b.color] || a.id - b.id,
  ),
);
const playableIds = computed(
  () => new Set(props.game.mine?.playable_card_ids || []),
);
const myTurn = computed(
  () =>
    Boolean(me.value) &&
    props.game.current_player_id === props.myId &&
    ["turn", "drawn"].includes(props.game.phase),
);
const recentLog = computed(() =>
  [...(props.game.log || [])].slice(-8).reverse(),
);
const opponents = computed(() =>
  me.value
    ? props.game.players.filter((player) => player.id !== props.myId)
    : props.game.players,
);
const canDeclare = computed(
  () =>
    myTurn.value &&
    props.game.phase === "turn" &&
    hand.value.length === 2 &&
    !me.value?.uno_declared,
);
const drawnCardPlayable = computed(() =>
  hand.value.some((card) => canPlay(card)),
);
const actionHint = computed(() => {
  if (props.game.phase === "finished")
    return winner.value
      ? t("game.uno.winner", { name: winner.value.name })
      : t("game.result.cancelled");
  if (!me.value) return t("game.uno.spectating");
  if (!myTurn.value)
    return t("game.uno.waiting", { name: currentPlayer.value?.name || "" });
  if (props.game.phase === "drawn")
    return t(
      drawnCardPlayable.value ? "game.uno.drawnPlayable" : "game.uno.drawnPass",
    );
  if (!playableIds.value.size) return t("game.uno.drawHint");
  if (canDeclare.value) return t("game.uno.unoHint");
  return t("game.uno.playableHint");
});
const statusTitle = computed(() => {
  if (props.game.phase === "finished") return t("game.uno.gameOver");
  return myTurn.value
    ? t("game.uno.yourTurn")
    : t("game.uno.turnOf", { name: currentPlayer.value?.name || "" });
});
const resultTitle = computed(() => {
  if (!winner.value) return t("game.result.cancelled");
  return winner.value.id === props.myId
    ? t("game.uno.youWon")
    : t("game.uno.winner", { name: winner.value.name });
});
const resultDescription = computed(() =>
  t(
    winner.value?.id === props.myId
      ? "game.uno.youWonHelp"
      : "game.uno.playAgainHelp",
  ),
);

watch(
  () => props.game.id,
  () => {
    resultDismissed.value = false;
    pendingCard.value = null;
  },
);
watch(
  [
    () => props.game.version,
    () => props.game.phase,
    () => props.game.current_player_id,
  ],
  () => {
    pendingCard.value = null;
  },
);

function canPlay(card: UnoCard) {
  return (
    myTurn.value &&
    playableIds.value.has(card.id) &&
    (props.game.phase !== "drawn" || card.id === props.game.mine?.drawn_card_id)
  );
}
function cardImage(card: UnoCard) {
  if (card.type === "wild") return "/uno/cards/Wild.jpg";
  if (card.type === "wildDrawFour") return "/uno/cards/DrawFour.jpg";
  const prefix =
    colorPrefixes[card.color as keyof typeof colorPrefixes] || "Wild";
  if (card.type === "number") return `/uno/cards/${prefix}${card.value}.jpg`;
  if (card.type === "skip")
    return card.color === "red"
      ? "/uno/cards/RedSikp.jpg"
      : `/uno/cards/${prefix}Skip.jpg`;
  if (card.type === "drawTwo") return `/uno/cards/${prefix}Drawtwo.jpg`;
  return `/uno/cards/${prefix}Reverse.jpg`;
}
function cardLabel(card: UnoCard) {
  if (card.type === "wild" || card.type === "wildDrawFour")
    return t(`game.uno.card.${card.type}`);
  const color = t(`game.uno.color.${card.color}`);
  if (card.type === "number")
    return t("game.uno.numberCard", { color, n: card.value ?? 0 });
  return t("game.uno.namedCard", {
    color,
    name: t(`game.uno.card.${card.type}`),
  });
}
function play(card: UnoCard, color?: Exclude<UnoColor, "wild">) {
  const extra: Record<string, unknown> = { card_id: card.id };
  if (color) extra.color = color;
  emit("act", "play", extra);
}
function chooseCard(card: UnoCard) {
  if (props.busy || props.closed || !canPlay(card)) return;
  if (card.type === "wild" || card.type === "wildDrawFour") {
    pendingCard.value = card;
    return;
  }
  play(card);
}
function chooseColor(color: Exclude<UnoColor, "wild">) {
  if (!pendingCard.value || props.busy || props.closed) return;
  const card = pendingCard.value;
  pendingCard.value = null;
  play(card, color);
}
function avatar(player: GamePlayer) {
  const index = Math.max(
    0,
    props.game.players.findIndex((candidate) => candidate.id === player.id),
  );
  return `/uno/avatars/${(index % 7) + 1}.png`;
}
function seatStyle(index: number) {
  const positions = seatPositions[opponents.value.length] || seatPositions[7];
  const [left, top] = positions[index] || positions[positions.length - 1];
  return { left: `${left}%`, top: `${top}%` };
}
function playAgain() {
  emit("act", "create", {
    kind: "uno",
    language: props.game.language,
    player_count: targetPlayers.value,
  });
}
</script>

<template>
  <div class="uno-panel">
    <section v-if="game.phase === 'lobby'" class="uno-lobby">
      <div class="uno-lobby-heading">
        <p class="uno-eyebrow">YOUR TABLE</p>
        <h1>{{ t("game.uno.lobbyTitle") }}</h1>
        <p>{{ t("game.uno.lobbyHelp") }}</p>
      </div>
      <div class="uno-lobby-summary">
        <strong>{{
          t("game.uno.seats", {
            humans: game.players.length,
            target: targetPlayers,
          })
        }}</strong>
        <span>{{ t("game.uno.aiFill", { n: missingPlayers }) }}</span>
      </div>
      <ol class="uno-lobby-seats" :aria-label="t('game.uno.seatsLabel')">
        <li
          v-for="seat in targetPlayers"
          :key="seat"
          :class="{ empty: !game.players[seat - 1] }"
        >
          <template v-if="game.players[seat - 1]">
            <div class="uno-lobby-avatar">
              <img
                :src="avatar(game.players[seat - 1])"
                :alt="game.players[seat - 1].name"
              />
              <span>{{ seat }}</span>
            </div>
            <strong>{{ game.players[seat - 1].name }}</strong>
            <small v-if="game.players[seat - 1].id === myId">{{
              t("game.you")
            }}</small>
          </template>
          <template v-else>
            <div class="uno-empty-seat"><UserRound :size="24" /></div>
            <strong>{{ t("game.uno.openSeat") }}</strong>
            <small>AI</small>
          </template>
        </li>
      </ol>
      <div class="uno-lobby-actions">
        <button
          v-if="!me"
          class="uno-primary-button"
          :disabled="busy || closed || game.players.length >= targetPlayers"
          @click="emit('act', 'join')"
        >
          {{ t("game.join") }}
        </button>
        <button
          v-else
          class="uno-secondary-button"
          :disabled="busy || closed"
          @click="emit('act', 'leave')"
        >
          {{ t("game.leave") }}
        </button>
        <button
          v-if="host"
          class="uno-primary-button"
          :disabled="busy || closed || game.players.length < 1"
          @click="emit('act', 'start')"
        >
          {{ t("game.start") }}
        </button>
      </div>
      <p v-if="host && !game.players.length" class="uno-start-need">
        {{ t("game.uno.startNeed") }}
      </p>
    </section>

    <template v-else>
      <div class="uno-game-layout">
        <section class="uno-table-panel">
          <div class="uno-table" :aria-label="t('game.uno.table')">
            <div class="uno-seats">
              <article
                v-for="(player, index) in opponents"
                :key="player.id"
                class="uno-seat"
                :class="{
                  current:
                    player.id === game.current_player_id &&
                    game.phase !== 'finished',
                }"
                :style="seatStyle(index)"
              >
                <div class="uno-avatar-wrap">
                  <img
                    class="uno-avatar"
                    :src="avatar(player)"
                    :alt="player.name"
                  />
                  <span class="uno-seat-card-count">{{
                    player.card_count || 0
                  }}</span>
                </div>
                <span class="uno-seat-name">
                  {{ player.name
                  }}<small v-if="player.ai"><Bot :size="11" />AI</small>
                </span>
                <span v-if="player.uno_declared" class="uno-seat-uno"
                  >UNO!</span
                >
              </article>
            </div>

            <div class="uno-center-area">
              <div class="uno-direction-indicator">
                {{
                  t(
                    game.direction === -1
                      ? "game.uno.counterclockwise"
                      : "game.uno.clockwise",
                  )
                }}
              </div>
              <div class="uno-piles">
                <button
                  class="uno-pile-button uno-draw"
                  type="button"
                  :disabled="busy || closed || !myTurn || game.phase !== 'turn'"
                  :aria-label="t('game.uno.draw')"
                  @click="emit('act', 'draw')"
                >
                  <img
                    src="/uno/cards/Cardback.jpg"
                    :alt="t('game.uno.cardBack')"
                    draggable="false"
                  />
                  <span class="uno-pile-count">{{
                    t("game.uno.deckCount", { n: game.deck_count || 0 })
                  }}</span>
                </button>
                <div class="uno-discard-pile">
                  <img
                    v-if="game.top_card"
                    :src="cardImage(game.top_card)"
                    :alt="cardLabel(game.top_card)"
                    draggable="false"
                  />
                  <img
                    v-else
                    src="/uno/cards/Cardback.jpg"
                    :alt="t('game.uno.cardBack')"
                    draggable="false"
                  />
                  <span class="uno-pile-count">{{
                    t("game.uno.topCard")
                  }}</span>
                </div>
              </div>
              <div v-if="game.current_color" class="uno-current-color">
                {{ t("game.uno.currentColor") }}
                <span
                  class="uno-color-dot"
                  :class="game.current_color"
                  aria-hidden="true"
                ></span>
                <strong>{{ t(`game.uno.color.${game.current_color}`) }}</strong>
              </div>
            </div>
            <div
              class="uno-turn-banner"
              :class="{ mine: myTurn }"
              role="status"
            >
              {{ statusTitle }}
            </div>
          </div>

          <section
            v-if="me && game.mine?.hand"
            class="uno-hand-dock"
            :aria-label="t('game.uno.yourHand')"
          >
            <div class="uno-hand-heading">
              <div>
                <p class="uno-eyebrow">YOUR HAND</p>
                <h2>{{ t("game.uno.yourHand") }}</h2>
              </div>
              <div class="uno-hand-actions">
                <button
                  class="uno-button"
                  :class="{ declared: me.uno_declared }"
                  :disabled="busy || closed || !canDeclare"
                  @click="emit('act', 'declare_uno')"
                >
                  {{
                    t(me.uno_declared ? "game.uno.declared" : "game.uno.declareUno")
                  }}
                </button>
                <button
                  v-if="game.phase === 'drawn'"
                  class="uno-secondary-button uno-pass"
                  :disabled="busy || closed || !myTurn"
                  @click="emit('act', 'pass')"
                >
                  {{ t("game.uno.pass") }}
                </button>
              </div>
            </div>
            <div
              class="uno-hand"
              role="group"
              :aria-label="t('game.uno.yourHand')"
            >
              <button
                v-for="card in sortedHand"
                :key="card.id"
                type="button"
                class="uno-game-card"
                :class="{
                  playable: canPlay(card),
                  drawn: card.id === game.mine?.drawn_card_id,
                }"
                :data-card-id="card.id"
                :disabled="busy || closed || !canPlay(card)"
                :aria-label="
                  canPlay(card)
                    ? t('game.uno.playCard', { card: cardLabel(card) })
                    : t('game.uno.unavailableCard', { card: cardLabel(card) })
                "
                @click="chooseCard(card)"
              >
                <img
                  :src="cardImage(card)"
                  :alt="cardLabel(card)"
                  draggable="false"
                />
              </button>
            </div>
            <p class="uno-action-hint" aria-live="polite">{{ actionHint }}</p>
          </section>
          <p v-else class="uno-spectator">{{ t("game.uno.spectating") }}</p>
        </section>

        <aside class="uno-side-panel">
          <section class="uno-status-card">
            <p class="uno-eyebrow">
              ROUND <span>{{ game.round }}</span>
            </p>
            <h2>{{ statusTitle }}</h2>
            <p>{{ actionHint }}</p>
            <div class="uno-status-stats">
              <div>
                <strong>{{ hand.length }}</strong
                ><span>{{ t("game.uno.yourHand") }}</span>
              </div>
              <div>
                <strong>{{ game.players.length }}</strong
                ><span>{{ t("game.uno.players") }}</span>
              </div>
            </div>
          </section>
          <section class="uno-activity-card">
            <h3>{{ t("game.uno.log") }}</h3>
            <ol class="uno-activity-log">
              <li
                v-for="(entry, index) in recentLog"
                :key="`${game.version}-${index}`"
              >
                {{ entry }}
              </li>
            </ol>
          </section>
          <details
            v-if="host && game.phase !== 'finished'"
            class="uno-game-controls"
          >
            <summary>{{ t("game.manage") }}</summary>
            <p>{{ t("game.uno.cancelHelp") }}</p>
            <button :disabled="busy || closed" @click="emit('act', 'cancel')">
              {{ t("game.cancel") }}
            </button>
          </details>
        </aside>
      </div>

    </template>

    <Modal
      v-if="pendingCard"
      :title="t('game.uno.chooseColor')"
      :busy="busy"
      @close="pendingCard = null"
    >
      <div class="uno-color-modal">
        <p class="uno-eyebrow">WILD CARD</p>
        <p>{{ t("game.uno.chooseColorHelp") }}</p>
        <div class="uno-color-options">
          <button
            v-for="color in selectableColors"
            :key="color"
            class="uno-color-choice"
            :class="color"
            :data-color="color"
            :disabled="busy || closed"
            @click="chooseColor(color)"
          >
            <span aria-hidden="true"></span>{{ t(`game.uno.color.${color}`) }}
          </button>
        </div>
      </div>
    </Modal>

    <Modal
      v-if="game.phase === 'finished' && !resultDismissed"
      :title="resultTitle"
      @close="resultDismissed = true"
    >
      <div class="uno-result-content">
        <p class="uno-eyebrow">GAME OVER</p>
        <div class="uno-result-mark">
          <Crown v-if="winner" :size="46" /><span>UNO!</span>
        </div>
        <h3>{{ resultTitle }}</h3>
        <p>{{ resultDescription }}</p>
        <div class="uno-result-actions">
          <button
            v-if="host"
            class="uno-primary-button"
            :disabled="busy || closed"
            @click="playAgain"
          >
            {{ t("game.uno.playAgain") }}
          </button>
          <button class="uno-secondary-button" @click="emit('exit')">
            {{ t("game.uno.backLobby") }}
          </button>
        </div>
        <p v-if="!host" class="uno-wait-next">{{ t("game.uno.waitNext") }}</p>
      </div>
    </Modal>
  </div>
</template>

<style scoped>
.uno-panel {
  --uno-yellow: #ffd53d;
  --uno-red: #ed3838;
  --uno-blue: #168bd2;
  --uno-green: #2ba35c;
  --uno-muted: #a3afa9;
  min-width: 0;
  max-width: 100%;
  color: #f7f8f5;
}
.uno-eyebrow {
  margin: 0 0 10px;
  color: var(--uno-yellow);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.2em;
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
.uno-secondary-button {
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: #222b27;
  color: #f7f8f5;
}
.uno-primary-button:disabled,
.uno-secondary-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.uno-lobby {
  width: min(980px, calc(100% - 32px));
  margin: 0 auto;
  padding: clamp(30px, 6vh, 64px) 0;
}
.uno-lobby-heading {
  text-align: center;
}
.uno-lobby-heading h1 {
  margin: 0 0 12px;
  font-size: clamp(30px, 5vw, 48px);
}
.uno-lobby-heading > p:last-child {
  color: var(--uno-muted);
}
.uno-lobby-summary {
  margin: 28px 0 18px;
  padding: 20px 24px;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: center;
  gap: 8px 20px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 18px;
  background: #1a211e;
}
.uno-lobby-summary strong {
  font-size: 22px;
}
.uno-lobby-summary span {
  color: var(--uno-muted);
  font-size: 13px;
}
.uno-lobby-seats {
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
  list-style: none;
}
.uno-lobby-seats li {
  min-width: 0;
  padding: 20px 10px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 18px;
  background: #1a211e;
  text-align: center;
}
.uno-lobby-seats li.empty {
  border-style: dashed;
  background: rgba(255, 255, 255, 0.025);
  color: var(--uno-muted);
}
.uno-lobby-seats strong {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.uno-lobby-seats small {
  color: var(--uno-muted);
}
.uno-lobby-avatar {
  position: relative;
}
.uno-lobby-avatar img {
  width: 64px;
  height: 70px;
  object-fit: cover;
  border: 3px solid #e4e5dc;
  border-radius: 16px;
}
.uno-lobby-avatar span {
  position: absolute;
  right: -7px;
  bottom: -5px;
  width: 23px;
  height: 23px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--uno-yellow);
  color: #1a1b14;
  font-size: 11px;
  font-weight: 900;
}
.uno-empty-seat {
  width: 64px;
  height: 70px;
  display: grid;
  place-items: center;
  border: 2px dashed rgba(255, 255, 255, 0.2);
  border-radius: 16px;
}
.uno-lobby-actions {
  margin-top: 26px;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 12px;
}
.uno-start-need {
  color: var(--uno-muted);
  font-size: 12px;
  text-align: center;
}
.uno-game-layout {
  width: min(1500px, 100%);
  margin: auto;
  padding: 22px clamp(12px, 3vw, 40px) 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 270px;
  gap: 22px;
}
.uno-table-panel {
  min-width: 0;
}
.uno-table {
  position: relative;
  height: 510px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 30px;
  background: radial-gradient(
    ellipse at center,
    #254f3a 0%,
    #193c2c 55%,
    #11291e 100%
  );
  box-shadow: inset 0 0 80px rgba(0, 0, 0, 0.3);
}
.uno-table::before {
  content: "";
  position: absolute;
  inset: 60px 9%;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 50%;
  box-shadow: inset 0 0 50px rgba(0, 0, 0, 0.12);
}
.uno-seats {
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
}
.uno-seat {
  position: absolute;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  transform: translate(-50%, -50%);
  transition: filter 0.2s;
}
.uno-avatar-wrap {
  position: relative;
  width: 58px;
  height: 64px;
}
.uno-avatar {
  width: 58px;
  height: 64px;
  object-fit: cover;
  border: 3px solid #e4e5dc;
  border-radius: 15px;
  background: #75638e;
  box-shadow: 0 5px 14px rgba(0, 0, 0, 0.35);
}
.uno-seat.current .uno-avatar {
  border-color: var(--uno-yellow);
  box-shadow:
    0 0 0 4px rgba(255, 213, 61, 0.2),
    0 0 26px rgba(255, 213, 61, 0.4);
}
.uno-seat-card-count {
  position: absolute;
  right: -8px;
  bottom: -5px;
  min-width: 25px;
  height: 25px;
  padding: 0 5px;
  display: grid;
  place-items: center;
  border: 2px solid #fff;
  border-radius: 999px;
  background: #18211c;
  color: #fff;
  font-size: 11px;
  font-weight: 800;
}
.uno-seat-name {
  max-width: 94px;
  overflow: hidden;
  color: #e6eee9;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.uno-seat-name small {
  margin-left: 4px;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: #b8c6bd;
  font-size: 9px;
}
.uno-seat-uno {
  color: var(--uno-yellow);
  font-size: 10px;
  font-weight: 1000;
  font-style: italic;
}
.uno-center-area {
  position: absolute;
  z-index: 1;
  left: 50%;
  top: 52%;
  display: flex;
  flex-direction: column;
  align-items: center;
  transform: translate(-50%, -50%);
}
.uno-direction-indicator {
  margin-bottom: 12px;
  color: rgba(255, 255, 255, 0.7);
  font-size: 11px;
  white-space: nowrap;
}
.uno-piles {
  display: flex;
  align-items: center;
  gap: 28px;
}
.uno-pile-button,
.uno-discard-pile {
  position: relative;
  width: 92px;
  padding: 0;
  border: 0;
  background: transparent;
  color: #f7f8f5;
}
.uno-pile-button {
  cursor: pointer;
  transition: transform 0.2s;
}
.uno-pile-button:not(:disabled):hover {
  transform: translateY(-5px) rotate(-2deg);
}
.uno-pile-button:disabled {
  opacity: 1;
  cursor: default;
}
.uno-pile-button img,
.uno-discard-pile img {
  display: block;
  width: 92px;
  aspect-ratio: 402/670;
  object-fit: cover;
  border-radius: 10px;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.35);
}
.uno-pile-button::before {
  content: "";
  position: absolute;
  z-index: -1;
  inset: 5px -5px -5px 5px;
  border: 2px solid rgba(255, 255, 255, 0.65);
  border-radius: 11px;
  background: #251c1c;
}
.uno-pile-count {
  display: block;
  margin-top: 9px;
  color: rgba(255, 255, 255, 0.72);
  font-size: 11px;
  text-align: center;
  white-space: nowrap;
}
.uno-current-color {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 13px;
  color: rgba(255, 255, 255, 0.66);
  font-size: 11px;
}
.uno-current-color strong {
  color: #fff;
}
.uno-color-dot {
  width: 10px;
  height: 10px;
  border: 2px solid rgba(255, 255, 255, 0.7);
  border-radius: 50%;
}
.red {
  background: var(--uno-red);
}
.yellow {
  background: var(--uno-yellow);
}
.blue {
  background: var(--uno-blue);
}
.green {
  background: var(--uno-green);
}
.uno-turn-banner {
  position: absolute;
  z-index: 2;
  left: 50%;
  bottom: 22px;
  max-width: 90%;
  padding: 8px 18px;
  transform: translateX(-50%);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 999px;
  background: rgba(9, 20, 14, 0.55);
  color: #e8f1eb;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.uno-turn-banner.mine {
  border-color: rgba(255, 213, 61, 0.35);
  color: var(--uno-yellow);
}
.uno-side-panel {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.uno-status-card,
.uno-activity-card {
  padding: 22px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 20px;
  background: #1a211e;
}
.uno-status-card h2 {
  margin: 0 0 10px;
  font-size: 23px;
}
.uno-status-card > p:not(.uno-eyebrow) {
  min-height: 42px;
  margin: 0;
  color: var(--uno-muted);
  font-size: 12px;
  line-height: 1.7;
}
.uno-status-stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-top: 20px;
}
.uno-status-stats div {
  min-width: 0;
  padding: 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.04);
}
.uno-status-stats strong,
.uno-status-stats span {
  display: block;
}
.uno-status-stats strong {
  margin-bottom: 4px;
  font-size: 20px;
}
.uno-status-stats span {
  color: var(--uno-muted);
  font-size: 10px;
}
.uno-activity-card {
  flex: 1;
  min-height: 190px;
}
.uno-activity-card h3 {
  margin: 0 0 14px;
  font-size: 13px;
}
.uno-activity-log {
  max-height: 190px;
  margin: 0;
  padding: 0;
  overflow: auto;
  list-style: none;
}
.uno-activity-log li {
  position: relative;
  padding: 8px 0 8px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  color: var(--uno-muted);
  font-size: 10px;
  line-height: 1.5;
}
.uno-activity-log li::before {
  content: "";
  position: absolute;
  left: 0;
  top: 13px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #60766a;
}
.uno-activity-log li:first-child {
  color: #e7eee9;
}
.uno-activity-log li:first-child::before {
  background: var(--uno-yellow);
}
.uno-game-controls {
  padding: 12px 16px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 14px;
  color: var(--uno-muted);
  font-size: 12px;
}
.uno-game-controls p {
  line-height: 1.6;
}
.uno-hand-dock {
  width: 100%;
  padding: 18px 0 22px;
}
.uno-hand-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}
.uno-hand-heading .uno-eyebrow {
  margin-bottom: 3px;
}
.uno-hand-heading h2 {
  margin: 0;
  font-size: 17px;
}
.uno-hand-actions {
  display: flex;
  gap: 10px;
}
.uno-button {
  min-width: 112px;
  min-height: 44px;
  border: 2px solid #f7f0d8;
  border-radius: 999px;
  background: var(--uno-red);
  color: #fff;
  font-size: 15px;
  font-weight: 1000;
  font-style: italic;
  cursor: pointer;
  box-shadow: 0 5px 18px rgba(237, 56, 56, 0.25);
  transform: rotate(-2deg);
}
.uno-button:disabled {
  border-color: #59625d;
  background: #303834;
  color: #89928d;
  box-shadow: none;
}
.uno-button.declared {
  border-color: var(--uno-yellow);
  background: var(--uno-yellow);
  color: #272416;
}
.uno-hand {
  min-height: 176px;
  padding: 20px 14px 12px;
  display: flex;
  align-items: flex-end;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-color: #48554d transparent;
}
.uno-game-card {
  flex: 0 0 98px;
  width: 98px;
  margin-left: -22px;
  padding: 0;
  border: 0;
  border-radius: 11px;
  background: transparent;
  cursor: pointer;
  transition:
    transform 0.18s,
    filter 0.18s,
    opacity 0.18s;
}
.uno-game-card:first-child {
  margin-left: 0;
}
.uno-game-card img {
  display: block;
  width: 100%;
  aspect-ratio: 402/670;
  object-fit: cover;
  border-radius: 11px;
  box-shadow: 0 7px 16px rgba(0, 0, 0, 0.35);
}
.uno-game-card:disabled {
  opacity: 0.52;
  cursor: not-allowed;
  filter: saturate(0.65);
}
.uno-game-card.playable {
  opacity: 1;
  filter: none;
  transform: translateY(-9px);
}
.uno-game-card.playable img {
  box-shadow:
    0 0 0 3px var(--uno-yellow),
    0 10px 25px rgba(255, 213, 61, 0.22);
}
.uno-game-card.playable:hover {
  transform: translateY(-19px);
}
.uno-game-card.drawn img {
  box-shadow:
    0 0 0 3px #75cfff,
    0 10px 25px rgba(22, 139, 210, 0.3);
}
.uno-action-hint {
  min-height: 18px;
  margin: 4px 0 0;
  color: var(--uno-muted);
  font-size: 11px;
  text-align: center;
}
.uno-spectator {
  padding: 20px;
  color: var(--uno-muted);
  text-align: center;
}
.uno-color-modal,
.uno-result-content {
  text-align: center;
}
.uno-color-modal > p:not(.uno-eyebrow),
.uno-result-content > p:not(.uno-eyebrow) {
  color: var(--uno-muted);
  font-size: 13px;
  line-height: 1.6;
}
.uno-color-options {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-top: 20px;
}
.uno-color-choice {
  min-height: 70px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 14px;
  color: #fff;
  font-weight: 800;
  cursor: pointer;
}
.uno-color-choice.red {
  background: #9e2929;
}
.uno-color-choice.yellow {
  background: #8b741d;
}
.uno-color-choice.blue {
  background: #145f8c;
}
.uno-color-choice.green {
  background: #216b40;
}
.uno-color-choice span {
  width: 20px;
  height: 20px;
  border: 2px solid rgba(255, 255, 255, 0.7);
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.2);
}
.uno-result-mark {
  margin: 6px auto 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--uno-yellow);
}
.uno-result-mark span {
  font-size: 56px;
  font-weight: 1000;
  font-style: italic;
  letter-spacing: -0.09em;
  transform: rotate(-5deg);
}
.uno-result-content h3 {
  margin: 0;
  font-size: 24px;
}
.uno-result-actions {
  margin-top: 22px;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
}
.uno-wait-next {
  margin-top: 16px;
}
:deep(dialog) {
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: #1c2520;
  color: #f7f8f5;
}
@media (min-width: 1250px) {
  .uno-table {
    height: 540px;
  }
  .uno-game-card {
    flex-basis: 106px;
    width: 106px;
  }
  .uno-hand {
    min-height: 188px;
  }
}
@media (max-width: 1000px) {
  .uno-game-layout {
    grid-template-columns: 1fr;
  }
  .uno-side-panel {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }
  .uno-game-controls {
    grid-column: 1/-1;
  }
  .uno-activity-log {
    max-height: 150px;
  }
}
@media (max-width: 700px) {
  .uno-lobby {
    width: calc(100% - 24px);
    padding: 24px 0;
  }
  .uno-lobby-summary {
    padding: 16px;
  }
  .uno-lobby-summary strong {
    font-size: 18px;
  }
  .uno-lobby-seats {
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
  }
  .uno-game-layout {
    padding: 12px 10px 0;
    gap: 12px;
  }
  .uno-table {
    height: 420px;
    border-radius: 22px;
  }
  .uno-table::before {
    inset: 56px 3%;
  }
  .uno-avatar-wrap,
  .uno-avatar {
    width: 43px;
    height: 48px;
  }
  .uno-avatar {
    border-width: 2px;
    border-radius: 11px;
  }
  .uno-seat {
    gap: 3px;
  }
  .uno-seat-name {
    max-width: 58px;
    font-size: 9px;
  }
  .uno-seat-name small {
    display: none;
  }
  .uno-seat-card-count {
    right: -6px;
    min-width: 21px;
    height: 21px;
    font-size: 9px;
  }
  .uno-pile-button,
  .uno-discard-pile,
  .uno-pile-button img,
  .uno-discard-pile img {
    width: 72px;
  }
  .uno-piles {
    gap: 22px;
  }
  .uno-turn-banner {
    bottom: 15px;
    font-size: 10px;
  }
  .uno-side-panel {
    display: flex;
  }
  .uno-status-card,
  .uno-activity-card {
    padding: 16px;
  }
  .uno-status-card > p:not(.uno-eyebrow) {
    min-height: 0;
  }
  .uno-status-stats {
    margin-top: 12px;
  }
  .uno-activity-card {
    min-height: 0;
  }
  .uno-activity-log {
    max-height: 130px;
  }
  .uno-hand-dock {
    padding: 15px 0 18px;
  }
  .uno-game-card {
    flex-basis: 78px;
    width: 78px;
    margin-left: -20px;
    border-radius: 8px;
  }
  .uno-game-card img {
    border-radius: 8px;
  }
  .uno-hand {
    min-height: 145px;
    padding-inline: 8px;
  }
  .uno-hand-heading {
    padding-inline: 6px;
  }
  .uno-hand-heading h2 {
    font-size: 15px;
  }
  .uno-button {
    min-width: 96px;
    min-height: 44px;
    font-size: 13px;
  }
  .uno-secondary-button {
    padding: 0 14px;
  }
  .uno-action-hint {
    min-height: 30px;
    padding: 0 12px;
    line-height: 1.5;
  }
}
@media (max-width: 360px) {
  .uno-table {
    height: 390px;
  }
  .uno-seat-name {
    display: none;
  }
  .uno-hand-actions {
    gap: 6px;
  }
  .uno-button {
    min-width: 90px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .uno-game-card,
  .uno-pile-button,
  .uno-seat {
    transition: none;
  }
  .uno-button {
    transform: none;
  }
}
</style>
