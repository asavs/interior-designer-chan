import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { fileUrl, stickerUrl, type Img, type Placement } from './api'

type Point = { x: number; y: number }
type Gesture = { key: string; start: Placement; raised?: boolean } & (
  | { kind: 'drag'; from: Point }
  | { kind: 'pinch'; dist: number; angle: number; mid: Point }
  | { kind: 'handle'; centre: Point; dist: number; angle: number }
)

const QUARTER = Math.PI / 2
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

/** Rotation clicks into place when it comes within a few degrees of square. */
function snap(rot: number) {
  const nearest = Math.round(rot / QUARTER) * QUARTER
  return Math.abs(rot - nearest) < 0.07 ? nearest : rot
}

const span = (a: Point, b: Point) => ({
  dist: Math.hypot(b.x - a.x, b.y - a.y) || 1,
  angle: Math.atan2(b.y - a.y, b.x - a.x),
  mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
})

/**
 * A picture whose things can always be moved. It sits in the page like any image: a finger on the picture
 * scrolls or swipes, a finger on a thing drags it. While a thing is held, the whole picture belongs to it, so a
 * second finger anywhere pinches and twists.
 *
 * There are no buttons for arranging. Moving a thing brings it to the front, a double tap flips it, the small
 * cross takes it away, and a tap anywhere else lets go.
 *
 * When `result` is given, the finished design is shown and the things sit invisibly where they were placed,
 * ready to be grabbed. A tap on the picture shows them.
 */
