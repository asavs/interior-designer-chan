import { useEffect, useRef, useState } from 'react'
import {
  api,
  fileUrl,
  isCutting,
  stickerThumbUrl,
  stickerUrl,
  thumbUrl,
  toDataUrl,
  type Idea,
  type Img,
  type Placement,
  type Quality,
  type Room,
  type State,
} from './api'
import { Canvas } from './Canvas'
import { composeGuide, cutOut, shrink } from './cutout'

/** What is typed for a room, and which of its photos the thread starts from. */
type Draft = { rootId?: string; prompt: string; quality: Quality; ideas: Idea[] }
type Pending = { key: number; roomId: string; parentId: string }

const blankDraft: Draft = { prompt: '', quality: 'fast', ideas: [] }
const ROOM_NAMES = ['Living room', 'Bedroom', 'Kitchen', 'Dining room', 'Office', 'Hallway', 'Bathroom']
/** How many options one "Make it real" asks for. */
const OPTIONS = 3

const roomPhotos = (room: Room, images: Img[]) =>
  images.filter((i) => i.roomId === room.id && i.kind === 'room').sort((a, b) => a.createdAt - b.createdAt)

// A room is a loom. Each photo of it is the top of a thread; every design hangs under the picture it was made
// from, and any picture in the thread can be branched again.
const parentOf = (design: Img) => design.parentId ?? design.baseId
const optionsUnder = (node: Img, images: Img[]) =>
  images.filter((i) => i.kind === 'render' && parentOf(i) === node.id).sort((a, b) => a.createdAt - b.createdAt)

/** The picture a node's things are placed on: the untouched photo for a design made from stickers. */
const cleanOf = (node: Img, images: Img[]) =>
  (node.kind === 'render' && node.layout?.length ? images.find((i) => i.id === node.baseId) : undefined) ?? node

/** The thread from a room photo down through the chosen option at each level. */
function threadFrom(root: Img, images: Img[], chosen: Record<string, string>) {
  const thread = [root]
  for (let node = root; thread.length < 60;) {
    const options = optionsUnder(node, images)
    const next = options.find((o) => o.id === chosen[node.id]) ?? options[options.length - 1]
    if (!next) break
    thread.push(next)
    node = next
  }
  return thread
}

