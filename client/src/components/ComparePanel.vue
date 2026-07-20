<script setup lang="ts">
import { computed } from 'vue'
import type { CompareRow } from '../services/api'

// The verses × translations comparison body, shared by Read (rail card) and Study (page panel)
// so the layout lives in one place. Purely presentational: the host owns the header/chrome and
// passes compare state in. Translation-major stacked — each translation block lists the range's
// verses inline, each prefixed by a small verse number. The number is hidden when the whole
// comparison is a single verse, so single-verse compare looks exactly as it did before.
const props = withDefaults(
  defineProps<{
    rows: CompareRow[]
    comparing: boolean
    error: string | null
    variant?: 'rail' | 'page'
  }>(),
  { variant: 'rail' }
)

// Show verse markers only when the selection actually spans more than one verse. Keyed on the
// data (any row with >1 verse) so versification differences never leave a lone verse unlabeled.
const multiVerse = computed(() => props.rows.some((r) => r.verses.length > 1))
</script>

<template>
  <div v-if="comparing" class="cp-state">Comparing…</div>
  <p v-else-if="error" class="cp-error">{{ error }}</p>
  <div v-else-if="rows.length" class="cp-list" :class="variant">
    <div
      v-for="(r, i) in rows"
      :key="r.module"
      class="cp-row"
      :class="{ last: i === rows.length - 1 }"
    >
      <span class="cp-tag" :style="{ color: i === 0 ? 'var(--accent)' : 'var(--muted)' }">
        {{ r.module }}
      </span>
      <div class="cp-verses">
        <p v-for="v in r.verses" :key="v.n" class="cp-verse serif">
          <sup v-if="multiVerse" class="cp-vn">{{ v.n }}</sup>{{ v.text ?? '—' }}
        </p>
      </div>
    </div>
  </div>
  <p v-else class="cp-state">
    Install more than one translation in the Library to compare renderings.
  </p>
</template>

<style scoped>
.cp-state {
  font-size: 13px;
  line-height: 1.5;
  color: var(--muted);
  margin: 0;
}
.cp-error {
  font-size: 13px;
  color: var(--accent);
  margin: 0;
}
.cp-verses {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.cp-verse {
  margin: 0;
  color: var(--ink);
}
.cp-vn {
  font-family: 'Instrument Sans', sans-serif;
  font-size: 0.62em;
  font-weight: 700;
  color: var(--accent);
  margin-right: 4px;
  vertical-align: baseline;
  top: -0.4em;
}

/* Rail (Read): compact, tag stacked above the verses. */
.cp-list.rail {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.rail .cp-row {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.rail .cp-tag {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.rail .cp-verse {
  font-size: 13px;
  line-height: 1.5;
}

/* Page (Study): bordered card, tag in a fixed left column with row dividers. */
.cp-list.page {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
  margin-bottom: 16px;
}
.page .cp-row {
  display: flex;
  gap: 14px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--line);
}
.page .cp-row.last {
  border-bottom: none;
}
.page .cp-tag {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  width: 52px;
  flex-shrink: 0;
  padding-top: 3px;
}
.page .cp-verse {
  font-size: 16.5px;
  line-height: 1.6;
}
</style>
