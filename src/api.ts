export type Room = { id: string; name: string; createdAt: number }

/** A sticker on a room photo. x, y and w are fractions of the photo; x, y mark the sticker's centre. */
export type Placement = { key: string; itemId: string; x: number; y: number; w: number; rot: number; flip?: boolean }

export type Img = {
  id: string
  kind: 'room' | 'item' | 'render'
  roomId: string | null
  name: string
  note: string
  file: string
  /** Things only: the photo with its backdrop removed. */
  cutout?: string
  /** Things only: false while the app is still working out the cut-out. */
  cutoutTried?: boolean
  cutoutAttempt?: number
  /** Small copies of file and cutout, for tiles and strips. */
  thumb?: string
  cutoutThumb?: string
  createdAt: number
  favorite?: boolean
  /** Designs: the clean picture the model was given. */
  baseId?: string
  /** Designs: the picture in the thread this was branched from, when that is not baseId. */
  parentId?: string
  itemIds?: string[]
  layout?: Placement[]
  prompt?: string
  model?: string
}

export type State = { rooms: Room[]; images: Img[] }
export type Idea = { title: string; prompt: string }
export type Quality = 'fast' | 'best'
type Changed = { state: State; id: string }

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new Error("Can't reach the server. Is it still running?")
  }
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(json?.error || `Request failed (${res.status}).`)
  return json as T
}

export const api = {
  state: () => call<State>('GET', '/api/state'),
  addRoom: (name = '') => call<Changed>('POST', '/api/rooms', { name }),
  guessRoomName: (id: string) => call<Changed>('POST', `/api/rooms/${id}/guess-name`, {}),
  guessItemName: (id: string) => call<Changed>('POST', `/api/images/${id}/guess-name`, {}),
  renameRoom: (id: string, name: string) => call<Changed>('PATCH', `/api/rooms/${id}`, { name }),
  deleteRoom: (id: string) => call<Changed>('DELETE', `/api/rooms/${id}`),
  addImage: (body: {
    kind: 'room' | 'item'
    roomId?: string
    name?: string
    dataUrl: string
    cutoutDataUrl?: string
  }) => call<Changed>('POST', '/api/images', body),
  updateImage: (id: string, patch: { name?: string; note?: string; favorite?: boolean }) =>
    call<Changed>('PATCH', `/api/images/${id}`, patch),
  setCutout: (id: string, dataUrl: string | null) => call<Changed>('PUT', `/api/images/${id}/cutout`, { dataUrl }),
  retryCutout: (id: string) => call<Changed>('PUT', `/api/images/${id}/cutout`, { retry: true }),
  isolate: (id: string) => call<{ dataUrl: string }>('POST', `/api/images/${id}/isolate`, {}),
  setThumb: (id: string, body: { dataUrl?: string; cutoutDataUrl?: string }) =>
    call<Changed>('PUT', `/api/images/${id}/thumb`, body),
  deleteImage: (id: string) => call<Changed>('DELETE', `/api/images/${id}`),
  render: (body: {
    roomId: string
    baseId: string
    parentId?: string
    itemIds: string[]
    prompt: string
    quality: Quality
    layout?: Placement[]
    guideDataUrl?: string
  }) => call<Changed>('POST', '/api/render', body),
  ideas: (body: { baseId: string; itemIds: string[] }) => call<{ ideas: Idea[] }>('POST', '/api/ideas', body),
}

/** A thing whose cut-out is still being made. */
export const isCutting = (img: Img) => img.kind === 'item' && !img.cutout && !img.cutoutTried

export const fileUrl = (img: Img) => `/files/${img.file}`
/** What a thing looks like as a sticker: its cut-out, or the whole photo when it has none. */
export const stickerUrl = (img: Img) => `/files/${img.cutout ?? img.file}`
/** Small versions of the two above. Use these anywhere the picture is shown as a tile. */
export const thumbUrl = (img: Img) => `/files/${img.thumb ?? img.file}`
export const stickerThumbUrl = (img: Img) => (img.cutout ? `/files/${img.cutoutThumb ?? img.cutout}` : thumbUrl(img))

/** Phone photos are far larger than the image model needs; shrink before upload. */
export async function toDataUrl(file: File, maxSide = 2048): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const el = new Image()
    el.src = url
    await el.decode()
    const scale = Math.min(1, maxSide / Math.max(el.naturalWidth, el.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(el.naturalWidth * scale)
    canvas.height = Math.round(el.naturalHeight * scale)
    canvas.getContext('2d')!.drawImage(el, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.9)
  } catch {
    throw new Error(`"${file.name}" could not be read as an image.`)
  } finally {
    URL.revokeObjectURL(url)
  }
}