function useWide() {
  const query = '(min-width: 900px)'
  const [wide, setWide] = useState(() => matchMedia(query).matches)
  useEffect(() => {
    const media = matchMedia(query)
    const onChange = () => setWide(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return wide
}

export default function App() {
  const [state, setState] = useState<State | null>(null)
  const [tab, setTab] = useState<'rooms' | 'things'>('rooms')
  const [roomId, setRoomId] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  /** Arrangements in progress, by the picture they are on. A picture not listed here shows its own. */
  const [work, setWork] = useState<Record<string, Placement[]>>({})
  /** The option followed under each picture. */
  const [chosen, setChosen] = useState<Record<string, string>>({})
  /** The picture the tray and "Make it real" act on, per room. */
  const [focus, setFocus] = useState<Record<string, string>>({})
  const [pending, setPending] = useState<Pending[]>([])
  const [naming, setNaming] = useState<string[]>([])
  const [thinking, setThinking] = useState<string | null>(null)
  const [uploading, setUploading] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [viewingId, setViewingId] = useState<string | null>(null)
  const wide = useWide()
  const nextKey = useRef(0)
  // Pictures with options in the making. A ref, so a second tap is refused before React has re-rendered.
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
  const viewing = images.find((i) => i.id === viewingId)

  const patchDraft = (id: string, patch: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [id]: { ...blankDraft, ...d[id], ...patch } }))

  /** The things on a picture right now: the arrangement in progress, else the one it was made with. */
  const layoutOf = (node: Img) =>
    (work[node.id] ?? (node.kind === 'render' ? (node.layout ?? []) : [])).filter((p) =>
      items.some((i) => i.id === p.itemId),
    )

  const mutate = <T extends { state: State }>(fn: () => Promise<T>) =>
    attempt(async () => {
      const res = await fn()
      setState(res.state)
      return res
    })

  /** Naming happens behind the scenes and never interrupts: if it fails, the app asks, or leaves the name blank. */
  async function guessName(kind: 'room' | 'item', id: string) {
    if (kind === 'room') setNaming((n) => [...n, id])
    try {
      const res = await (kind === 'room' ? api.guessRoomName(id) : api.guessItemName(id))
      setState(res.state)
    } catch {
      // Asking the person is the fallback.
    }
    if (kind === 'room') setNaming((n) => n.filter((x) => x !== id))
  }

  async function upload(kind: 'room' | 'item', files: File[], forRoom?: string) {
    setUploading((n) => n + 1)
    await attempt(async () => {
      for (const file of files) {
        const dataUrl = await toDataUrl(file)
        const cutoutDataUrl = kind === 'item' ? ((await cutOut(dataUrl)) ?? undefined) : undefined
        const res = await api.addImage({ kind, roomId: kind === 'room' ? forRoom : undefined, dataUrl, cutoutDataUrl })
        setState(res.state)
        if (kind === 'item') guessName('item', res.id)
      }
    })
    setUploading((n) => n - 1)
  }

  /** A room begins as a photo. Its name comes from the photo when that is obvious. */
  async function startRoom(files: File[]) {
    const res = await attempt(() => api.addRoom())
    if (!res) return
    setState(res.state)
    setRoomId(res.id)
    setTab('rooms')
    window.scrollTo({ top: 0 })
    await upload('room', files, res.id)
    guessName('room', res.id)
  }

  /** Asks for a few options under one picture. They arrive one by one; the first becomes the thread. */
  async function generate(target: Room, node: Img) {
    const draft = drafts[target.id] ?? blankDraft
    const layout = layoutOf(node)
    const clean = cleanOf(node, images)
    if ((!layout.length && !draft.prompt.trim()) || rendering.current.has(node.id)) return
    rendering.current.add(node.id)

    const keys = Array.from({ length: OPTIONS }, () => nextKey.current++)
    setPending((p) => [...p, ...keys.map((key) => ({ key, roomId: target.id, parentId: node.id }))])
    const sticker = (id: string) => {
      const item = items.find((i) => i.id === id)
      return item && stickerUrl(item)
    }
    const guideDataUrl = layout.length ? await attempt(() => composeGuide(fileUrl(clean), layout, sticker)) : undefined

    const ready = !layout.length || guideDataUrl
    let followed = false
    await Promise.all(
      keys.map(async (key) => {
        if (ready) {
          const res = await mutate(() =>
            api.render({
              roomId: target.id,
              baseId: clean.id,
              parentId: node.id,
              itemIds: [...new Set(layout.map((p) => p.itemId))],
              prompt: draft.prompt,
              quality: draft.quality,
              layout: layout.length ? layout : undefined,
              guideDataUrl: guideDataUrl || undefined,
            }),
          )
          if (res && !followed) {
            followed = true
            setChosen((c) => ({ ...c, [node.id]: res.id }))
          }
        }
        setPending((p) => p.filter((x) => x.key !== key))
      }),
    )
    rendering.current.delete(node.id)
  }

  async function suggest(target: Room, node: Img) {
    setThinking(target.id)
    const itemIds = [...new Set(layoutOf(node).map((p) => p.itemId))]
    const res = await attempt(() => api.ideas({ baseId: cleanOf(node, images).id, itemIds }))
    if (res) patchDraft(target.id, { ideas: res.ideas })
    setThinking(null)
  }

  /** Brings a picture into view as the place to keep working: follows the thread down to it. */
  function continueFrom(img: Img) {
    if (!img.roomId) return
    const follow: Record<string, string> = {}
    let top = img
    while (top.kind === 'render') {
      const parent = images.find((i) => i.id === parentOf(top))
      if (!parent) break
      follow[parent.id] = top.id
      top = parent
    }
    setChosen((c) => ({ ...c, ...follow }))
    if (top.kind === 'room') patchDraft(img.roomId, { rootId: top.id })
    setFocus((f) => ({ ...f, [img.roomId!]: img.id }))
    setRoomId(img.roomId)
    setTab('rooms')
    setViewingId(null)
    requestAnimationFrame(() =>
      document.getElementById(`node-${img.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    )
  }

  async function deleteRoom(target: Room) {
    if (!confirm(`Delete ${target.name ? `"${target.name}"` : 'this room'} with all its photos and designs?`)) return
    await mutate(() => api.deleteRoom(target.id))
    setRoomId(null)
  }

  async function deleteImage(img: Img) {
    const what = img.kind === 'render' ? 'design' : img.kind === 'item' ? 'thing' : 'photo'
    if (!confirm(`Delete this ${what}?`)) return
    setViewingId(null)
    await mutate(() => api.deleteImage(img.id))
  }

  return (
    <div className="app">
      <header className="top">
        <h1>
          Designer<span lang="ja">ちゃん</span>
        </h1>
        {uploading > 0 && <span className="status">Adding photos…</span>}
      </header>

      <main>
        {tab === 'rooms' && !room && (
          <section className="start">
            <span className="kao">(・ω・)ノ</span>
            <h2>Start with a room</h2>
            <p>Add a photo of a room you want to furnish. A listing photo is perfect.</p>
            <AddZone big title="Add a photo of a room" hint="More than one angle is welcome" onFiles={startRoom} />
          </section>
        )}

        {tab === 'rooms' && room && (
          <>
            <nav className="rooms">
              {state.rooms.map((r) => {
                const cover = roomPhotos(r, images)[0]
                return (
                  <button
                    key={r.id}
                    className="roomchip"
                    aria-pressed={r.id === room.id}
                    onClick={() => setRoomId(r.id)}
                  >
                    {cover ? <img src={thumbUrl(cover)} alt="" /> : <span className="blank" />}
                    {r.name || 'New room'}
                  </button>
                )
              })}
              <FileLabel className="roomchip add" onFiles={startRoom}>
                + Room
              </FileLabel>
            </nav>

            <RoomView
              key={room.id}
              room={room}
              images={images}
              items={items}
              draft={drafts[room.id] ?? blankDraft}
              chosen={chosen}
              focusId={focus[room.id]}
              layoutOf={layoutOf}
              isChanged={(node) => node.id in work}
              pending={pending.filter((p) => p.roomId === room.id)}
              naming={naming.includes(room.id)}
              takenNames={state.rooms.map((r) => r.name)}
              thinking={thinking === room.id}
              busy={uploading > 0}
              wide={wide}
              onPatch={(patch) => patchDraft(room.id, patch)}
              onArrange={(node, layout) =>
                setWork((w) => {
                  // An arrangement identical to the one a design was made with is not "in progress".
                  const same = node.kind === 'render' && JSON.stringify(layout) === JSON.stringify(node.layout ?? [])
                  if (!same && layout) return { ...w, [node.id]: layout }
                  const { [node.id]: _, ...rest } = w
                  return rest
                })
              }
              onChoose={(parent, option) => {
                setChosen((c) => ({ ...c, [parent.id]: option.id }))
                setFocus((f) => ({ ...f, [room.id]: option.id }))
              }}
              onFocus={(node) => setFocus((f) => ({ ...f, [room.id]: node.id }))}
              onRename={(name) => mutate(() => api.renameRoom(room.id, name))}
              onDelete={() => deleteRoom(room)}
              onAddPhotos={(files) => upload('room', files, room.id)}
              onAddItems={(files) => upload('item', files)}
              onGenerate={(node) => generate(room, node)}
              onSuggest={(node) => suggest(room, node)}
              onView={setViewingId}
            />
          </>
        )}

        {tab === 'things' && (
          <ThingsView
            items={items}
            onAdd={(files) => upload('item', files)}
            onView={setViewingId}
            onRename={(id, name) => mutate(() => api.updateImage(id, { name }))}
          />
        )}
      </main>

      <nav className="tabs">
        <button aria-pressed={tab === 'rooms'} onClick={() => setTab('rooms')}>
          Rooms
        </button>
        <button aria-pressed={tab === 'things'} onClick={() => setTab('things')}>
          Things{items.length > 0 && <small>{items.length}</small>}
        </button>
      </nav>

      {viewing && (
        <Viewer
          img={viewing}
          images={images}
          onClose={() => setViewingId(null)}
          onUpdate={(patch) => mutate(() => api.updateImage(viewing.id, patch))}
          onDelete={() => deleteImage(viewing)}
          onCutout={(on) => mutate(() => (on ? api.retryCutout(viewing.id) : api.setCutout(viewing.id, null)))}
          onContinue={() => continueFrom(viewing)}
        />
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

function RoomView(props: {
  room: Room
  images: Img[]
  items: Img[]
  draft: Draft
  chosen: Record<string, string>
  focusId?: string
  layoutOf: (node: Img) => Placement[]
  isChanged: (node: Img) => boolean
  pending: Pending[]
  naming: boolean
  takenNames: string[]
  thinking: boolean
  busy: boolean
  wide: boolean
  onPatch: (patch: Partial<Draft>) => void
  onArrange: (node: Img, layout: Placement[] | null) => void
  onChoose: (parent: Img, option: Img) => void
  onFocus: (node: Img) => void
  onRename: (name: string) => void
  onDelete: () => void
  onAddPhotos: (files: File[]) => void
  onAddItems: (files: File[]) => void
  onGenerate: (node: Img) => void
  onSuggest: (node: Img) => void
  onView: (id: string) => void
}) {
  const { room, draft, items, images } = props
  const photos = roomPhotos(room, images)
  const root = photos.find((p) => p.id === draft.rootId) ?? photos[0]
  const thread = root ? threadFrom(root, images, props.chosen) : []
  const focused = thread.find((n) => n.id === props.focusId) ?? thread[thread.length - 1]
  const hasWords = Boolean(draft.prompt.trim())

  function drop(item: Img) {
    const layout = props.layoutOf(focused)
    const nudge = (layout.length % 5) * 0.03
    const key = `${item.id}-${Date.now().toString(36)}`
    props.onArrange(focused, [
      ...layout,
      { key, itemId: item.id, x: 0.5 + nudge, y: 0.56 + nudge, w: 0.3, rot: 0, flip: false },
    ])
  }

  const making = focused ? props.pending.some((p) => p.parentId === focused.id) : false
  const canMake = focused ? props.layoutOf(focused).length > 0 || hasWords : false

  const composer = focused && (
    <div className="composer">
      <h3 className="step">What do you want to put in here?</h3>
      {items.length === 0 ? (
        <AddZone
          title="Add photos of the things"
          hint="A rug, a poster, a table. Product photos and screenshots both work."
          onFiles={props.onAddItems}
        />
      ) : (
        <div className="strip tray">
          {items.map((item) => (
            <button
              key={item.id}
              className={'thumb cut' + (isCutting(item) ? ' cutting' : '')}
              disabled={isCutting(item)}
              aria-label={`Put ${item.name || 'this thing'} in the picture`}
              title={item.name}
              onClick={() => drop(item)}
            >
              <img src={stickerThumbUrl(item)} alt="" />
            </button>
          ))}
          <AddTile label="Add" onFiles={props.onAddItems} />
        </div>
      )}

      <div className="actions go">
        <button className="primary grow" disabled={making || !canMake} onClick={() => props.onGenerate(focused)}>
          {making ? 'Making it real…' : 'Make it real'}
        </button>
      </div>
      {!canMake && items.length > 0 && (
        <p className="fine">Tap a thing to drop it into the picture, then drag it where you want it.</p>
      )}

      <details className="words" open={hasWords || draft.ideas.length > 0 || undefined}>
        <summary>Say something about the look</summary>
        <textarea
          rows={3}
          value={draft.prompt}
          onChange={(e) => props.onPatch({ prompt: e.target.value })}
          placeholder="Optional. e.g. warmer light, keep it minimal, add plants by the window"
        />
        {draft.ideas.length > 0 && (
          <div className="ideas">
            {draft.ideas.map((idea) => (
              <button
                key={idea.title + idea.prompt}
                className="idea"
                aria-pressed={draft.prompt === idea.prompt}
                onClick={() => props.onPatch({ prompt: idea.prompt })}
              >
                <b>{idea.title}</b>
                <span>{idea.prompt}</span>
              </button>
            ))}
          </div>
        )}
        <div className="actions">
          <button className="ghost" disabled={props.thinking} onClick={() => props.onSuggest(focused)}>
            {props.thinking ? 'Thinking…' : 'Suggest ideas'}
          </button>
          <div className="seg" role="group" aria-label="Quality">
            <button aria-pressed={draft.quality === 'fast'} onClick={() => props.onPatch({ quality: 'fast' })}>
              Quick
            </button>
            <button aria-pressed={draft.quality === 'best'} onClick={() => props.onPatch({ quality: 'best' })}>
              Best
            </button>
          </div>
        </div>
      </details>
    </div>
  )

  return (
    <>
      <div className="roomhead">
        <Field
          className="title"
          value={room.name}
          placeholder={props.naming ? 'Looking at your photo…' : 'New room'}
          onSave={props.onRename}
          label="Room name"
        />
        <button className="ghost small" onClick={props.onDelete}>
          Delete room
        </button>
      </div>

      {!root ? (
        !props.busy && <AddZone big title="Add a photo of this room" hint="As it is now" onFiles={props.onAddPhotos} />
      ) : (
        <div className="room-grid">
          <div className="thread">
            {thread.map((node, depth) => {
              const options = optionsUnder(node, images)
              const waiting = props.pending.filter((p) => p.parentId === node.id)
              const next = thread[depth + 1]
              const changed = props.isChanged(node)
              const finished = node.kind === 'render' && !!node.layout?.length && !changed
              const clean = cleanOf(node, images)
              return (
                <section
                  key={node.id}
                  id={`node-${node.id}`}
                  className={'node' + (node.id === focused.id && thread.length > 1 ? ' focused' : '')}
                >
                  <Canvas
                    clean={clean}
                    result={finished && clean !== node ? node : undefined}
                    layout={props.layoutOf(node)}
                    items={items}
                    onChange={(layout) => props.onArrange(node, layout)}
                    onFocus={() => props.onFocus(node)}
                  >
                    {node.kind === 'render' && (
                      <button className="open" aria-label="Open this design" onClick={() => props.onView(node.id)}>
                        ⤢
                      </button>
                    )}
                    {node.kind === 'render' && changed && (
                      <button className="pill" onClick={() => props.onArrange(node, null)}>
                        Back to the result
                      </button>
                    )}
                  </Canvas>

                  {depth === 0 && (
                    <div className="strip views">
                      {photos.map((p) => (
                        <button
                          key={p.id}
                          className="thumb"
                          aria-pressed={p.id === root.id}
                          aria-label={p.id === root.id ? 'Open this photo' : 'Use this view'}
                          onClick={() => (p.id === root.id ? props.onView(p.id) : props.onPatch({ rootId: p.id }))}
                        >
                          <img src={thumbUrl(p)} alt="" />
                        </button>
                      ))}
                      <AddTile label="Another angle" onFiles={props.onAddPhotos} />
                    </div>
                  )}

                  {depth === 0 && !room.name && !props.naming && (
                    <section className="card question">
                      <span className="kao">(・・?)</span>
                      <h3>Which room is this?</h3>
                      <div className="suggest">
                        {ROOM_NAMES.filter((n) => !props.takenNames.includes(n)).map((n) => (
                          <button key={n} className="chip" onClick={() => props.onRename(n)}>
                            {n}
                          </button>
                        ))}
                      </div>
                      <p className="fine">Or type a name above.</p>
                    </section>
                  )}

                  {!props.wide && node.id === focused.id && composer}

                  {(options.length > 0 || waiting.length > 0) && (
                    <>
                      <p className="fine branch">
                        {options.length > 1 ? 'Options. Tap one to carry on from it.' : 'Carries on below.'}
                      </p>
                      <div className="strip options">
                        {options.map((o) => (
                          <button
                            key={o.id}
                            className="thumb"
                            aria-pressed={o.id === next?.id}
                            aria-label="Carry on from this option"
                            onClick={() => props.onChoose(node, o)}
                          >
                            <img src={thumbUrl(o)} alt="" />
                            {o.favorite && <span className="heart">♥</span>}
                          </button>
                        ))}
                        {waiting.map((p) => (
                          <div key={p.key} className="thumb pending">
                            <span className="kao">(๑•̀ㅂ•́)و</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </section>
              )
            })}
          </div>
          {props.wide && <div className="room-side">{composer}</div>}
        </div>
      )}
    </>
  )
}

function ThingsView(props: {
  items: Img[]
  onAdd: (files: File[]) => void
  onView: (id: string) => void
  onRename: (id: string, name: string) => void
}) {
  return (
    <>
      <div className="roomhead">
        <h2 className="title">Things</h2>
      </div>
      {props.items.length === 0 ? (
        <AddZone
          big
          title="Add photos of things you like"
          hint="Furniture, rugs, art, lamps. They can go in any room."
          onFiles={props.onAdd}
        />
      ) : (
        <div className="grid things">
          {props.items.map((item) => (
            <div key={item.id} className="thing">
              <button
                className={'tile cut' + (isCutting(item) ? ' cutting' : '')}
                onClick={() => props.onView(item.id)}
              >
                <img src={stickerThumbUrl(item)} alt={item.name || 'Thing'} />
              </button>
              <Field
                value={item.name}
                placeholder="Name it"
                label="Name"
                onSave={(name) => props.onRename(item.id, name)}
                allowEmpty
              />
            </div>
          ))}
          <AddTile className="tile" label="Add things" onFiles={props.onAdd} />
        </div>
      )}
    </>
  )
}

function Viewer(props: {
  img: Img
  images: Img[]
  onClose: () => void
  onUpdate: (patch: { name?: string; note?: string; favorite?: boolean }) => void
  onDelete: () => void
  onContinue: () => void
  onCutout: (on: boolean) => void
}) {
  const { img } = props
  const [before, setBefore] = useState(false)
  const base = img.kind === 'render' ? props.images.find((i) => i.id === img.baseId) : undefined
  const used = (img.itemIds ?? []).map((id) => props.images.find((i) => i.id === id)).filter((i) => !!i)
  const shown = before && base ? base : img

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose()
    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  })

  return (
    <div className="viewer" role="dialog" aria-modal="true">
      {/* Housekeeping stays small and out of the way, like a photo app's top bar. */}
      <div className="viewer-bar">
        <button className="bar-btn close" aria-label="Close" onClick={props.onClose}>
          ✕
        </button>
        <span className="grow" />
        {img.kind === 'render' && (
          <button
            className="bar-btn"
            aria-pressed={!!img.favorite}
            aria-label={img.favorite ? 'Remove from favourites' : 'Add to favourites'}
            onClick={() => props.onUpdate({ favorite: !img.favorite })}
          >
            {img.favorite ? '♥' : '♡'}
          </button>
        )}
        <a className="bar-btn" href={fileUrl(img)} download={`designer-chan-${img.file}`}>
          Save
        </a>
        <button className="bar-btn" onClick={props.onDelete}>
          Delete
        </button>
      </div>

      <div className="stage" onClick={props.onClose}>
        <img
          className={img.kind === 'item' && img.cutout ? 'cutout' : isCutting(img) ? 'cutting' : undefined}
          src={img.kind === 'item' ? stickerUrl(img) : fileUrl(shown)}
          alt=""
          onClick={(e) => e.stopPropagation()}
        />
        {base && (
          <div className="seg compare" role="group" aria-label="Compare" onClick={(e) => e.stopPropagation()}>
            <button aria-pressed={before} onClick={() => setBefore(true)}>
              Before
            </button>
            <button aria-pressed={!before} onClick={() => setBefore(false)}>
              After
            </button>
          </div>
        )}
      </div>

      <div className="panel">
        {img.kind === 'render' && (
          <>
            {(img.prompt || used.length > 0) && (
              <div className="recipe">
                {used.map((u) => (
                  <span key={u.id} className="thumb small cut" title={u.name}>
                    <img src={stickerThumbUrl(u)} alt={u.name} />
                  </span>
                ))}
                {img.prompt && <p className="said">“{img.prompt}”</p>}
              </div>
            )}
            <button className="next main" onClick={props.onContinue}>
              <b>Carry on from this</b>
              <span>Show it in the room, where everything in it can still be moved</span>
            </button>
          </>
        )}

        {img.kind === 'room' && (
          <button className="next main" onClick={props.onContinue}>
            <b>Design from this view</b>
            <span>Use this photo of the room as the starting picture</span>
          </button>
        )}

        {img.kind === 'item' && (
          <>
            <div className="fields">
              <Field
                value={img.name}
                placeholder="Name"
                label="Name"
                onSave={(name) => props.onUpdate({ name })}
                allowEmpty
              />
              <Field
                value={img.note}
                placeholder="Size, price, link…"
                label="Notes"
                onSave={(note) => props.onUpdate({ note })}
                allowEmpty
              />
            </div>
            <button className="next" disabled={isCutting(img)} onClick={() => props.onCutout(!img.cutout)}>
              <b>{isCutting(img) ? 'Cutting it out…' : img.cutout ? 'Use the whole photo' : 'Cut it out again'}</b>
              <span>
                {isCutting(img)
                  ? 'Lifting the thing off its background'
                  : img.cutout
                    ? 'Bring the background back if the cut-out looks wrong'
                    : 'Try again to lift the thing off its background'}
              </span>
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/** Anything wrapped in this opens the photo picker when tapped. */
function FileLabel(props: { className?: string; onFiles: (files: File[]) => void; children: React.ReactNode }) {
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
      <input
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
      {props.children}
    </label>
  )
}

function AddZone(props: { title: string; hint?: string; big?: boolean; onFiles: (files: File[]) => void }) {
  return (
    <FileLabel className={'addzone' + (props.big ? ' big' : '')} onFiles={props.onFiles}>
      <span className="plus">+</span>
      <b>{props.title}</b>
      {props.hint && <span>{props.hint}</span>}
    </FileLabel>
  )
}

function AddTile(props: { label: string; className?: string; onFiles: (files: File[]) => void }) {
  return (
    <FileLabel className={`thumb addtile ${props.className ?? ''}`} onFiles={props.onFiles}>
      <span className="plus">+</span>
      <span>{props.label}</span>
    </FileLabel>
  )
}

function Field(props: {
  value: string
  label: string
  placeholder?: string
  className?: string
  allowEmpty?: boolean
  onSave: (value: string) => void
}) {
  const [value, setValue] = useState(props.value)
  useEffect(() => setValue(props.value), [props.value])
  return (
    <input
      className={`field ${props.className ?? ''}`}
      value={value}
      aria-label={props.label}
      placeholder={props.placeholder}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      onBlur={() => {
        const next = value.trim()
        if (next === props.value) return
        if (!next && !props.allowEmpty) return setValue(props.value)
        props.onSave(next)
      }}
    />
  )
}
