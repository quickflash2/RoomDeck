<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import {
  Dices,
  Fingerprint,
  Users,
  Check,
  Eye,
  EyeOff,
  Spade,
  Layers,
} from "lucide-vue-next";
import { useGameList, useGameSession } from "../useGameSession";
const props = defineProps<{
  roomId: string;
  myId: string;
  host: boolean;
  closed: boolean;
  visible?: boolean;
}>();
const { t, locale } = useI18n();
const router = useRouter();
const visible = computed(() => props.visible !== false);
const selectedGameId = ref<string | null>(null);
const {
  game,
  busy,
  failed: gameFailed,
  refresh: refreshGame,
  act: sessionAct,
} = useGameSession(() => props.roomId, selectedGameId, visible);
const {
  games,
  busy: creating,
  loaded,
  failed: listFailed,
  refresh: refreshList,
  create,
} = useGameList(() => props.roomId, "", visible);
const reveal = ref(false),
  language = ref(locale.value.startsWith("zh") ? "zh" : "en");
const me = computed(() => game.value?.players.find((p) => p.id === props.myId));
const selectedGuess = ref(0);
const selectedVote = ref("");
const unoGames = computed(() =>
  games.value.filter((summary) => summary.kind === "uno"),
);
const failed = computed(() => gameFailed.value || listFailed.value);
function gamesOf(kind: string) {
  return games.value.filter((summary) => summary.kind === kind);
}
watch(
  games,
  (summaries) => {
    if (summaries.some((summary) => summary.id === selectedGameId.value))
      return;
    const next =
      summaries.find(
        (summary) => summary.kind !== "uno" && summary.phase !== "finished",
      ) || summaries.find((summary) => summary.kind !== "uno");
    selectedGameId.value = next?.id || null;
  },
  { flush: "sync" },
);
watch(
  [
    () => game.value?.id,
    () => game.value?.phase,
    () => game.value?.round,
    () => game.value?.tie,
  ],
  () => {
    selectedGuess.value = 0;
    selectedVote.value = "";
    reveal.value = false;
  },
);
watch(
  () => props.visible,
  () => {
    reveal.value = false;
  },
);
function conceal() {
  reveal.value = false;
}
async function act(
  action: string,
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  if (busy.value) return false;
  reveal.value = false;
  return sessionAct(action, extra);
}
async function createGame(kind: "undercover" | "dice") {
  if (!props.host || creating.value || props.closed) return;
  const created = await create({ kind, language: language.value });
  if (created) selectedGameId.value = created.id;
}
function selectGame(event: Event) {
  selectedGameId.value = (event.target as HTMLSelectElement).value || null;
}
async function refresh() {
  await Promise.all([refreshList(), refreshGame()]);
}
function enterUno() {
  void router.push(`/room/${props.roomId}/uno`);
}
function enterGuanDan() {
  void router.push(`/room/${props.roomId}/guandan`);
}
onMounted(() => {
  window.addEventListener("blur", conceal);
  document.addEventListener("visibilitychange", conceal);
});
onBeforeUnmount(() => {
  window.removeEventListener("blur", conceal);
  document.removeEventListener("visibilitychange", conceal);
});
const active = computed(() => game.value && game.value.phase !== "finished");
</script>
<template>
  <section class="game-center" :aria-label="t('activity.games')">
    <header class="activity-heading">
      <div>
        <h2>{{ t("activity.games") }}</h2>
        <p class="muted">{{ t("game.subtitle") }}</p>
      </div>
      <Users :size="28" />
    </header>
    <div class="game-library">
      <article>
        <Spade :size="36" />
        <div>
          <h3>{{ t("game.guandan") }}</h3>
          <p>{{ t("game.guandanHelp") }}</p>
          <small>{{ t("game.guandanRules") }}</small>
        </div>
        <button class="primary" @click="enterGuanDan">
          {{ t("game.guandanLaunch") }}
        </button>
      </article>
      <article>
        <Layers :size="36" />
        <div>
          <h3>{{ t("game.uno.title") }}</h3>
          <p>{{ t("game.uno.help") }}</p>
          <small>{{ t("game.uno.rules") }}</small>
          <span v-if="loaded" class="tag">
            {{ t("game.tableCount", { n: unoGames.length }) }}
          </span>
        </div>
        <button class="primary" @click="enterUno">
          {{ t("game.uno.enter") }}
        </button>
      </article>
    </div>
    <p v-if="failed" role="status">
      {{ t("app.offline") }}
      <button @click="refresh">{{ t("activity.retry") }}</button>
    </p>
    <p v-if="!loaded">{{ t("app.loading") }}</p>
    <label v-if="host" class="inline-label"
      >{{ t("game.language")
      }}<select v-pretty-select v-model="language">
        <option value="zh">简体中文</option>
        <option value="en">English</option>
      </select></label
    >
    <div class="game-library">
      <article>
        <Fingerprint :size="36" />
        <div>
          <h3>{{ t("game.undercover") }}</h3>
          <p>{{ t("game.undercoverHelp") }}</p>
          <small>{{ t("game.undercoverRules") }}</small>
          <label v-if="gamesOf('undercover').length" class="game-instance-picker">
            <span>{{ t("game.tables") }}</span>
            <select
              class="game-instance-select"
              data-kind="undercover"
              :aria-label="t('game.selectInstance', { game: t('game.undercover') })"
              :value="game?.kind === 'undercover' ? selectedGameId : ''"
              @change="selectGame"
            >
              <option value="" disabled>{{ t("game.selectTable") }}</option>
              <option
                v-for="summary in gamesOf('undercover')"
                :key="summary.id"
                :value="summary.id"
              >
                {{
                  t("game.instanceOption", {
                    id: summary.id.slice(0, 6),
                    phase: t("game.phase." + summary.phase),
                    seats: summary.seats,
                  })
                }}
              </option>
            </select>
          </label>
        </div>
        <button
          v-if="host"
          class="primary"
          :disabled="creating || closed"
          @click="createGame('undercover')"
        >
          {{ t("game.create") }}
        </button>
      </article>
      <article>
        <Dices :size="36" />
        <div>
          <h3>{{ t("game.dice") }}</h3>
          <p>{{ t("game.diceHelp") }}</p>
          <small>{{ t("game.diceRules") }}</small>
          <label v-if="gamesOf('dice').length" class="game-instance-picker">
            <span>{{ t("game.tables") }}</span>
            <select
              class="game-instance-select"
              data-kind="dice"
              :aria-label="t('game.selectInstance', { game: t('game.dice') })"
              :value="game?.kind === 'dice' ? selectedGameId : ''"
              @change="selectGame"
            >
              <option value="" disabled>{{ t("game.selectTable") }}</option>
              <option
                v-for="summary in gamesOf('dice')"
                :key="summary.id"
                :value="summary.id"
              >
                {{
                  t("game.instanceOption", {
                    id: summary.id.slice(0, 6),
                    phase: t("game.phase." + summary.phase),
                    seats: summary.seats,
                  })
                }}
              </option>
            </select>
          </label>
        </div>
        <button
          v-if="host"
          class="primary"
          :disabled="creating || closed"
          @click="createGame('dice')"
        >
          {{ t("game.create") }}
        </button>
      </article>
    </div>
    <p v-if="!host" class="muted">{{ t("game.waitHost") }}</p>
    <section v-if="game && game.kind !== 'uno'" class="game-session">
      <div class="section-head">
        <h3>
          {{ t("game." + game.kind) }}
        </h3>
        <span class="tag">{{ t("game.phase." + game.phase) }}</span>
      </div>
      <p v-if="game.round" class="muted">
        {{ t("game.round", { n: game.round }) }}
      </p>
      <p v-if="closed" role="status">{{ t("game.closed") }}</p>
      <template v-if="game.phase === 'lobby'"
        ><p>{{ t("game.seats", { n: game.players.length }) }}</p>
        <div class="row wrap">
          <button v-if="!me" :disabled="busy || closed" @click="act('join')">
            {{ t("game.join") }}</button
          ><button v-else :disabled="busy || closed" @click="act('leave')">
            {{ t("game.leave") }}</button
          ><button
            v-if="host"
            class="primary"
            :disabled="
              busy ||
              closed ||
              game.players.length < (game.kind === 'dice' ? 2 : 4)
            "
            @click="act('start')"
          >
            {{ t("game.start") }}
          </button>
        </div></template
      >
      <div v-if="game.mine?.word && active" class="secret-word">
        <button :aria-expanded="reveal" @click="reveal = !reveal">
          <EyeOff v-if="reveal" :size="18" /><Eye v-else :size="18" />{{
            t(reveal ? "game.hideWord" : "game.showWord")
          }}</button
        ><strong v-if="reveal">{{ game.mine.word }}</strong
        ><small>{{ t("game.secretHelp") }}</small>
      </div>
      <div v-if="game.phase === 'describe'" class="turn-panel">
        <h3>{{ t("game.turn", { name: game.players[game.turn]?.name }) }}</h3>
        <p>{{ t("game.describeHelp") }}</p>
        <button
          v-if="host || game.players[game.turn]?.id === myId"
          :disabled="busy || closed"
          class="primary"
          @click="act('next')"
        >
          {{ t("game.described") }}
        </button>
      </div>
      <div v-if="game.phase === 'vote'">
        <h3>{{ t(game.tie ? "game.tie" : "game.vote") }}</h3>
        <p>{{ t("game.voteHelp") }}</p>
        <div v-if="me?.alive && !game.mine?.vote" class="vote-choice">
          <p class="muted small">{{ t("ui.choiceHelp") }}</p>
          <div class="row wrap">
            <button
              v-for="p in game.players.filter(
                (p) =>
                  p.alive &&
                  p.id !== myId &&
                  (!game!.candidates.length || game!.candidates.includes(p.id)),
              )"
              :key="p.id"
              :disabled="busy || closed"
              :class="{ chosen: selectedVote === p.id }"
              :aria-pressed="selectedVote === p.id"
              @click="selectedVote = p.id"
            >
              {{ p.name }}
            </button>
          </div>
          <button
            class="primary"
            :disabled="busy || closed || !selectedVote"
            @click="act('vote', { target: selectedVote })"
          >
            {{ t("ui.confirmVote") }}
          </button>
        </div>
        <p v-else-if="game.mine?.vote">{{ t("game.submitted") }}</p>
      </div>
      <div v-if="game.phase === 'guess'">
        <h3>{{ t("game.guess") }}</h3>
        <template v-if="me && !game.mine?.guess">
          <p class="muted small">{{ t("ui.choiceHelp") }}</p>
          <div class="dice-options">
            <button
              v-for="n in 6"
              :key="n"
              :disabled="busy || closed"
              :aria-label="t('game.point', { n })"
              :class="{ chosen: selectedGuess === n }"
              :aria-pressed="selectedGuess === n"
              @click="selectedGuess = n"
            >
              <span>{{ ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"][n - 1] }}</span
              ><small>{{ n }}</small>
            </button>
          </div>
          <button
            class="primary"
            :disabled="busy || closed || !selectedGuess"
            @click="act('guess', { guess: selectedGuess })"
          >
            {{ t("ui.confirmGuess") }}
          </button>
        </template>
        <p v-else-if="game.mine?.guess">
          {{ t("game.myGuess", { n: game.mine.guess }) }}
        </p>
        <p v-else>{{ t("game.spectating") }}</p>
      </div>
      <div v-if="game.phase === 'result'" class="dice-result" role="status">
        <span aria-hidden="true">{{
          ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"][game.die - 1]
        }}</span>
        <h3>{{ t("game.rolled", { n: game.die }) }}</h3>
        <button
          v-if="host"
          :disabled="busy || closed"
          class="primary"
          @click="act('round')"
        >
          {{ t("game.nextRound") }}
        </button>
      </div>
      <p v-if="game.phase === 'finished'" class="game-outcome" role="status">
        {{ t("game.result." + game.result) }}
      </p>
      <ul class="player-list">
        <li v-for="(p, i) in game.players" :key="p.id">
          <span class="seat-number">{{ i + 1 }}</span>
          <div>
            <strong
              >{{ p.name }}
              <small v-if="p.id === myId">{{ t("game.you") }}</small></strong
            ><small v-if="game.kind === 'undercover' && !p.alive">{{
              t("game.eliminated")
            }}</small
            ><small v-if="p.word"
              >{{ p.word }} ·
              {{ t(p.spy ? "game.spy" : "game.civilian") }}</small
            ><small v-if="game.phase === 'result'">{{
              t("game.myGuess", { n: p.guess || 0 })
            }}</small>
          </div>
          <span v-if="game.kind === 'dice'">{{
            t("game.score", { n: p.score })
          }}</span
          ><Check
            v-if="p.submitted && ['guess', 'vote'].includes(game.phase)"
            :size="19"
            :aria-label="t('game.submitted')"
          />
        </li>
      </ul>
      <details v-if="host && active" class="game-controls">
        <summary>{{ t("game.manage") }}</summary>
        <p>{{ t("game.cancelHelp") }}</p>
        <button :disabled="busy || closed" @click="act('cancel')">
          {{ t("game.cancel") }}
        </button>
      </details>
    </section>
  </section>
</template>
