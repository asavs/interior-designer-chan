import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { fileUrl, isCutting, stickerThumbUrl, stickerUrl, type Img, type Placement } from './api'

type Point = { x: number; y: number }
type Gesture =
  | { kind: 'drag'; key: string; start: Placement; from: Point }
  | { kind: 'pinch'; key: string; start: Placement; dist: number; angle: number; mid: Point }
  | { kind: 'handle'; key: string; start: Placement; centre: Point; dist: number; angle: number }

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

/** The room photo with its stickers on top. Positions are fractions of the photo, so it scales freely. */
export function Stage(props: {
  base: Img
  layout: Placement[]
  items: Img[]
  selected?: string | null
  onRatio?: (ratio: number) => void
  children?: ReactNode
}) {
  return (
    <>
      <img
        className="stage-photo"
        src={fileUrl(props.base)}
        alt=""
        draggable={false}
        onLoad={(e) => props.onRatio?.(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight)}
      />
      {props.layout.map((p) => {
        const item = props.items.find((i) => i.id === p.itemId)
        if (!item) return null
        return (
          <div
            key={p.key}
            data-key={p.key}
            className={'sticker' + (p.key === props.selected ? ' selected' : '')}
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
            {p.key === props.selected && <span className="handle" data-handle aria-hidden />}
          </div>
        )
      })}
      {props.children}
    </>
  )
}

