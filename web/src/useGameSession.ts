import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  toValue,
  watch,
} from "vue";
import type { MaybeRefOrGetter, Ref } from "vue";
import { useI18n } from "vue-i18n";
import { api, errorCode, notify } from "./api";
import type { Game, GameSummary, GuanDanSummary } from "./types";

function useSummaryList<T>(
  path: MaybeRefOrGetter<string>,
  enabled: MaybeRefOrGetter<boolean>,
  interval: number,
) {
  const games = ref<T[]>([]) as Ref<T[]>;
  const loaded = ref(false);
  const failed = ref(false);
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  let reading = false;
  let generation = 0;

  async function refresh() {
    if (disposed || reading || !toValue(enabled)) return;
    const requestPath = toValue(path);
    const requestGeneration = generation;
    reading = true;
    try {
      const result = await api<{ games: T[] }>(requestPath);
      if (disposed || requestGeneration !== generation) return;
      games.value = result.games;
      loaded.value = true;
      failed.value = false;
    } catch {
      if (!disposed && requestGeneration === generation) {
        loaded.value = true;
        failed.value = true;
      }
    } finally {
      if (requestGeneration === generation) reading = false;
    }
  }

  watch(
    () => toValue(path),
    () => {
      generation++;
      reading = false;
      games.value = [];
      loaded.value = false;
      failed.value = false;
      if (toValue(enabled)) void refresh();
    },
    { immediate: true, flush: "sync" },
  );
  watch(
    () => toValue(enabled),
    (value) => {
      if (value) void refresh();
    },
    { flush: "sync" },
  );
  onMounted(() => {
    timer = setInterval(() => {
      if (toValue(enabled)) void refresh();
    }, interval);
  });
  onBeforeUnmount(() => {
    disposed = true;
    generation++;
    clearInterval(timer);
  });

  return { games, loaded, failed, refresh };
}

export function useGameList(
  roomId: MaybeRefOrGetter<string>,
  kind: MaybeRefOrGetter<string> = "",
  enabled: MaybeRefOrGetter<boolean> = true,
) {
  const { t } = useI18n();
  const path = computed(() => {
    const filter = toValue(kind);
    return `/rooms/${toValue(roomId)}/games${filter ? `?kind=${encodeURIComponent(filter)}` : ""}`;
  });
  const list = useSummaryList<GameSummary>(path, enabled, 4000);
  const busy = ref(false);

  async function create(input: {
    kind: string;
    language: string;
    player_count?: number;
  }): Promise<Game | null> {
    if (busy.value) return null;
    busy.value = true;
    try {
      return await api<Game>(`/rooms/${toValue(roomId)}/games`, "POST", {
        action: "create",
        ...input,
      });
    } catch (error) {
      notify(t("error." + errorCode(error)));
      return null;
    } finally {
      busy.value = false;
      await list.refresh();
    }
  }

  return { ...list, busy, create };
}

export function useGuanDanList(
  roomId: MaybeRefOrGetter<string>,
  enabled: MaybeRefOrGetter<boolean> = true,
) {
  const path = computed(() => `/rooms/${toValue(roomId)}/guandan-games`);
  return useSummaryList<GuanDanSummary>(path, enabled, 5000);
}

export function useGameSession(
  roomId: MaybeRefOrGetter<string>,
  gameId: MaybeRefOrGetter<string | null>,
  enabled: MaybeRefOrGetter<boolean> = true,
) {
  const { t } = useI18n();
  const game = ref<Game | null>(null),
    busy = ref(false),
    loaded = ref(false),
    failed = ref(false);
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  let reading = false;
  let generation = 0;

  async function refresh() {
    const id = toValue(gameId);
    if (
      disposed ||
      reading ||
      busy.value ||
      !id ||
      !toValue(enabled)
    )
      return;
    const requestGeneration = generation;
    reading = true;
    try {
      const result = await api<Game | null>(
        `/rooms/${toValue(roomId)}/games/${encodeURIComponent(id)}`,
      );
      if (disposed || requestGeneration !== generation) return;
      if (!result || !game.value || result.version >= game.value.version)
        game.value = result;
      loaded.value = true;
      failed.value = false;
    } catch {
      if (!disposed && requestGeneration === generation) failed.value = true;
    } finally {
      if (requestGeneration === generation) reading = false;
    }
  }

  async function act(
    action: string,
    extra: Record<string, unknown> = {},
  ): Promise<boolean> {
    const id = toValue(gameId);
    if (busy.value || !id) return false;
    const requestGeneration = generation;
    const current = game.value;
    busy.value = true;
    try {
      const result = await api<Game>(
        `/rooms/${toValue(roomId)}/games/${encodeURIComponent(id)}`,
        "POST",
        {
          action,
          version: current?.version || 0,
          game_id: id,
          round: current?.round || 0,
          phase: current?.phase || "",
          tie: current?.tie || false,
          ...extra,
        },
      );
      if (requestGeneration === generation) game.value = result;
      return true;
    } catch (error) {
      if (requestGeneration === generation) {
        const code = errorCode(error);
        const key =
          code === "VERSION_CONFLICT"
            ? "GAME_PHASE"
            : code === "GAME_FULL" && current?.kind === "uno"
              ? "UNO_FULL"
              : code;
        notify(t("error." + key));
      }
      return false;
    } finally {
      if (requestGeneration === generation) {
        busy.value = false;
        await refresh();
      }
    }
  }

  watch(
    () => [toValue(roomId), toValue(gameId)] as const,
    () => {
      generation++;
      reading = false;
      busy.value = false;
      game.value = null;
      loaded.value = false;
      failed.value = false;
      if (toValue(gameId) && toValue(enabled)) void refresh();
    },
    { immediate: true, flush: "sync" },
  );
  watch(
    () => toValue(enabled),
    (value) => {
      if (value) void refresh();
    },
    { flush: "sync" },
  );
  onMounted(() => {
    timer = setInterval(() => {
      if (toValue(enabled)) void refresh();
    }, 1500);
  });
  onBeforeUnmount(() => {
    disposed = true;
    generation++;
    clearInterval(timer);
  });

  return { game, busy, loaded, failed, refresh, act };
}