export function Canvas(props: {
  clean: Img
  result?: Img
  layout: Placement[]
  items: Img[]
  onChange: (layout: Placement[]) => void
  children?: ReactNode
}) {
  const [selected, setSelected] = useState<string | null>(null)
  // On a finished design a tap lifts the things into view, since the model may have set them down a little
  // away from where they were placed.
  const [peek, setPeek] = useState(false)
  useEffect(() => setPeek(false), [props.result?.id])
  const wrap = useRef<HTMLDivElement>(null)
  const el = useRef<HTMLDivElement>(null)

  // Gesture bookkeeping lives in refs: it changes on every pointer event and must never be stale.
  const live = useRef({ layout: props.layout, selected, onChange: props.onChange })
  live.current = { layout: props.layout, selected, onChange: props.onChange }
  const pointers = useRef(new Map<number, Point>())
  const gesture = useRef<Gesture | null>(null)
  const travelled = useRef(0)
  const startedOnSticker = useRef(false)
  const lastTap = useRef<{ key: string | null; at: number }>({ key: null, at: 0 })

  const select = (key: string | null) => {
    live.current.selected = key
    setSelected(key)
  }
  const commit = (next: Placement[]) => {
    live.current.layout = next
    live.current.onChange(next)
  }
  const change = (key: string, patch: Partial<Placement>) =>
    commit(live.current.layout.map((p) => (p.key === key ? { ...p, ...patch } : p)))

  /** Applies one step of a gesture. The first step also brings the thing to the front. */
  function move(g: Gesture, patch: Partial<Placement>) {
    let next = live.current.layout
    const held = next.find((p) => p.key === g.key)
    if (!held) return
    if (!g.raised) {
      g.raised = true
      next = [...next.filter((p) => p.key !== g.key), held]
    }
    commit(next.map((p) => (p.key === g.key ? { ...p, ...patch } : p)))
  }

  // A thing dropped in from the dock arrives already held.
  const known = useRef(new Set(props.layout.map((p) => p.key)))
  useEffect(() => {
    const fresh = props.layout.filter((p) => !known.current.has(p.key))
    known.current = new Set(props.layout.map((p) => p.key))
    if (fresh.length === 1) select(fresh[0].key)
    else if (live.current.selected && !known.current.has(live.current.selected)) select(null)
  }, [props.layout])

  useEffect(() => {
    if (!selected) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea')) return
      if (e.key === 'Escape') return select(null)
      const p = live.current.layout.find((x) => x.key === live.current.selected)
      if (!p) return
      const step = e.shiftKey ? 0.02 : 0.004
      const nudge: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        commit(live.current.layout.filter((x) => x.key !== p.key))
        select(null)
      } else if (nudge[e.key]) {
        change(p.key, { x: clamp(p.x + nudge[e.key][0], 0, 1), y: clamp(p.y + nudge[e.key][1], 0, 1) })
      } else {
        return
      }
      e.preventDefault()
    }
    const onWheel = (e: WheelEvent) => {
      const p = live.current.layout.find((x) => x.key === live.current.selected)
      if (!p) return
      e.preventDefault()
      change(p.key, { w: clamp(p.w * Math.exp(-e.deltaY * 0.0015), 0.04, 2.5) })
    }
    // A touch anywhere outside this picture lets go.
    const away = (e: Event) => {
      if (!wrap.current?.contains(e.target as Node)) select(null)
    }
    // Safari's own pinch-to-zoom-the-page gesture would otherwise fight the sticker pinch.
    const stop = (e: Event) => e.preventDefault()
    const node = el.current
    // Capture, so a held thing gets the arrow keys before a surrounding carousel pages with them.
    window.addEventListener('keydown', onKey, true)
    node?.addEventListener('wheel', onWheel, { passive: false })
    document.addEventListener('pointerdown', away)
    document.addEventListener('gesturestart', stop)
    document.addEventListener('gesturechange', stop)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      node?.removeEventListener('wheel', onWheel)
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('gesturestart', stop)
      document.removeEventListener('gesturechange', stop)
    }
  }, [selected])

  /** Starts a fresh gesture from the fingers currently down, so lifting one finger never makes a thing jump. */
  function begin(key: string | null) {
    const start = live.current.layout.find((p) => p.key === key)
    const pts = [...pointers.current.values()]
    if (!start || !pts.length) gesture.current = null
    else if (pts.length === 1) gesture.current = { kind: 'drag', key: start.key, start, from: pts[0] }
    else gesture.current = { kind: 'pinch', key: start.key, start, ...span(pts[0], pts[1]) }
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const target = e.target as HTMLElement
    const hit = target.closest<HTMLElement>('[data-key]')?.dataset.key ?? null
    if (hit && target.closest('[data-remove]')) {
      commit(live.current.layout.filter((p) => p.key !== hit))
      return select(null)
    }
    // Nothing held and nothing touched: this finger is scrolling the page.
    if (!hit && !live.current.selected) return
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // The pointer is already gone; the gesture simply ends at the picture's edge.
    }
    const at = { x: e.clientX, y: e.clientY }
    pointers.current.set(e.pointerId, at)

    if (pointers.current.size === 1) {
      travelled.current = 0
      startedOnSticker.current = !!hit
      const start = live.current.layout.find((p) => p.key === hit)
      if (start && target.closest('[data-handle]')) {
        const rect = e.currentTarget.getBoundingClientRect()
        const centre = { x: rect.left + start.x * rect.width, y: rect.top + start.y * rect.height }
        const { dist, angle } = span(centre, at)
        gesture.current = { kind: 'handle', key: start.key, start, centre, dist, angle }
        return
      }
      if (hit) select(hit)
      begin(hit)
    } else {
      // A second finger anywhere on the picture pinches the held thing; it need not land on it.
      const key = live.current.selected ?? hit
      if (key) select(key)
      begin(key)
    }
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const before = pointers.current.get(e.pointerId)
    if (!before) return
    const at = { x: e.clientX, y: e.clientY }
    pointers.current.set(e.pointerId, at)
    travelled.current += Math.hypot(at.x - before.x, at.y - before.y)

    const g = gesture.current
    if (!g) return
    const rect = e.currentTarget.getBoundingClientRect()
    const moved = (from: Point, to: Point) => ({
      x: clamp(g.start.x + (to.x - from.x) / rect.width, 0, 1),
      y: clamp(g.start.y + (to.y - from.y) / rect.height, 0, 1),
    })

    if (g.kind === 'drag') {
      // A tap must not count as a move, or touching a finished design would discard it.
      if (travelled.current > 3) move(g, moved(g.from, at))
    } else if (g.kind === 'handle') {
      const now = span(g.centre, at)
      move(g, {
        w: clamp((g.start.w * now.dist) / g.dist, 0.04, 2.5),
        rot: snap(g.start.rot + now.angle - g.angle),
      })
    } else {
      const pts = [...pointers.current.values()]
      if (pts.length < 2) return
      const now = span(pts[0], pts[1])
      move(g, {
        ...moved(g.mid, now.mid),
        w: clamp((g.start.w * now.dist) / g.dist, 0.04, 2.5),
        rot: snap(g.start.rot + now.angle - g.angle),
      })
    }
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    if (!pointers.current.delete(e.pointerId)) return
    if (pointers.current.size) return begin(gesture.current?.key ?? live.current.selected)
    const key = gesture.current?.key ?? null
    gesture.current = null
    if (travelled.current >= 8) return
    if (!startedOnSticker.current) return select(null)

    // Two quick taps on the same thing flip it.
    const now = performance.now()
    const held = live.current.layout.find((p) => p.key === key)
    if (held && lastTap.current.key === key && now - lastTap.current.at < 350) {
      change(held.key, { flip: !held.flip })
      lastTap.current = { key: null, at: 0 }
    } else {
      lastTap.current = { key, at: now }
    }
  }

  return (
    <div ref={wrap} className="node-pic">
      <div
        ref={el}
        className={'canvas' + (selected ? ' holding' : '')}
        // While a thing is held, a mouse drag anywhere on the picture belongs to it, not to a carousel.
        data-carousel-no-drag={selected ? '' : undefined}
        onClick={(e) => {
          if (props.result) setPeek((on) => !!(e.target as HTMLElement).closest('[data-key]') || !on)
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <img className="stage-photo" src={fileUrl(props.result ?? props.clean)} alt="" draggable={false} />
        {props.layout.map((p) => {
          const item = props.items.find((i) => i.id === p.itemId)
          if (!item) return null
          const held = p.key === selected
          return (
            <div
              key={p.key}
              data-key={p.key}
              data-carousel-no-drag=""
              className={'sticker' + (held ? ' selected' : '') + (props.result ? (peek ? ' peek' : ' unseen') : '')}
              style={{
                left: `${p.x * 100}%`,
                top: `${p.y * 100}%`,
                width: `${p.w * 100}%`,
                transform: `translate(-50%, -50%) rotate(${p.rot}rad)`,
              }}
            >
              <img
                src={stickerUrl(item)}
                alt={item.name}
                draggable={false}
                style={p.flip ? { transform: 'scaleX(-1)' } : undefined}
              />
              {held && (
                <>
                  <span className="remove" data-remove role="button" aria-label="Take this out of the picture">
                    ×
                  </span>
                  <span className="handle" data-handle aria-hidden />
                </>
              )}
            </div>
          )
        })}
      </div>
      {props.children}
    </div>
  )
}
