// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import userEvent from '@testing-library/user-event'
import type { CrossReferenceMapPayload } from '@machaira/scripture'
import CrossReferenceMapCanvas from './CrossReferenceMapCanvas.vue'
import { mapArcs } from '../utils/crossReferenceMap'

// Real aggregate/example from the bundled OpenBible snapshot.
const payload: CrossReferenceMapPayload = {
  nodes: [
    { id: 'Gen', book: 'Gen', label: 'Genesis', chapter: null, verse: null },
    { id: 'Rev', book: 'Rev', label: 'Revelation', chapter: null, verse: null }
  ],
  edges: [{ source: 'Gen', target: 'Rev', count: 82, sample: { source: 'Gen.1.1', target: 'Rev.14.7' } }],
  totalLinks: 82, matchedLinks: 82
}
let wrapper: VueWrapper
let frames: Map<number, FrameRequestCallback>
let nextFrame: number
const context = { scale: vi.fn(), translate: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), quadraticCurveTo: vi.fn(), stroke: vi.fn() }
const disconnect = vi.fn()
async function draw() {
  const pending = [...frames.values()]
  frames.clear()
  pending.forEach((callback) => callback(0))
  await nextTick()
  await nextTick()
}
async function render() {
  wrapper = mount(CrossReferenceMapCanvas, { props: { payload, distances: [], similarity: false, maximum: 2 }, attachTo: document.body })
  await draw()
}
async function pointer(type: string, x: number, y: number, id = 1) {
  await wrapper.get('canvas').trigger(type, { pointerId: id, button: 0, clientX: x + 30, clientY: y + 20 })
  await draw()
}
beforeEach(() => {
  frames = new Map()
  nextFrame = 1
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = nextFrame++; frames.set(id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect = disconnect })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(300)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(90)
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 30, top: 20, width: 800, height: 300, right: 830, bottom: 320, x: 30, y: 20, toJSON() {} })
})
afterEach(() => {
  wrapper?.unmount()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

describe('map pointer interactions and recovery', () => {
  it('zooms at the cursor, hit-tests transformed arcs, and resets at scope changes', async () => {
    await render()
    const canvas = wrapper.get('canvas')
    const wheel = new WheelEvent('wheel', { deltaY: -Math.log(2) / 0.002, clientX: 230, clientY: 120, bubbles: true, cancelable: true })
    // Happy DOM's WheelEvent omits inherited MouseEvent coordinates.
    Object.defineProperties(wheel, { clientX: { value: 230 }, clientY: { value: 120 } })
    canvas.element.dispatchEvent(wheel)
    await draw()
    expect(wheel.defaultPrevented).toBe(true)
    expect(wrapper.get('[aria-label="Reset map view"]').text()).toContain('200%')
    expect(context.translate).toHaveBeenLastCalledWith(-200, -100)
    const arc = mapArcs(payload, 800, 300)[0]
    const x = (arc.x1 + arc.x2) / 2, y = arc.y - arc.rise
    await pointer('pointermove', x * 2 - 200, y * 2 - 100)
    expect(wrapper.get('[role=tooltip]').text()).toContain('82 links')
    await pointer('pointerdown', x * 2 - 200, y * 2 - 100)
    await pointer('pointerup', x * 2 - 200, y * 2 - 100)
    expect(wrapper.emitted('open')).toEqual([[payload.edges[0]]])
    await wrapper.setProps({ payload: { ...payload, edges: [] } })
    await draw()
    expect(wrapper.find('[role=tooltip]').exists()).toBe(false)
    expect(wrapper.get('[aria-label="Zoom out"]').attributes('disabled')).toBeDefined()
    await pointer('pointerdown', 200, 100)
    await pointer('pointerup', 200, 100)
    expect(wrapper.emitted('open')).toHaveLength(1)
  })

  it('never opens a passage or selects an axis label after dragging, even if dragged back to the start', async () => {
    await render()
    await wrapper.get('[aria-label="Zoom in"]').trigger('click')
    await draw()
    await pointer('pointerdown', 300, 100)
    await pointer('pointermove', 200, 80)
    expect(context.translate).toHaveBeenLastCalledWith(-300, -95)
    // An unrelated pointer cannot move or finish the active drag.
    await pointer('pointermove', 700, 200, 2)
    await pointer('pointerup', 700, 200, 2)
    expect(context.translate).toHaveBeenLastCalledWith(-300, -95)
    await pointer('pointermove', 300, 100)
    await pointer('pointerup', 300, 100)
    expect(wrapper.emitted('open')).toBeUndefined()
    await wrapper.get('[aria-label="Reset map view"]').trigger('click')
    await draw()
    const node = wrapper.get('[data-node="Gen"]')
    await node.trigger('pointerdown', { pointerId: 1, button: 0, clientX: 200, clientY: 290 })
    await node.trigger('pointerup', { pointerId: 1, button: 0, clientX: 230, clientY: 290 })
    await node.trigger('click', { detail: 1 })
    expect(wrapper.emitted('select')).toBeUndefined()
    // Keyboard activation still works after a mouse drag.
    const axisButton = node.element as HTMLButtonElement
    axisButton.focus()
    await userEvent.setup().keyboard('{Enter}')
    expect(wrapper.emitted('select')).toEqual([[payload.nodes[0]]])
  })

  it('cancels a drag without navigation and does not treat a bare pointerup as a click', async () => {
    await render()
    const arc = mapArcs(payload, 800, 300)[0]
    const x = (arc.x1 + arc.x2) / 2, y = arc.y - arc.rise
    await pointer('pointerdown', x, y)
    await pointer('pointercancel', x, y)
    await pointer('pointerup', x, y)
    expect(wrapper.emitted('open')).toBeUndefined()
    await pointer('pointerdown', x, y)
    await pointer('pointerup', x, y)
    expect(wrapper.emitted('open')).toHaveLength(1)
  })

  it('shows every book name on hover, keeps the tooltip inside the chart, and clears it on leave', async () => {
    await render()
    const node = wrapper.get('[data-node="Rev"]')
    await node.trigger('pointermove', { pointerId: 1, clientX: 820, clientY: 310 })
    await draw()
    const tooltip = wrapper.get('[role=tooltip]')
    expect(tooltip.text()).toContain('Revelation')
    expect(tooltip.attributes('style')).toContain('left: 492px')
    expect(tooltip.attributes('style')).toContain('top: 186px')
    await node.trigger('pointerdown', { pointerId: 1, button: 0, clientX: 820, clientY: 310 })
    await node.trigger('pointerup', { pointerId: 1, button: 0, clientX: 820, clientY: 310 })
    await node.trigger('click', { detail: 1 })
    expect(wrapper.emitted('select')).toEqual([[payload.nodes[1]]])
    await node.trigger('focus')
    await draw()
    expect(wrapper.get('[role=tooltip]').text()).toContain('Revelation')
    await wrapper.get('.map-viewport').trigger('pointerleave')
    await draw()
    expect(wrapper.find('[role=tooltip]').exists()).toBe(false)
  })

  it('bounds repeated line/page wheel zoom, ignores malformed input, and cleans up pending drawing', async () => {
    await render()
    const canvas = wrapper.get('canvas')
    for (let index = 0; index < 5; index++) {
      await canvas.trigger('wheel', { deltaY: -100, deltaMode: 1, clientX: 430, clientY: 170 })
      await draw()
    }
    expect(wrapper.get('[aria-label="Zoom in"]').attributes('disabled')).toBeDefined()
    await canvas.trigger('wheel', { deltaY: NaN })
    await draw()
    expect(wrapper.get('[aria-label="Reset map view"]').text()).toContain('800%')
    for (let index = 0; index < 5; index++) {
      await canvas.trigger('wheel', { deltaY: 100, deltaMode: 2, clientX: 430, clientY: 170 })
      await draw()
    }
    expect(wrapper.get('[aria-label="Zoom out"]').attributes('disabled')).toBeDefined()
    await pointer('pointermove', 0, 0)
    await canvas.trigger('pointermove', { pointerId: 1, clientX: 100, clientY: 100 })
    expect(frames.size).toBe(1)
    wrapper.unmount()
    expect(frames.size).toBe(0)
    expect(disconnect).toHaveBeenCalled()
  })

  it('releases capture on scope changes and cannot open an old arc after canvas failure', async () => {
    await render()
    const canvas = wrapper.get('canvas')
    await pointer('pointerdown', 400, 100)
    expect(canvas.element.hasPointerCapture(1)).toBe(true)
    await wrapper.setProps({ payload: { ...payload } })
    await draw()
    expect(canvas.element.hasPointerCapture(1)).toBe(false)
    await pointer('pointerup', 400, 100)
    expect(wrapper.emitted('open')).toBeUndefined()
    const arc = mapArcs(payload, 800, 300)[0]
    const x = (arc.x1 + arc.x2) / 2, y = arc.y - arc.rise
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null)
    await pointer('pointermove', x, y)
    await pointer('pointerdown', x, y)
    await pointer('pointerup', x, y)
    expect(wrapper.find('[role=tooltip]').exists()).toBe(false)
    expect(wrapper.emitted('open')).toBeUndefined()
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(context as unknown as CanvasRenderingContext2D)
    await pointer('pointermove', x, y)
    expect(wrapper.get('[role=tooltip]').text()).toContain('82 links')
    const first = wrapper.get('[role=tooltip]').attributes('style')
    await pointer('pointermove', arc.x1 + (arc.x2 - arc.x1) * 0.25, arc.y - arc.rise * 0.75)
    expect(wrapper.get('[role=tooltip]').attributes('style')).not.toBe(first)
  })
})
