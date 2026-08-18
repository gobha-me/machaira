<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, ApiError, type ManagedUser, type UserRole } from '../services/api'
import { useAuth } from '../stores/auth'

const auth = useAuth()
const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const accountMessage = ref('')
const accountError = ref('')
const busy = ref(false)

const users = ref<ManagedUser[]>([])
const usersError = ref('')
const newUsername = ref('')
const newUserPassword = ref('')
const newUserRole = ref<UserRole>('member')
const resettingId = ref<string | null>(null)
const resetPassword = ref('')

function errorMessage(caught: unknown): string {
  return caught instanceof ApiError ? caught.message : 'The request could not be completed.'
}

async function changePassword() {
  accountMessage.value = ''
  accountError.value = ''
  if (newPassword.value !== confirmPassword.value) {
    accountError.value = 'New passwords do not match.'
    return
  }
  busy.value = true
  try {
    await api.changePassword(currentPassword.value, newPassword.value)
    currentPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
    accountMessage.value = 'Password updated. Other sessions were signed out.'
  } catch (caught) {
    accountError.value = errorMessage(caught)
  } finally {
    busy.value = false
  }
}

async function loadUsers() {
  if (!auth.isAdmin) return
  try {
    users.value = await api.users()
  } catch (caught) {
    usersError.value = errorMessage(caught)
  }
}

async function createUser() {
  usersError.value = ''
  busy.value = true
  try {
    await api.createUser(newUsername.value, newUserPassword.value, newUserRole.value)
    newUsername.value = ''
    newUserPassword.value = ''
    newUserRole.value = 'member'
    await loadUsers()
  } catch (caught) {
    usersError.value = errorMessage(caught)
  } finally {
    busy.value = false
  }
}

async function setDisabled(user: ManagedUser) {
  const action = user.disabled ? 'enable' : 'disable'
  if (!window.confirm(`${action[0].toUpperCase()}${action.slice(1)} ${user.username}?`)) return
  usersError.value = ''
  try {
    await api.setUserDisabled(user.id, !user.disabled)
    await loadUsers()
  } catch (caught) {
    usersError.value = errorMessage(caught)
  }
}

async function resetUser(user: ManagedUser) {
  usersError.value = ''
  try {
    await api.resetUserPassword(user.id, resetPassword.value)
    resettingId.value = null
    resetPassword.value = ''
  } catch (caught) {
    usersError.value = errorMessage(caught)
  }
}

onMounted(loadUsers)
</script>

<template>
  <div class="section-label">Account</div>
  <div class="card">
    <div class="row bordered">
      <div class="row-text">
        <div class="row-title">{{ auth.user?.username }}</div>
        <div class="row-sub">{{ auth.isAdmin ? 'Administrator' : 'Member' }}</div>
      </div>
      <div class="spacer"></div>
      <button class="pill action hover-line" @click="auth.logout">Sign out</button>
    </div>
    <form class="password-form" @submit.prevent="changePassword">
      <div class="row-text">
        <div class="row-title">Change password</div>
        <div class="row-sub">At least 12 characters; all other sessions will be signed out</div>
      </div>
      <div class="fields">
        <input v-model="currentPassword" required type="password" autocomplete="current-password" placeholder="Current password" />
        <input v-model="newPassword" required type="password" autocomplete="new-password" minlength="12" placeholder="New password" />
        <input v-model="confirmPassword" required type="password" autocomplete="new-password" minlength="12" placeholder="Confirm new password" />
        <button class="pill action hover-line" :disabled="busy">Update password</button>
      </div>
      <div v-if="accountError" class="message error">{{ accountError }}</div>
      <div v-if="accountMessage" class="message">{{ accountMessage }}</div>
    </form>
  </div>

  <template v-if="auth.isAdmin">
    <div class="section-label">Users</div>
    <div class="card">
      <form class="create-form bordered" @submit.prevent="createUser">
        <div class="row-title">Provision an account</div>
        <div class="fields horizontal">
          <input v-model="newUsername" required autocomplete="off" placeholder="Username" />
          <input v-model="newUserPassword" required type="password" autocomplete="new-password" minlength="12" placeholder="Temporary password" />
          <select v-model="newUserRole">
            <option value="member">Member</option>
            <option value="admin">Administrator</option>
          </select>
          <button class="pill action hover-line" :disabled="busy">Create</button>
        </div>
      </form>
      <div v-for="user in users" :key="user.id" class="user-row bordered">
        <div class="row-text">
          <div class="row-title">
            {{ user.username }}
            <span v-if="user.id === auth.user?.id" class="badge">You</span>
          </div>
          <div class="row-sub">{{ user.role === 'admin' ? 'Administrator' : 'Member' }}{{ user.disabled ? ' · Disabled' : '' }}</div>
        </div>
        <div class="spacer"></div>
        <template v-if="resettingId === user.id">
          <input v-model="resetPassword" class="reset-input" type="password" minlength="12" placeholder="New password" />
          <button class="pill action hover-line" @click="resetUser(user)">Save</button>
          <button class="pill action hover-line" @click="resettingId = null; resetPassword = ''">Cancel</button>
        </template>
        <template v-else>
          <button
            class="pill action hover-line"
            :disabled="user.id === auth.user?.id"
            @click="resettingId = user.id"
          >Reset password</button>
          <button
            class="pill action hover-line"
            :disabled="user.id === auth.user?.id"
            @click="setDisabled(user)"
          >{{ user.disabled ? 'Enable' : 'Disable' }}</button>
        </template>
      </div>
      <div v-if="usersError" class="message error users-error">{{ usersError }}</div>
    </div>
  </template>
</template>

<style scoped>
.section-label {
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 10px;
}
.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
  margin-bottom: 30px;
}
.row, .user-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 15px 18px;
}
.bordered { border-bottom: 1px solid var(--line); }
.row-title { font-size: 14px; font-weight: 600; }
.row-sub { margin-top: 2px; color: var(--muted); font-size: 12px; }
.spacer { flex: 1; }
.pill {
  padding: 8px 13px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: none;
  color: var(--ink);
  font-size: 12.5px;
  font-weight: 600;
}
.pill.action { cursor: pointer; }
.pill:disabled { cursor: default; opacity: 0.5; }
.password-form, .create-form { padding: 17px 18px; }
.fields { display: grid; gap: 9px; margin-top: 13px; }
.fields.horizontal { grid-template-columns: 1fr 1.5fr auto auto; }
input, select {
  min-width: 0;
  padding: 9px 11px;
  border: 1px solid var(--line);
  border-radius: 8px;
  outline: none;
  background: var(--paper);
  color: var(--ink);
  font-size: 12.5px;
}
input:focus, select:focus { border-color: var(--accent); }
.reset-input { width: 160px; }
.message { margin-top: 10px; color: var(--muted); font-size: 12px; }
.message.error { color: var(--accent); }
.users-error { padding: 0 18px 15px; }
.badge {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 5px;
  background: var(--soft);
  color: var(--muted);
  font-size: 9px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
@media (max-width: 700px) {
  .fields.horizontal { grid-template-columns: 1fr; }
  .user-row { align-items: flex-start; flex-wrap: wrap; }
  .user-row .spacer { display: none; }
}
</style>
