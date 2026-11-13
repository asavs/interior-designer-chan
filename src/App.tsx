import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  CarouselViewport,
  createCarouselController,
} from '@ui-sdk/react/carousel'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@ui-sdk/react/menu'
import {
  api,
  fileUrl,
  isCutting,
  stickerThumbUrl,
  stickerUrl,
  thumbUrl,
  toDataUrl,
  type Img,
  type Placement,
  type Room,
  type State,
} from './api'
import { Canvas } from './Canvas'
import { composeGuide, cutOut, shrink } from './cutout'

type Pending = { key: number; parentId: string }

// A room is a loom. Its photo is the top of a thread; every design hangs under the picture it was made from,
// and any picture in the thread can be branched again.
const parentOf = (design: Img) => design.parentId ?? design.baseId
const designsUnder = (node: Img, images: Img[]) =>
  images.filter((i) => i.kind === 'render' && parentOf(i) === node.id).sort((a, b) => a.createdAt - b.createdAt)

/** The photo a room's thread starts from. */
const topOf = (room: Room, images: Img[]) =>
  images.filter((i) => i.roomId === room.id && i.kind === 'room').sort((a, b) => a.createdAt - b.createdAt)[0] as
    Img | undefined

/** The picture a node's things are placed on: the untouched photo for a design made from stickers. */
const cleanOf = (node: Img, images: Img[]) =>
  (node.kind === 'render' && node.layout?.length ? images.find((i) => i.id === node.baseId) : undefined) ?? node

/** The thread from a room photo down through the followed design at each level. */
function threadFrom(top: Img, images: Img[], chosen: Record<string, string>) {
  const thread = [top]
  for (let node = top; thread.length < 60;) {
    const designs = designsUnder(node, images)
    const next = designs.find((d) => d.id === chosen[node.id]) ?? designs[designs.length - 1]
    if (!next) break
    thread.push(next)
    node = next
  }
  return thread
}