export function Arranger(props: {
  base: Img
  items: Img[]
  initial: Placement[]
  /** A design for this room is already being made. */
  busy: boolean
  onDone: (layout: Placement[]) => void
  onRender: (layout: Placement[]) => void
  onAddItems: (files: File[]) => void
}) {
  const [layout, setLayout] = useState(props.initial)
  const [selected, setSelected] = useState<string | null>(null)
  const [ratio, setRatio] = useState<number | null>(null)
  const [fit, setFit] = useState<{ w: number; h: number } | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLDivElement>(null)

  // Gesture bookkeeping lives in refs: it changes on every pointer event and must never be stale.
  const live = useRef({ layout, selected })
  live.current = { layout, selected }
  const pointers = useRef(new Map<number, Point>())
  const gesture = useRef<Gesture | null>(null)
  const travelled = useRef(0)
  const startedOnSticker = useRef(false)

  useLayoutEffect(() => {
    if (!box.current || !ratio) return
    const measure = () => {
      const { width, height } = box.current!.getBoundingClientRect()
      const w = Math.min(width, height * ratio)
      setFit({ w, h: w / ratio })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(box.current)
    return () => observer.disconnect()
  }, [ratio])

  useEffect(() => {
    // Safari's own pinch-to-zoom-the-page gesture would otherwise fight the sticker pinch.
    const stop = (e: Event) => e.preventDefault()
    document.addEventListener('gesturestart', stop)
    document.addEventListener('gesturechange', stop)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('gesturestart', stop)
      document.removeEventListener('gesturechange', stop)
      document.body.style.overflow = ''
    }
  }, [])

  const select = (key: string | null) => {
    live.current.selected = key
    setSelected(key)
  }

  const change = (key: string, next: Partial<Placement>) =>
    setLayout((all) => all.map((p) => (p.key === key ? { ...p, ...next } : p)))

  /** Starts a fresh gesture from the fingers currently down, so lifting one finger never makes a sticker jump. */
  function begin(key: string | null) {
    const start = live.current.layout.find((p) => p.key === key)
    const pts = [...pointers.current.values()]
    if (!start || !pts.length) gesture.current = null
    else if (pts.length === 1) gesture.current = { kind: 'drag', key: start.key, start, from: pts[0] }
    else gesture.current = { kind: 'pinch', key: start.key, start, ...span(pts[0], pts[1]) }
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // The pointer is already gone; the gesture simply ends at the photo's edge.
    }
    const at = { x: e.clientX, y: e.clientY }
    pointers.current.set(e.pointerId, at)
    const target = e.target as HTMLElement
    const hit = target.closest<HTMLElement>('[data-key]')?.dataset.key ?? null

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
      // A second finger anywhere on the photo pinches the selected sticker; it need not land on it.
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
      change(g.key, moved(g.from, at))
    } else if (g.kind === 'handle') {
      const now = span(g.centre, at)
      change(g.key, {
        w: clamp((g.start.w * now.dist) / g.dist, 0.04, 2.5),
        rot: snap(g.start.rot + now.angle - g.angle),
      })
    } else {
      const pts = [...pointers.current.values()]
      if (pts.length < 2) return
      const now = span(pts[0], pts[1])
      change(g.key, {
        ...moved(g.mid, now.mid),
        w: clamp((g.start.w * now.dist) / g.dist, 0.04, 2.5),
        rot: snap(g.start.rot + now.angle - g.angle),
      })
    }
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    if (!pointers.current.delete(e.pointerId)) return
    if (pointers.current.size) return begin(gesture.current?.key ?? live.current.selected)
    if (!startedOnSticker.current && travelled.current < 8) select(null)
    gesture.current = null
  }

  function add(item: Img) {
    const key = `${item.id}-${Date.now().toString(36)}`
    const nudge = (live.current.layout.length % 5) * 0.03
    setLayout((all) => [...all, { key, itemId: item.id, x: 0.5 + nudge, y: 0.58 + nudge, w: 0.32, rot: 0, flip: false }])
    select(key)
  }

  const current = layout.find((p) => p.key === selected)
  const reorder = (toFront: boolean) =>
    current &&
    setLayout((all) => {
      const rest = all.filter((p) => p.key !== current.key)
      return toFront ? [...rest, current] : [current, ...rest]
    })

  return (
    <div className="arranger" role="dialog" aria-modal="true" aria-label="Arrange things in the room">
      <header className="arranger-bar">
        <button className="ghost" onClick={() => props.onDone(layout)}>
          Done
        </button>
        <span className="fine">{layout.length ? 'Roughly is fine (˘ω˘)' : 'Tap a thing to place it'}</span>
        <button className="primary" disabled={!layout.length || props.busy} onClick={() => props.onRender(layout)}>
          {props.busy ? 'Making…' : 'Make it real'}
        </button>
      </header>

      <div className="arranger-box" ref={box}>
        <div
          ref={canvas}
          className="canvas"
          style={fit ? { width: fit.w, height: fit.h } : { visibility: 'hidden' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={(e) => current && change(current.key, { w: clamp(current.w * Math.exp(-e.deltaY * 0.0015), 0.04, 2.5) })}
        >
          <Stage base={props.base} layout={layout} items={props.items} selected={selected} onRatio={setRatio} />
        </div>
      </div>

      <footer className="arranger-foot">
        {current ? (
          <div className="tools">
            <button className="ghost" onClick={() => change(current.key, { flip: !current.flip })}>
              Flip
            </button>
            <button className="ghost" onClick={() => reorder(true)}>
              To front
            </button>
            <button className="ghost" onClick={() => reorder(false)}>
              To back
            </button>
            <button
              className="ghost danger"
              onClick={() => {
                setLayout((all) => all.filter((p) => p.key !== current.key))
                select(null)
              }}
            >
              Remove
            </button>
          </div>
        ) : (
          <p className="fine tools">Drag to move. Pinch to resize, twist to turn.</p>
        )}
        <div className="strip tray">
          {props.items.map((item) => (
            <button
              key={item.id}
              className={'thumb cut' + (isCutting(item) ? ' cutting' : '')}
              disabled={isCutting(item)}
              aria-label={`Place ${item.name || 'thing'}`}
              onClick={() => add(item)}
            >
              <img src={stickerThumbUrl(item)} alt="" draggable={false} />
            </button>
          ))}
          <label className="thumb addtile">
            <input
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                const files = Array.from(e.target.files ?? [])
                e.target.value = ''
                if (files.length) props.onAddItems(files)
              }}
            />
            <span className="plus">+</span>
            <span>Add</span>
          </label>
        </div>
      </footer>
    </div>
  )
}
