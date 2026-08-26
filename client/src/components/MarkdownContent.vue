<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown } from '../utils/markdown'

const props = defineProps<{ source: string }>()
const rendered = computed(() => renderMarkdown(props.source))
</script>

<template>
  <!-- renderMarkdown escapes raw HTML and validates every generated link before this boundary. -->
  <div class="markdown-content" v-html="rendered"></div>
</template>

<style scoped>
.markdown-content {
  min-width: 0;
  color: inherit;
  overflow-wrap: anywhere;
}
.markdown-content :deep(> :first-child) { margin-top: 0; }
.markdown-content :deep(> :last-child) { margin-bottom: 0; }
.markdown-content :deep(h1),
.markdown-content :deep(h2),
.markdown-content :deep(h3),
.markdown-content :deep(h4),
.markdown-content :deep(h5),
.markdown-content :deep(h6) {
  margin: 1.1em 0 0.45em;
  color: var(--ink);
  font-family: 'Cormorant Garamond', Georgia, serif;
  font-weight: 600;
  line-height: 1.2;
}
.markdown-content :deep(h1) { font-size: 1.65em; }
.markdown-content :deep(h2) { font-size: 1.45em; }
.markdown-content :deep(h3) { font-size: 1.25em; }
.markdown-content :deep(h4),
.markdown-content :deep(h5),
.markdown-content :deep(h6) { font-size: 1.08em; }
.markdown-content :deep(p) { margin: 0.65em 0; }
.markdown-content :deep(ul),
.markdown-content :deep(ol) {
  margin: 0.65em 0;
  padding-left: 1.55em;
}
.markdown-content :deep(li + li) { margin-top: 0.3em; }
.markdown-content :deep(blockquote) {
  margin: 0.8em 0;
  padding: 0.1em 0 0.1em 0.9em;
  border-left: 3px solid color-mix(in oklab, var(--accent) 55%, var(--line));
  color: var(--muted);
}
.markdown-content :deep(blockquote > :first-child) { margin-top: 0; }
.markdown-content :deep(blockquote > :last-child) { margin-bottom: 0; }
.markdown-content :deep(a) {
  color: var(--accent);
  text-decoration-thickness: 1px;
  text-underline-offset: 0.14em;
}
.markdown-content :deep(code) {
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 0.08em 0.3em;
  background: var(--soft);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.88em;
  overflow-wrap: normal;
}
.markdown-content :deep(pre) {
  box-sizing: border-box;
  max-width: 100%;
  margin: 0.8em 0;
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 0.8em;
  background: var(--soft);
  overflow-x: auto;
}
.markdown-content :deep(pre code) {
  border: 0;
  padding: 0;
  background: none;
  white-space: pre;
}
</style>