export default function App() {
  const [state, setState] = useState<State | null>(null)
  const [roomId, setRoomId] = useState<string | null>(null)
  /** Arrangements in progress, by the picture they are on. A picture not listed here shows its own. */
  const [work, setWork] = useState<Record<string, Placement[]>>({})
  /** The design followed under each picture. */
  const [chosen, setChosen] = useState<Record<string, string>>({})
  /** The picture last arranged, which "Make it real" acts on. */
  const [touched, setTouched] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending[]>([])
  const [uploading, setUploading] = useState(0)
  const [renaming, setRenaming] = useState(false)
  const [shelf, setShelf] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const addRoom = useRef<HTMLInputElement>(null)
  const nextKey = useRef(0)
  // Pictures with a design in the making. A ref, so a second tap is refused before React has re-rendered.
  const rendering = useRef(new Set<string>())

  async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return undefined
    }
  }

  useEffect(() => {
    attempt(async () => setState(await api.state()))
  }, [])

  // Every stored picture gets a small copy for tiles. This covers uploads, new designs and changed cut-outs alike.
  const thumbed = useRef(new Set<string>())
  useEffect(() => {
    for (const img of state?.images ?? []) {
      const needsCutout = !!img.cutout && !img.cutoutThumb
      const key = `${img.file}:${img.cutout ?? ''}`
      if ((img.thumb && !needsCutout) || thumbed.current.has(key)) continue
      thumbed.current.add(key)
      ;(async () => {
        try {
          const dataUrl = img.thumb ? undefined : await shrink(fileUrl(img), 480, 'image/jpeg')
          const cutoutDataUrl = needsCutout ? await shrink(stickerUrl(img), 360, 'image/png') : undefined
          setState((await api.setThumb(img.id, { dataUrl, cutoutDataUrl })).state)
        } catch {
          // The full-size picture is shown instead.
        }
      })()
    }
  }, [state])

  // Every thing becomes a cut-out. A plain backdrop is removed on the spot; a busy photo goes to the image
  // model to be isolated first. If neither works, the whole photo is the sticker.
  const cutting = useRef(new Set<string>())
  useEffect(() => {
    for (const img of state?.images ?? []) {
      const key = `${img.id}:${img.cutoutAttempt ?? 0}`
      if (!isCutting(img) || cutting.current.has(key)) continue
      cutting.current.add(key)
      ;(async () => {
        let dataUrl: string | null = null
        try {
          dataUrl = await cutOut(fileUrl(img))
          if (!dataUrl) dataUrl = await cutOut((await api.isolate(img.id)).dataUrl, { shave: 2, despill: true })
        } catch {
          // Falls through to the whole photo.
        }
        try {
          setState((await api.setCutout(img.id, dataUrl)).state)
        } catch {
          cutting.current.delete(key)
        }
      })()
    }
  }, [state])

  useEffect(() => {
    if (!error) return
    const timer = setTimeout(() => setError(null), 9000)
    return () => clearTimeout(timer)
  }, [error])

  if (!state) {
    return (
      <div className="splash">
        {error ? (
          <>
            <p>{error}</p>
            <button className="primary" onClick={() => location.reload()}>
              Try again
            </button>
          </>
        ) : (
          <p>
            <span className="kao">(｡･ω･｡)</span>
            Opening the studio…
          </p>
        )}
      </div>
    )
  }

  const images = state.images
  const room = state.rooms.find((r) => r.id === roomId) ?? state.rooms[0]
  const items = images.filter((i) => i.kind === 'item').sort((a, b) => b.createdAt - a.createdAt)
  /** Rooms that have a photo, each shown by it. */
  const tops = state.rooms.flatMap((r) => {
    const top = topOf(r, images)
    return top ? [{ room: r, top }] : []
  })
  const top = room && topOf(room, images)
  const thread = top ? threadFrom(top, images, chosen) : []

  /** The things on a picture right now: the arrangement in progress, else the one it was made with. */
  const layoutOf = (node: Img) =>
    (work[node.id] ?? (node.kind === 'render' ? (node.layout ?? []) : [])).filter((p) =>
      items.some((i) => i.id === p.itemId),
    )
  /** A picture with something to make: a photo with things on it, or a design whose things have moved. */
  const makeable = (node: Img) => layoutOf(node).length > 0 && (node.kind === 'room' || node.id in work)
  const target = thread.find((n) => n.id === touched && makeable(n)) ?? [...thread].reverse().find(makeable)
  const making = target ? pending.some((p) => p.parentId === target.id) : false

  const mutate = <T extends { state: State }>(fn: () => Promise<T>) =>
    attempt(async () => {
      const res = await fn()
      setState(res.state)
      return res
    })

  function arrange(node: Img, layout: Placement[] | null) {
    setWork((w) => {
      // An arrangement identical to the one a design was made with is not "in progress".
      const same = node.kind === 'render' && JSON.stringify(layout) === JSON.stringify(node.layout ?? [])
      if (layout && !same) return { ...w, [node.id]: layout }
      const { [node.id]: _, ...rest } = w
      return rest
    })
    if (layout) setTouched(node.id)
  }

  /** Puts a thing on the picture in the thread that is nearest the middle of the screen. */
  function drop(item: Img) {
    const middle = innerHeight / 2
    const distance = (node: Img) => {
      const box = document.getElementById(`node-${node.id}`)?.getBoundingClientRect()
      return box ? Math.abs((box.top + box.bottom) / 2 - middle) : Infinity
    }
    const node = [...thread].sort((a, b) => distance(a) - distance(b))[0]
    if (!node) return
    const layout = layoutOf(node)
    const nudge = (layout.length % 5) * 0.03
    const key = `${item.id}-${Date.now().toString(36)}`
    arrange(node, [...layout, { key, itemId: item.id, x: 0.5 + nudge, y: 0.56 + nudge, w: 0.3, rot: 0, flip: false }])
    setShelf(false)
  }

  /** Names come from the photo, behind the scenes. A failure just leaves the name blank. */
  const guessName = (kind: 'room' | 'item', id: string) =>
    (kind === 'room' ? api.guessRoomName(id) : api.guessItemName(id)).then(
      (res) => setState(res.state),
      () => {},
    )

  async function upload(kind: 'room' | 'item', files: File[], forRoom?: string) {
    setUploading((n) => n + 1)
    await attempt(async () => {
      for (const file of files) {
        const dataUrl = await toDataUrl(file)
        const cutoutDataUrl = kind === 'item' ? ((await cutOut(dataUrl)) ?? undefined) : undefined
        const res = await api.addImage({ kind, roomId: forRoom, dataUrl, cutoutDataUrl })
        setState(res.state)
        if (kind === 'item') guessName('item', res.id)
      }
    })
    setUploading((n) => n - 1)
  }

  /** Every photo starts a room of its own. */
  async function startRooms(files: File[]) {
    for (const file of files) {
      const res = await attempt(() => api.addRoom())
      if (!res) return
      setState(res.state)
      setRoomId(res.id)
      window.scrollTo({ top: 0 })
      await upload('room', [file], res.id)
      guessName('room', res.id)
    }
  }

  /** Makes one design under a picture and follows it. Pressing again hangs another beside it. */
  async function generate(node: Img) {
    const layout = layoutOf(node)
    const clean = cleanOf(node, images)
    if (!room || !layout.length || rendering.current.has(node.id)) return
    rendering.current.add(node.id)

    const key = nextKey.current++
    setPending((p) => [...p, { key, parentId: node.id }])
    const res = await mutate(async () => {
      const sticker = (id: string) => {
        const item = items.find((i) => i.id === id)
        return item && stickerUrl(item)
      }
      return api.render({
        roomId: room.id,
        baseId: clean.id,
        parentId: node.id,
        itemIds: [...new Set(layout.map((p) => p.itemId))],
        layout,
        guideDataUrl: await composeGuide(fileUrl(clean), layout, sticker),
      })
    })
    if (res) setChosen((c) => ({ ...c, [node.id]: res.id }))
    setPending((p) => p.filter((x) => x.key !== key))
    rendering.current.delete(node.id)
  }

  /** Hands the picture to the phone's share sheet, where "Save Image" lives, or downloads it. */
  async function save(img: Img) {
    const name = `designer-chan-${img.file}`
    try {
      const blob = await (await fetch(fileUrl(img))).blob()
      const file = new File([blob], name, { type: blob.type })
      if (navigator.canShare?.({ files: [file] })) return await navigator.share({ files: [file] })
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return
    }
    const link = document.createElement('a')
    link.href = fileUrl(img)
    link.download = name
    link.click()
  }

  async function deleteRoom(target: Room) {
    if (!confirm(`Delete ${target.name ? `"${target.name}"` : 'this room'} with all its designs?`)) return
    await mutate(() => api.deleteRoom(target.id))
    setRoomId(null)
  }

  async function deleteImage(img: Img) {
    if (!confirm(`Delete this ${img.kind === 'item' ? 'thing' : 'design'}?`)) return
    await mutate(() => api.deleteImage(img.id))
  }

  const picture = (node: Img) => {
    const changed = node.id in work
    const clean = cleanOf(node, images)
    const finished = node.kind === 'render' && !!node.layout?.length && !changed && clean !== node
    return (
      <div id={`node-${node.id}`} className="node">
        <Canvas
          clean={clean}
          result={finished ? node : undefined}
          layout={layoutOf(node)}
          items={items}
          onChange={(layout) => arrange(node, layout)}
        >
          {node.kind === 'render' && node.favorite && <span className="heart">♥</span>}
          {node.kind === 'render' && (
            <Menu>
              <MenuTrigger className="more" aria-label="More for this design" data-carousel-no-drag="">
                …
              </MenuTrigger>
              <MenuContent className="menu" align="end">
                <MenuItem onSelect={() => save(node)}>Save picture</MenuItem>
                <MenuItem onSelect={() => mutate(() => api.updateImage(node.id, { favorite: !node.favorite }))}>
                  {node.favorite ? 'Remove from favourites' : 'Favourite'}
                </MenuItem>
                <MenuItem destructive onSelect={() => deleteImage(node)}>
                  Delete
                </MenuItem>
              </MenuContent>
            </Menu>
          )}
          {node.kind === 'render' && changed && (
            <button className="pill" onClick={() => arrange(node, null)}>
              Back to the result
            </button>
          )}
        </Canvas>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="top">
        <h1>
          Designer<span lang="ja">ちゃん</span>
        </h1>
        {uploading > 0 && <span className="status">Adding…</span>}
      </header>

      <FileInput ref={addRoom} onFiles={startRooms} />

      <main>
        {!room && (
          <section className="start">
            <span className="kao">(・ω・)ノ</span>
            <h2>Start with a room</h2>
            <p>Add a photo of a room you want to furnish. A listing photo is perfect.</p>
            <AddZone title="Add a photo of a room" hint="Each photo becomes a room" onFiles={startRooms} />
          </section>
        )}

        {room && (
          <>
            <div className="roomhead">
              {renaming ? (
                <Field
                  className="title"
                  value={room.name}
                  placeholder="Name this room"
                  label="Room name"
                  autoFocus
                  onSave={(name) => mutate(() => api.renameRoom(room.id, name))}
                  onDone={() => setRenaming(false)}
                />
              ) : (
                <Menu>
                  <MenuTrigger className="title roomname">
                    {room.name || 'New room'}
                    <span aria-hidden> ▾</span>
                  </MenuTrigger>
                  <MenuContent className="menu" align="start">
                    {state.rooms.map((r) => {
                      const cover = topOf(r, images)
                      return (
                        <MenuItem key={r.id} className="menu-room" onSelect={() => setRoomId(r.id)}>
                          {cover ? <img src={thumbUrl(cover)} alt="" /> : <span className="blank" />}
                          {r.name || 'New room'}
                          {r.id === room.id && <span className="tick">✓</span>}
                        </MenuItem>
                      )
                    })}
                    <MenuSeparator className="menu-rule" />
                    <MenuItem onSelect={() => addRoom.current?.click()}>Add a room</MenuItem>
                    <MenuItem onSelect={() => setRenaming(true)}>Rename</MenuItem>
                    <MenuItem destructive onSelect={() => deleteRoom(room)}>
                      Delete this room
                    </MenuItem>
                  </MenuContent>
                </Menu>
              )}
            </div>

            {!top ? (
              uploading === 0 && (
                <AddZone
                  title="Add a photo of this room"
                  hint="As it is now"
                  onFiles={(f) => upload('room', f, room.id)}
                />
              )
            ) : (
              <div className="thread">
                {thread.map((node, depth) => {
                  const parent: Img | undefined = thread[depth - 1]
                  const designs = parent ? designsUnder(parent, images) : []
                  return (
                    <section key={parent ? `under-${parent.id}` : 'rooms'} className="level">
                      {parent ? (
                        <Side
                          label="Designs"
                          index={designs.indexOf(node)}
                          count={designs.length}
                          making={pending.some((p) => p.parentId === parent.id)}
                          onIndex={(i) => designs[i] && setChosen((c) => ({ ...c, [parent.id]: designs[i].id }))}
                        >
                          {designs.map((d) => (
                            <CarouselItem key={d.id} className="slide">
                              {picture(d)}
                            </CarouselItem>
                          ))}
                        </Side>
                      ) : (
                        <Side
                          label="Rooms"
                          index={tops.findIndex((t) => t.room.id === room.id)}
                          count={tops.length}
                          onIndex={(i) => tops[i] && setRoomId(tops[i].room.id)}
                        >
                          {tops.map((t) => (
                            <CarouselItem key={t.room.id} className="slide">
                              {picture(t.top)}
                            </CarouselItem>
                          ))}
                        </Side>
                      )}

                      {depth === thread.length - 1 && pending.some((p) => p.parentId === node.id) && (
                        <div className="node-pic pending making">
                          <span>
                            <span className="kao">(๑•̀ㅂ•́)و</span>
                            Making it real…
                          </span>
                        </div>
                      )}
                    </section>
                  )
                })}
              </div>
            )}
          </>
        )}
      </main>

      {shelf && (
        <section className="shelf" aria-label="All your things">
          <div className="shelf-head">
            <h2>Things</h2>
            <button className="ghost small" onClick={() => setShelf(false)}>
              Close
            </button>
          </div>
          <div className="shelf-grid">
            {items.map((item) => (
              <div key={item.id} className="thing">
                <button
                  className={'tile cut' + (isCutting(item) ? ' cutting' : '')}
                  disabled={isCutting(item) || !top}
                  aria-label={`Put ${item.name || 'this thing'} in the picture`}
                  onClick={() => drop(item)}
                >
                  <img src={stickerThumbUrl(item)} alt="" />
                </button>
                <div className="thing-row">
                  <Field
                    value={item.name}
                    placeholder="Name it"
                    label="Name"
                    allowEmpty
                    onSave={(name) => mutate(() => api.updateImage(item.id, { name }))}
                  />
                  <Menu>
                    <MenuTrigger className="ghost small" aria-label={`More for ${item.name || 'this thing'}`}>
                      …
                    </MenuTrigger>
                    <MenuContent className="menu" align="end">
                      <MenuItem
                        disabled={isCutting(item)}
                        onSelect={() =>
                          mutate(() => (item.cutout ? api.setCutout(item.id, null) : api.retryCutout(item.id)))
                        }
                      >
                        {item.cutout ? 'Use the whole photo' : 'Cut it out again'}
                      </MenuItem>
                      <MenuItem destructive onSelect={() => deleteImage(item)}>
                        Delete
                      </MenuItem>
                    </MenuContent>
                  </Menu>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {room && (
        <footer className="dock">
          {items.length > 0 && (
            <button
              className="ghost shelf-toggle"
              aria-expanded={shelf}
              aria-label="All your things"
              onClick={() => setShelf((on) => !on)}
            >
              {shelf ? '▾' : '▴'}
            </button>
          )}
          <div className="strip dock-things">
            {items.map((item) => (
              <button
                key={item.id}
                className={'thumb cut' + (isCutting(item) ? ' cutting' : '')}
                disabled={isCutting(item) || !top}
                aria-label={`Put ${item.name || 'this thing'} in the picture`}
                title={item.name}
                onClick={() => drop(item)}
              >
                <img src={stickerThumbUrl(item)} alt="" />
              </button>
            ))}
            <FileLabel className="thumb addtile" onFiles={(f) => upload('item', f)}>
              <span className="plus">+</span>
              <span>{items.length ? 'Add' : 'Add things'}</span>
            </FileLabel>
          </div>
          {target && (
            <button className="primary make" disabled={making} onClick={() => generate(target)}>
              {making ? 'Making…' : 'Make it real'}
            </button>
          )}
        </footer>
      )}

      {error && (
        <button className="toast" role="alert" onClick={() => setError(null)}>
          <span className="bubble">
            <span className="kao">(´・ω・｀)</span>
            {error}
          </span>
        </button>
      )}
    </div>
  )
}

/**
 * Pictures side by side: the designs made under one picture, or the rooms themselves. A sideways swipe, the
 * dots, a mouse drag or the arrow keys move between them, and the one in view is the one the page carries on
 * from.
 */
function Side(props: {
  label: 'Designs' | 'Rooms'
  index: number
  count: number
  making?: boolean
  onIndex: (index: number) => void
  children: ReactNode
}) {
  const controller = useMemo(() => createCarouselController(), [])
  const page = props.index + 1

  // Keep the carousel on the followed picture: when it opens, when a new design arrives, and when a dot or
  // the room menu picks one. It waits until the slides are measured, since a page set before that is dropped.
  useEffect(() => {
    let frame = 0
    let tries = 0
    const sync = () => {
      if ((controller.getPageCount() ?? 0) < page && tries++ < 120) frame = requestAnimationFrame(sync)
      else if (controller.getPage() !== page) controller.setPage(page)
    }
    frame = requestAnimationFrame(sync)
    return () => cancelAnimationFrame(frame)
  }, [page, props.count])

  // The carousel is as tall as the picture in view, not as tall as its tallest slide.
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const view = root.current?.querySelector<HTMLElement>('.side-view')
    const slides = [...(root.current?.querySelectorAll<HTMLElement>('.slide') ?? [])]
    if (!view || !slides[props.index]) return
    const fit = () => (view.style.height = `${slides[props.index].offsetHeight}px`)
    const observer = new ResizeObserver(fit)
    slides.forEach((slide) => observer.observe(slide))
    fit()
    return () => observer.disconnect()
  }, [props.index, props.count])

  const several = props.count > 1
  return (
    <Carousel
      ref={root}
      className="side"
      aria-label={props.label}
      controller={controller}
      defaultPage={page}
      onPageChange={(next) => next - 1 !== props.index && props.onIndex(next - 1)}
    >
      <CarouselViewport className="side-view">
        <CarouselContent className="side-row">{props.children}</CarouselContent>
      </CarouselViewport>
      {several && (
        <>
          <CarouselPrevious className="arrow prev" aria-label="Previous">
            ‹
          </CarouselPrevious>
          <CarouselNext className="arrow next" aria-label="Next">
            ›
          </CarouselNext>
        </>
      )}
      {(several || props.making) && (
        <div className="dots">
          {Array.from({ length: props.count }, (_, i) => (
            <button
              key={i}
              aria-label={`${props.label} ${i + 1} of ${props.count}`}
              aria-current={i === props.index || undefined}
              onClick={() => props.onIndex(i)}
            />
          ))}
          {props.making && <span className="dot-making" aria-label="Making another" />}
        </div>
      )}
    </Carousel>
  )
}

/** A hidden photo picker that something else opens, such as a menu item. */
function FileInput(props: { ref: React.Ref<HTMLInputElement>; onFiles: (files: File[]) => void }) {
  return (
    <input
      ref={props.ref}
      type="file"
      accept="image/*"
      multiple
      hidden
      onChange={(e) => {
        const files = Array.from(e.target.files ?? [])
        e.target.value = ''
        if (files.length) props.onFiles(files)
      }}
    />
  )
}

/** Anything wrapped in this opens the photo picker when tapped, and takes photos dropped onto it. */
function FileLabel(props: { className?: string; onFiles: (files: File[]) => void; children: ReactNode }) {
  const [over, setOver] = useState(false)
  return (
    <label
      className={(props.className ?? '') + (over ? ' dropping' : '')}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'))
        if (files.length) props.onFiles(files)
      }}
    >
      <FileInput ref={null} onFiles={props.onFiles} />
      {props.children}
    </label>
  )
}

function AddZone(props: { title: string; hint?: string; onFiles: (files: File[]) => void }) {
  return (
    <FileLabel className="addzone" onFiles={props.onFiles}>
      <span className="plus">+</span>
      <b>{props.title}</b>
      {props.hint && <span>{props.hint}</span>}
    </FileLabel>
  )
}

function Field(props: {
  value: string
  label: string
  placeholder?: string
  className?: string
  allowEmpty?: boolean
  autoFocus?: boolean
  onSave: (value: string) => void
  onDone?: () => void
}) {
  const [value, setValue] = useState(props.value)
  useEffect(() => setValue(props.value), [props.value])
  return (
    <input
      className={`field ${props.className ?? ''}`}
      value={value}
      aria-label={props.label}
      placeholder={props.placeholder}
      autoFocus={props.autoFocus}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      onBlur={() => {
        const next = value.trim()
        if (next !== props.value && (next || props.allowEmpty)) props.onSave(next)
        else setValue(props.value)
        props.onDone?.()
      }}
    />
  )
}
