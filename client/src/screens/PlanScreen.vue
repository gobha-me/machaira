<script setup lang="ts">
import { computed } from 'vue'
import { useReadingPlan } from '../stores/readingPlan'
import { useReader } from '../stores/reader'
import { useUi } from '../stores/ui'
import { bookName, daySlice, PLAN_DAYS, rangeLabel } from '../services/plan'

const plan = useReadingPlan()
const reader = useReader()
const ui = useUi()

const days = computed(() =>
  Array.from({ length: PLAN_DAYS }, (_, i) => ({
    index: i,
    day: i + 1,
    label: rangeLabel(daySlice(i)),
    complete: plan.isDayComplete(i),
    isToday: i === plan.currentDayIndex,
    isPast: i < plan.currentDayIndex
  }))
)

function openReading(book: string, chapter: number) {
  if (!reader.moduleName) {
    ui.go('library')
    return
  }
  reader.openRef(reader.moduleName, book, chapter)
  ui.go('read')
}

function openToday() {
  const first = plan.firstUnreadToday
  if (first) openReading(first.book, first.chapter)
}

function openDay(index: number) {
  const first = daySlice(index)[0]
  if (first) openReading(first.book, first.chapter)
}

function reset() {
  if (window.confirm('Reset reading-plan progress? This restarts the plan from today.')) {
    plan.reset()
  }
}

function turnOff() {
  plan.setEnabled(false)
  ui.go('read')
}
</script>

<template>
  <div class="scroll">
    <div class="wrap">
      <!-- Disabled: invitation to start -->
      <template v-if="!plan.enabled">
        <div class="intro">
          <div class="intro-mark"></div>
          <h1 class="serif">Bible in a year</h1>
          <p>
            Read from Genesis to Revelation over 365 days — about three or four chapters a
            day. We'll track your progress and show today's reading right where you read.
          </p>
          <button class="start-btn" @click="plan.setEnabled(true)">Start the reading plan</button>
        </div>
      </template>

      <!-- Enabled: dashboard -->
      <template v-else>
        <div class="head">
          <h1 class="serif">Reading plan</h1>
          <div class="spacer"></div>
          <button class="ghost hover-dim" @click="reset">Reset progress</button>
          <button class="ghost hover-dim" @click="turnOff">Turn off</button>
        </div>

        <!-- Progress -->
        <div class="card progress-card">
          <div class="progress-top">
            <div>
              <div class="big">Day {{ plan.currentDay }} <span class="of">of {{ PLAN_DAYS }}</span></div>
              <div class="sub">
                {{ plan.chaptersRead }} of {{ plan.totalChapters }} chapters read
                <span class="pace" :class="{ ok: plan.onTrack }">
                  · {{ plan.onTrack ? 'On track' : `${plan.behindBy} chapter${plan.behindBy === 1 ? '' : 's'} behind` }}
                </span>
              </div>
            </div>
            <div class="pct">{{ plan.percent }}%</div>
          </div>
          <div class="track"><div class="fill" :style="{ width: plan.percent + '%' }"></div></div>
        </div>

        <!-- Today -->
        <div class="section-label">Today · {{ plan.todayLabel }}</div>
        <div class="card">
          <button
            v-for="r in plan.todayReadings"
            :key="`${r.book}/${r.chapter}`"
            class="read-row hover-soft"
            @click="plan.toggleChapter(r.book, r.chapter)"
          >
            <span class="check" :class="{ on: r.read }">{{ r.read ? '✓' : '' }}</span>
            <span class="read-name" :class="{ done: r.read }">{{ bookName(r.book) }} {{ r.chapter }}</span>
            <span class="spacer"></span>
            <span class="open hover-accent-text" @click.stop="openReading(r.book, r.chapter)">Open →</span>
          </button>
          <div class="today-foot">
            <button class="today-open" @click="openToday">Open today's reading</button>
            <button class="today-mark hover-line" @click="plan.markDayRead(plan.currentDayIndex)">
              Mark day as read
            </button>
          </div>
        </div>

        <!-- Overview grid -->
        <div class="section-label">The year</div>
        <div class="grid">
          <button
            v-for="d in days"
            :key="d.index"
            class="cell"
            :class="{ complete: d.complete, today: d.isToday, past: d.isPast && !d.complete }"
            :title="`Day ${d.day} · ${d.label}`"
            @click="openDay(d.index)"
          ></button>
        </div>
        <div class="legend">
          <span class="key"><span class="swatch complete"></span> Read</span>
          <span class="key"><span class="swatch today"></span> Today</span>
          <span class="key"><span class="swatch past"></span> Missed</span>
          <span class="key"><span class="swatch"></span> Upcoming</span>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.scroll {
  flex: 1;
  overflow-y: auto;
}
.wrap {
  max-width: 720px;
  margin: 0 auto;
  padding: 64px 32px 100px;
}
/* intro */
.intro {
  max-width: 420px;
  margin: 8vh auto 0;
  text-align: center;
}
.intro-mark {
  width: 14px;
  height: 14px;
  background: var(--accent);
  transform: rotate(45deg);
  margin: 0 auto 22px;
}
.intro h1 {
  font-weight: 500;
  font-size: 32px;
  margin: 0 0 12px;
}
.intro p {
  font-size: 14px;
  line-height: 1.7;
  color: var(--muted);
  margin: 0 0 24px;
}
.start-btn {
  background: var(--accent);
  color: var(--on-accent);
  border: none;
  border-radius: 8px;
  padding: 11px 20px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
/* head */
.head {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  margin-bottom: 22px;
}
h1 {
  font-weight: 500;
  font-size: 34px;
  margin: 0;
}
.spacer {
  flex: 1;
}
.ghost {
  background: none;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--muted);
  cursor: pointer;
}
.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
  margin-bottom: 24px;
}
.progress-card {
  padding: 20px 22px;
}
.progress-top {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  margin-bottom: 14px;
}
.big {
  font-size: 22px;
  font-weight: 600;
}
.of {
  color: var(--muted);
  font-weight: 500;
  font-size: 15px;
}
.sub {
  font-size: 12.5px;
  color: var(--muted);
  margin-top: 4px;
}
.pace {
  color: var(--accent);
  font-weight: 600;
}
.pace.ok {
  color: var(--gold);
}
.pct {
  margin-left: auto;
  font-size: 26px;
  font-weight: 700;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}
