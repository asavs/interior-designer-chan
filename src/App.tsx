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
import { Arranger, Stage } from './Arranger'
import { composeGuide, cutOut, shrink } from './cutout'

type Draft = {
  baseId?: string
  /** The finished design this arrangement came from. Shown in place of the rough stickers until something moves. */
  shownId?: string
  itemIds: string[]
  layout: Placement[]
  prompt: string
  quality: Quality
  ideas: Idea[]
}
type Pending = { key: number; roomId: string; prompt: string }

const blankDraft: Draft = { itemIds: [], layout: [], prompt: '', quality: 'fast', ideas: [] }
const ROOM_NAMES = ['Living room', 'Bedroom', 'Kitchen', 'Dining room', 'Office', 'Hallway', 'Bathroom']

const roomPhotos = (room: Room, images: Img[]) =>
  images.filter((i) => i.roomId === room.id && i.kind === 'room').sort((a, b) => a.createdAt - b.createdAt)

/** The image the next design starts from: the one picked, else the room's first photo. */
function baseOf(room: Room, images: Img[], draft?: Draft) {
  return images.find((i) => i.roomId === room.id && i.id === draft?.baseId) ?? roomPhotos(room, images)[0]
}

export default function App() {
  const [state, setState] = useState<State | null>(null)
  const [tab, setTab] = useState<'rooms' | 'things'>('rooms')
  const [roomId, setRoomId] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [pending, setPending] = useState<Pending[]>([])
  const [naming, setNaming] = useState<string[]>([])
  const [thinking, setThinking] = useState<string | null>(null)
  const [uploading, setUploading] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [viewingId, setViewingId] = useState<string | null>(null)
  const [arranging, setArranging] = useState(false)
  const nextKey = useRef(0)
  // Rooms with a design in the making. A ref, so a second tap is refused before React has re-rendered.
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

  const room = state.rooms.find((r) => r.id === roomId) ?? state.rooms[0]
  const items = state.images.filter((i) => i.kind === 'item').sort((a, b) => b.createdAt - a.createdAt)
  const viewing = state.images.find((i) => i.id === viewingId)

  const patchDraft = (id: string, patch: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [id]: { ...blankDraft, ...d[id], ...patch } }))

  /** Ticking a thing off also lifts its stickers from the picture. */
  const toggleItem = (id: string, itemId: string) =>
    setDrafts((d) => {
      const draft = { ...blankDraft, ...d[id] }
      const on = draft.itemIds.includes(itemId) || draft.layout.some((p) => p.itemId === itemId)
      const itemIds = on ? draft.itemIds.filter((x) => x !== itemId) : [...draft.itemIds, itemId]
      const layout = on ? draft.layout.filter((p) => p.itemId !== itemId) : draft.layout
      return { ...d, [id]: { ...draft, itemIds, layout, shownId: undefined } }
    })

  const mutate = (fn: () => Promise<{ state: State }>) =>
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

  async function upload(kind: 'room' | 'item', files: File[], forRoom?: string, tick = true) {
    setUploading((n) => n + 1)
    await attempt(async () => {
      for (const file of files) {
        const dataUrl = await toDataUrl(file)
        const cutoutDataUrl = kind === 'item' ? ((await cutOut(dataUrl)) ?? undefined) : undefined
        const res = await api.addImage({ kind, roomId: kind === 'room' ? forRoom : undefined, dataUrl, cutoutDataUrl })
        setState(res.state)
        if (kind === 'item') {
          if (forRoom && tick) toggleItem(forRoom, res.id)
          guessName('item', res.id)
        }
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

  async function generate(target: Room, baseId: string, layout: Placement[]) {
    const draft = drafts[target.id] ?? blankDraft
    const base = state!.images.find((i) => i.id === baseId)
    if (!base || rendering.current.has(target.id)) return
    rendering.current.add(target.id)
    const placed = layout.filter((p) => items.some((i) => i.id === p.itemId))
    const itemIds = [...new Set([...draft.itemIds, ...placed.map((p) => p.itemId)])].filter((id) =>
      items.some((i) => i.id === id),
    )
    const key = nextKey.current++
    setPending((p) => [{ key, roomId: target.id, prompt: draft.prompt }, ...p])
    await mutate(async () => {
      const sticker = (id: string) => {
        const item = items.find((i) => i.id === id)
        return item && stickerUrl(item)
      }
      const guideDataUrl = placed.length ? await composeGuide(fileUrl(base), placed, sticker) : undefined
      return api.render({
        roomId: target.id,
        baseId,
        itemIds,
        prompt: draft.prompt,
        quality: draft.quality,
        layout: placed.length ? placed : undefined,
        guideDataUrl,
      })
    })
    rendering.current.delete(target.id)
    setPending((p) => p.filter((x) => x.key !== key))
  }

  async function suggest(target: Room, baseId: string) {
    const draft = drafts[target.id] ?? blankDraft
    setThinking(target.id)
    const itemIds = [...new Set([...draft.itemIds, ...draft.layout.map((p) => p.itemId)])]
    const res = await attempt(() => api.ideas({ baseId, itemIds }))
    if (res) patchDraft(target.id, { ideas: res.ideas })
    setThinking(null)
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
                const cover = roomPhotos(r, state.images)[0]
                return (
                  <button key={r.id} className="roomchip" aria-pressed={r.id === room.id} onClick={() => setRoomId(r.id)}>
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
              images={state.images}
              items={items}
              draft={drafts[room.id] ?? blankDraft}
              pending={pending.filter((p) => p.roomId === room.id)}
              naming={naming.includes(room.id)}
              takenNames={state.rooms.map((r) => r.name)}
              thinking={thinking === room.id}
              busy={uploading > 0}
              onPatch={(patch) => patchDraft(room.id, patch)}
              onToggleItem={(id) => toggleItem(room.id, id)}
              onRename={(name) => mutate(() => api.renameRoom(room.id, name))}
              onDelete={() => deleteRoom(room)}
              onAddPhotos={(files) => upload('room', files, room.id)}
              onAddItems={(files) => upload('item', files, room.id)}
              onGenerate={(baseId) => generate(room, baseId, (drafts[room.id] ?? blankDraft).layout)}
              onArrange={() => setArranging(true)}
              onSuggest={(baseId) => suggest(room, baseId)}
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
          images={state.images}
          onClose={() => setViewingId(null)}
          onUpdate={(patch) => mutate(() => api.updateImage(viewing.id, patch))}
          onDelete={() => deleteImage(viewing)}
          onCutout={(on) => mutate(() => (on ? api.retryCutout(viewing.id) : api.setCutout(viewing.id, null)))}
          onContinue={() => {
            const roomId = viewing.roomId
            if (!roomId) return
            const pieces = viewing.kind === 'render' ? (viewing.layout ?? []) : []
            const original = state.images.find((i) => i.id === viewing.baseId)
            if (pieces.length && original) {
              // A design made from stickers is reopened as its pieces, on the picture they were placed on.
              patchDraft(roomId, {
                baseId: original.id,
                layout: pieces,
                itemIds: viewing.itemIds ?? [],
                prompt: viewing.prompt ?? '',
                ideas: [],
                shownId: viewing.id,
              })
              setArranging(true)
            } else {
              patchDraft(roomId, { baseId: viewing.id, layout: [], ideas: [], shownId: undefined })
              window.scrollTo({ top: 0, behavior: 'smooth' })
            }
            setRoomId(roomId)
            setTab('rooms')
            setViewingId(null)
          }}
        />
      )}

      {arranging && room && tab === 'rooms' && baseOf(room, state.images, drafts[room.id]) && (
        <Arranger
          base={baseOf(room, state.images, drafts[room.id])!}
          items={items}
          initial={(drafts[room.id] ?? blankDraft).layout}
          busy={pending.some((p) => p.roomId === room.id)}
          onDone={(layout) => {
            const untouched = JSON.stringify(layout) === JSON.stringify((drafts[room.id] ?? blankDraft).layout)
            patchDraft(room.id, { layout, shownId: untouched ? drafts[room.id]?.shownId : undefined })
            setArranging(false)
          }}
          onRender={(layout) => {
            patchDraft(room.id, { layout, shownId: undefined })
            setArranging(false)
            generate(room, baseOf(room, state.images, drafts[room.id])!.id, layout)
          }}
          onAddItems={(files) => upload('item', files, room.id, false)}
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
  pending: Pending[]
  naming: boolean
  takenNames: string[]
  thinking: boolean
  busy: boolean
  onPatch: (patch: Partial<Draft>) => void
  onToggleItem: (id: string) => void
  onRename: (name: string) => void
  onDelete: () => void
  onAddPhotos: (files: File[]) => void
  onAddItems: (files: File[]) => void
  onGenerate: (baseId: string) => void
  onArrange: () => void
  onSuggest: (baseId: string) => void
  onView: (id: string) => void
}) {
  const { room, draft, items } = props
  const photos = roomPhotos(room, props.images)
  const designs = props.images
    .filter((i) => i.roomId === room.id && i.kind === 'render')
    .sort((a, b) => b.createdAt - a.createdAt)
  const base = baseOf(room, props.images, draft)
  const layout = draft.layout.filter((p) => items.some((i) => i.id === p.itemId))
  const selected = items
    .filter((i) => draft.itemIds.includes(i.id) || layout.some((p) => p.itemId === i.id))
    .map((i) => i.id)
  const hasWords = Boolean(draft.prompt.trim())
  const shown = props.images.find((i) => i.id === draft.shownId && i.roomId === room.id)
  const making = props.pending.length > 0

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

      {!base ? (
        !props.busy && <AddZone big title="Add a photo of this room" hint="As it is now" onFiles={props.onAddPhotos} />
      ) : (
        <>
          <button className="base hero" aria-label="Arrange things on this picture" onClick={props.onArrange}>
            {shown ? (
              <img className="stage-photo" src={fileUrl(shown)} alt="" draggable={false} />
            ) : (
              <Stage base={base} layout={layout} items={items} />
            )}
            {!shown && base.kind === 'render' && <span className="tag">Continuing from a design</span>}
            {items.length > 0 && (
              <span className="pill">{shown ? 'Move things' : layout.length ? 'Rearrange' : 'Place things'}</span>
            )}
          </button>

          <div className="strip views">
            {photos.map((p) => (
              <button
                key={p.id}
                className="thumb"
                aria-pressed={p.id === base.id}
                aria-label={p.id === base.id ? 'Open this photo' : 'Use this view'}
                onClick={() =>
                  p.id === base.id && !shown
                    ? props.onView(p.id)
                    : props.onPatch({ baseId: p.id, layout: [], ideas: [], shownId: undefined })
                }
              >
                <img src={thumbUrl(p)} alt="" />
              </button>
            ))}
            <AddTile label="Another angle" onFiles={props.onAddPhotos} />
          </div>

          {!room.name && !props.naming && photos.length > 0 && (
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

          <h3 className="step">What do you want to put in here?</h3>
          {items.length === 0 ? (
            <AddZone
              title="Add photos of the things"
              hint="A rug, a poster, a table. Product photos and screenshots both work."
              onFiles={props.onAddItems}
            />
          ) : (
            <div className="strip">
              {items.map((item) => (
                <button
                  key={item.id}
                  className={'thumb pick cut' + (isCutting(item) ? ' cutting' : '')}
                  aria-pressed={selected.includes(item.id)}
                  aria-label={item.name || 'Thing'}
                  title={item.name}
                  onClick={() => props.onToggleItem(item.id)}
                >
                  <img src={stickerThumbUrl(item)} alt="" />
                </button>
              ))}
              <AddTile label="Add" onFiles={props.onAddItems} />
            </div>
          )}

          <div className="actions go">
            {shown ? (
              <button className="primary grow" onClick={props.onArrange}>
                Move or add things
              </button>
            ) : layout.length > 0 ? (
              <button className="primary grow" disabled={making} onClick={() => props.onGenerate(base.id)}>
                {making ? 'Making it real…' : 'Make it real'}
              </button>
            ) : selected.length > 0 ? (
              <>
                <button className="primary grow" onClick={props.onArrange}>
                  Place {selected.length === 1 ? 'it' : 'them'} in the room
                </button>
                <button className="ghost" disabled={making} onClick={() => props.onGenerate(base.id)}>
                  {making ? 'Placing…' : 'Place for me'}
                </button>
              </>
            ) : hasWords ? (
              <button className="primary grow" disabled={making} onClick={() => props.onGenerate(base.id)}>
                {making ? 'Making it real…' : 'Show me'}
              </button>
            ) : (
              items.length > 0 && <p className="fine">Tap the things you want to try in this room.</p>
            )}
          </div>

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
              <button className="ghost" disabled={props.thinking} onClick={() => props.onSuggest(base.id)}>
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
        </>
      )}

      {(designs.length > 0 || props.pending.length > 0) && (
        <>
          <h3 className="step">Designs</h3>
          <div className="grid">
            {props.pending.map((p) => (
              <div key={p.key} className="tile pending">
                <span>
                  <span className="kao">(๑•̀ㅂ•́)و</span>
                  {p.prompt || 'Making it real…'}
                </span>
              </div>
            ))}
            {designs.map((d) => (
              <button key={d.id} className="tile" onClick={() => props.onView(d.id)}>
                <img src={thumbUrl(d)} alt={d.prompt || 'Design'} />
                {d.favorite && <span className="heart">♥</span>}
              </button>
            ))}
          </div>
        </>
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
              <button className={'tile cut' + (isCutting(item) ? ' cutting' : '')} onClick={() => props.onView(item.id)}>
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
            {base && !!img.layout?.length ? (
              <button className="next main" onClick={props.onContinue}>
                <b>Move or add things</b>
                <span>Every piece in this design can still be moved, resized or removed</span>
              </button>
            ) : (
              <button className="next main" onClick={props.onContinue}>
                <b>Add more to this</b>
                <span>Keep this picture and put more things into it</span>
              </button>
            )}
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
              <Field value={img.name} placeholder="Name" label="Name" onSave={(name) => props.onUpdate({ name })} allowEmpty />
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
  return (
    <label className={props.className}>
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
