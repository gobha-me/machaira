<script setup lang="ts">
import { computed, ref } from 'vue'
import { ApiError } from '../services/api'
import { useAuth } from '../stores/auth'

const auth = useAuth()
const username = ref('')
const password = ref('')
const confirming = ref('')
const busy = ref(false)
const error = ref('')
const bootstrapping = computed(() => auth.state === 'bootstrap')

async function submit() {
  error.value = ''
  if (bootstrapping.value && password.value !== confirming.value) {
    error.value = 'Passwords do not match.'
    return
  }
  busy.value = true
  try {
    if (bootstrapping.value) await auth.bootstrap(username.value, password.value)
    else await auth.login(username.value, password.value)
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : 'Unable to connect to Sword.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main class="auth-page">
    <form class="auth-card" @submit.prevent="submit">
      <div class="brand-mark"></div>
      <div class="eyebrow">Sword</div>
      <h1 class="serif">{{ bootstrapping ? 'Create the owner account' : 'Welcome back' }}</h1>
      <p>
        {{ bootstrapping
          ? 'This first account administers access to this Sword instance.'
          : 'Sign in to open your library and journal.' }}
      </p>

      <label>
        Username
        <input v-model="username" required autocomplete="username" autofocus />
      </label>
      <label>
        Password
        <input
          v-model="password"
          required
          type="password"
          :autocomplete="bootstrapping ? 'new-password' : 'current-password'"
          minlength="12"
        />
      </label>
      <label v-if="bootstrapping">
        Confirm password
        <input v-model="confirming" required type="password" autocomplete="new-password" minlength="12" />
      </label>

      <div v-if="error" class="error" role="alert">{{ error }}</div>
      <button class="submit" :disabled="busy">
        {{ busy ? 'Please wait…' : bootstrapping ? 'Create owner' : 'Sign in' }}
      </button>
    </form>
  </main>
</template>

<style scoped>
.auth-page {
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 32px;
  background:
    radial-gradient(circle at 50% 15%, color-mix(in srgb, var(--accent) 9%, transparent), transparent 34%),
    var(--paper);
  color: var(--ink);
}
.auth-card {
  width: min(100%, 400px);
  padding: 42px;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--card);
  box-shadow: 0 24px 70px rgba(35, 29, 20, 0.08);
}
.brand-mark {
  width: 10px;
  height: 10px;
  margin-bottom: 14px;
  background: var(--accent);
  transform: rotate(45deg);
}
.eyebrow {
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-transform: uppercase;
}
h1 {
  margin: 10px 0 8px;
  font-size: 34px;
  font-weight: 500;
}
p {
  margin: 0 0 28px;
  color: var(--muted);
  font-size: 14px;
  line-height: 1.55;
}
label {
  display: block;
  margin-top: 16px;
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
}
input {
  width: 100%;
  margin-top: 7px;
  padding: 11px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  outline: none;
  background: var(--paper);
  color: var(--ink);
  font-size: 14px;
}
input:focus { border-color: var(--accent); }
.error {
  margin-top: 18px;
  color: var(--accent);
  font-size: 13px;
}
.submit {
  width: 100%;
  margin-top: 22px;
  padding: 12px;
  border: none;
  border-radius: 8px;
  background: var(--accent);
  color: var(--on-accent);
  cursor: pointer;
  font-weight: 700;
}
.submit:disabled { cursor: default; opacity: 0.65; }
</style>