.track {
  height: 6px;
  background: var(--soft);
  border-radius: 3px;
  overflow: hidden;
}
.fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.3s;
}
.section-label {
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 10px;
}
/* today rows */
.read-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  background: none;
  border: none;
  border-bottom: 1px solid var(--line);
  padding: 13px 18px;
  cursor: pointer;
  text-align: left;
}
.check {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  border: 1.5px solid var(--line);
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--on-accent);
}
.check.on {
  background: var(--accent);
  border-color: var(--accent);
}
.read-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink);
}
.read-name.done {
  color: var(--muted);
}
.open {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--accent);
}
.today-foot {
  display: flex;
  gap: 10px;
  padding: 14px 18px;
}
.today-open {
  background: var(--accent);
  color: var(--on-accent);
  border: none;
  border-radius: 8px;
  padding: 9px 16px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.today-mark {
  background: none;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 9px 14px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
  cursor: pointer;
}
/* year grid */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(11px, 1fr));
  gap: 4px;
  margin-bottom: 14px;
}
.cell {
  aspect-ratio: 1;
  border: none;
  border-radius: 3px;
  background: var(--soft);
  cursor: pointer;
  padding: 0;
}
.cell.past {
  background: color-mix(in oklab, var(--accent) 14%, var(--soft));
}
.cell.complete {
  background: var(--accent);
}
.cell.today {
  box-shadow: 0 0 0 2px var(--card), 0 0 0 3px var(--gold);
}
.legend {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
.key {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--muted);
}
.swatch {
  width: 11px;
  height: 11px;
  border-radius: 3px;
  background: var(--soft);
}
.swatch.complete {
  background: var(--accent);
}
.swatch.today {
  background: var(--gold);
}
.swatch.past {
  background: color-mix(in oklab, var(--accent) 14%, var(--soft));
}
</style>
