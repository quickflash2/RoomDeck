<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { ArrowLeft, Plus, Trash2, UserRound, Users } from "lucide-vue-next";
import { api, errorCode, notify } from "../api";
import type { ManagedUser, Status } from "../types";
import Modal from "../components/Modal.vue";

const { t } = useI18n();
const router = useRouter();
const account = ref<Status | null>(null);
const users = ref<ManagedUser[]>([]);
const ready = ref(false);
const loading = ref(true);
const error = ref("");
const formError = ref("");
const busy = ref(false);
const showCreate = ref(false);
const username = ref("");
const password = ref("");
const deleteTarget = ref<ManagedUser | null>(null);
const confirmUsername = ref("");

onMounted(load);
async function load() {
  loading.value = true;
  error.value = "";
  try {
    const status = await api<Status>("/status");
    if (status.setup_required || !status.authenticated) {
      await router.replace(status.setup_required ? "/setup" : "/login");
      return;
    }
    if (status.role !== "admin") {
      notify(t("error.FORBIDDEN"));
      await router.replace("/");
      return;
    }
    account.value = status;
    ready.value = true;
    users.value = await api<ManagedUser[]>("/users");
  } catch (e) {
    error.value = errorCode(e);
  } finally {
    loading.value = false;
  }
}
function openCreate() {
  username.value = "";
  password.value = "";
  formError.value = "";
  showCreate.value = true;
}
async function createUser() {
  busy.value = true;
  formError.value = "";
  try {
    const user = await api<ManagedUser>("/users", "POST", {
      username: username.value,
      password: password.value,
    });
    users.value = [...users.value, user].sort((a, b) =>
      a.username.localeCompare(b.username),
    );
    showCreate.value = false;
    notify(t("admin.created", { name: user.username }));
  } catch (e) {
    formError.value = errorCode(e);
  } finally {
    busy.value = false;
  }
}
function confirmDelete(user: ManagedUser) {
  deleteTarget.value = user;
  confirmUsername.value = "";
  formError.value = "";
}
async function deleteUser() {
  const target = deleteTarget.value;
  if (!target || confirmUsername.value !== target.username) return;
  busy.value = true;
  formError.value = "";
  try {
    const result = await api<{ ok: boolean; deleted_rooms: number }>(
      "/users/" + encodeURIComponent(target.id),
      "DELETE",
    );
    users.value = users.value.filter((user) => user.id !== target.id);
    deleteTarget.value = null;
    notify(
      t("admin.deleted", { name: target.username, n: result.deleted_rooms }),
    );
  } catch (e) {
    formError.value = errorCode(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="home-container admin-users">
    <div v-motion class="home-heading">
      <div>
        <RouterLink to="/" class="text-link admin-back">
          <ArrowLeft :size="17" />{{ t("app.back") }}
        </RouterLink>
        <p class="eyebrow">{{ t("admin.role") }}</p>
        <h1>{{ t("admin.title") }}</h1>
        <p class="muted">{{ t("admin.subtitle") }}</p>
        <p v-if="account" class="muted admin-account">
          {{ t("admin.signedIn", { name: account.username }) }}
        </p>
      </div>
      <button v-if="ready" class="primary" @click="openCreate">
        <Plus :size="18" />{{ t("admin.add") }}
      </button>
    </div>

    <div v-if="loading" class="user-list" aria-busy="true">
      <div v-for="i in 3" :key="i" class="skeleton user-skeleton"></div>
    </div>
    <p v-else-if="error" class="error" role="alert">
      {{ t("error." + error) }}
      <button @click="load">{{ t("app.retry") }}</button>
    </p>
    <section v-else-if="ready" class="room-section">
      <div class="section-head">
        <h2>{{ t("admin.users") }}</h2>
        <span class="count">{{ users.length }}</span>
      </div>
      <div v-if="users.length" v-motion class="user-list">
        <article v-for="user in users" :key="user.id" class="user-card">
          <span class="user-avatar" aria-hidden="true">
            <UserRound :size="22" />
          </span>
          <div class="grow">
            <h3>{{ user.username }}</h3>
            <p class="muted">
              {{ t("admin.roomCount", { n: user.room_count }) }}
            </p>
          </div>
          <button
            class="icon-button danger-text"
            :aria-label="t('app.delete') + ' ' + user.username"
            :title="t('app.delete')"
            @click="confirmDelete(user)"
          >
            <Trash2 :size="19" />
          </button>
        </article>
      </div>
      <div v-else class="welcome-empty">
        <Users :size="48" stroke-width="1" />
        <h2>{{ t("admin.emptyTitle") }}</h2>
        <p>{{ t("admin.emptyHelp") }}</p>
        <button class="primary" @click="openCreate">
          <Plus :size="18" />{{ t("admin.add") }}
        </button>
      </div>
    </section>

    <DialogTransition>
      <Modal
        v-if="showCreate"
        :title="t('admin.add')"
        :busy="busy"
        @close="showCreate = false"
      >
        <form class="form-stack" @submit.prevent="createUser">
          <p class="muted">{{ t("admin.createHelp") }}</p>
          <label>
            {{ t("auth.username") }}
            <input
              v-model="username"
              required
              maxlength="40"
              autocomplete="off"
              autofocus
            />
          </label>
          <label>
            {{ t("auth.password") }}
            <input
              v-model="password"
              type="password"
              required
              minlength="12"
              maxlength="72"
              autocomplete="new-password"
            />
            <small>{{ t("auth.passwordHint") }}</small>
          </label>
          <p v-if="formError" class="error" role="alert">
            {{ t("error." + formError) }}
          </p>
          <button class="primary" :disabled="busy">
            {{ t(busy ? "app.working" : "admin.add") }}
          </button>
        </form>
      </Modal>
    </DialogTransition>

    <DialogTransition>
      <Modal
        v-if="deleteTarget"
        :title="t('admin.deleteTitle', { name: deleteTarget.username })"
        :busy="busy"
        @close="deleteTarget = null"
      >
        <form class="form-stack" @submit.prevent="deleteUser">
          <p class="danger-text">
            {{ t("admin.deleteHelp", { n: deleteTarget.room_count }) }}
          </p>
          <label>
            {{ t("admin.confirmUsername") }}
            <input
              v-model="confirmUsername"
              :placeholder="deleteTarget.username"
              autocomplete="off"
              required
              autofocus
            />
          </label>
          <p v-if="formError" class="error" role="alert">
            {{ t("error." + formError) }}
          </p>
          <button
            class="danger"
            :disabled="busy || confirmUsername !== deleteTarget.username"
          >
            <Trash2 :size="18" />
            {{ t(busy ? "app.working" : "app.delete") }}
          </button>
        </form>
      </Modal>
    </DialogTransition>
  </main>
</template>

<style scoped>
.admin-back {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 24px;
}
.admin-account {
  margin-top: 8px;
  font-size: 13px;
}
.user-list {
  display: grid;
  gap: 12px;
}
.user-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px 22px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--bg);
}
.user-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  border-radius: 50%;
  color: var(--primary);
  background: var(--soft);
}
.user-skeleton {
  height: 86px;
  border-radius: 14px;
}
@media (max-width: 640px) {
  .admin-users .home-heading > button {
    width: 100%;
  }
  .user-card {
    padding: 16px;
  }
}
</style>
