import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, writeFile, rename, unlink, stat } from 'node:fs/promises'
import { apiKey, isolateProduct, namePhoto, renderDesign } from './gemini.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data')
const FILES = path.join(DATA, 'files')
const DB_PATH = path.join(DATA, 'db.json')
const DIST = path.join(ROOT, 'dist')
const PORT = Number(process.env.PORT || 8787)
const MAX_BODY = 30 * 1024 * 1024

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
const MIME = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  json: 'application/json',
  webmanifest: 'application/manifest+json',
  ico: 'image/x-icon',
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

// ---- storage ---------------------------------------------------------------

await mkdir(FILES, { recursive: true })

/** @type {{ rooms: any[], images: any[] }} */
let db = { rooms: [], images: [] }
try {
  db = JSON.parse(await readFile(DB_PATH, 'utf8'))
} catch (e) {
  if (e.code !== 'ENOENT') throw e
}

let saving = Promise.resolve()
function save() {
  const snapshot = JSON.stringify(db, null, 2)
  saving = saving
    .catch(() => {})
    .then(async () => {
      await writeFile(DB_PATH + '.tmp', snapshot)
      await rename(DB_PATH + '.tmp', DB_PATH)
    })
  return saving
}

const newId = () => crypto.randomBytes(6).toString('hex')

async function storeBytes(bytes, mime) {
  const ext = EXT[mime]
  if (!ext) throw new HttpError(400, 'Only JPEG, PNG and WebP images are supported.')
  const id = newId()
  const file = `${id}.${ext}`
  await writeFile(path.join(FILES, file), bytes)
  return { id, file }
}

async function removeFiles(images) {
  const names = images.flatMap((img) => [img.file, img.cutout, img.thumb, img.cutoutThumb]).filter(Boolean)
  await Promise.all(names.map((name) => unlink(path.join(FILES, name)).catch(() => {})))
}

function parseDataUrl(value) {
  const match = /^data:(image\/[a-z]+);base64,(.+)$/s.exec(typeof value === 'string' ? value : '')
  if (!match) throw new HttpError(400, 'That file could not be read as an image.')
  return { mime: match[1], bytes: Buffer.from(match[2], 'base64') }
}

async function storeDataUrl(value) {
  const { mime, bytes } = parseDataUrl(value)
  return storeBytes(bytes, mime)
}

const unit = (v, min, max, fallback) => (Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback)

/** Where each sticker sat on the room photo, in fractions of the photo's width and height. */
function cleanLayout(value, items) {
  if (!Array.isArray(value)) return []
  return value
    .filter((p) => p && items.some((i) => i.id === p.itemId))
    .slice(0, 40)
    .map((p) => ({
      key: text(String(p.key ?? ''), 40) || newId(),
      itemId: p.itemId,
      x: unit(p.x, 0, 1, 0.5),
      y: unit(p.y, 0, 1, 0.5),
      w: unit(p.w, 0.01, 3, 0.3),
      rot: unit(p.rot, -1000, 1000, 0),
      flip: p.flip === true,
    }))
}

async function imagePart(img) {
  const bytes = await readFile(path.join(FILES, img.file))
  return { inlineData: { mimeType: MIME[img.file.split('.').pop()], data: bytes.toString('base64') } }
}

function findImage(id) {
  const img = db.images.find((i) => i.id === id)
  if (!img) throw new HttpError(404, 'That image no longer exists.')
  return img
}

function findRoom(id) {
  const room = db.rooms.find((r) => r.id === id)
  if (!room) throw new HttpError(404, 'That room no longer exists.')
  return room
}

async function scene(body) {
  const base = findImage(body.baseId)
  const items = (Array.isArray(body.itemIds) ? body.itemIds : [])
    .map((id) => db.images.find((i) => i.id === id && i.kind === 'item'))
    .filter(Boolean)
  return {
    items,
    input: {
      base: { part: await imagePart(base) },
      items: await Promise.all(
        items.map(async (item) => ({ part: await imagePart(item), name: item.name, note: item.note })),
      ),
    },
  }
}

// ---- api -------------------------------------------------------------------

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

const routes = {
  'GET /api/state': async () => db,

  'POST /api/rooms': async (_, body) => {
    // A room can start nameless: it is created from a photo and named from what the photo shows.
    const room = { id: newId(), name: text(body.name, 60), createdAt: Date.now() }
    db.rooms.push(room)
    await save()
    return { state: db, id: room.id }
  },

  'PATCH /api/rooms/:id': async ({ id }, body) => {
    const room = findRoom(id)
    const name = text(body.name, 60)
    if (name) room.name = name
    await save()
    return { state: db }
  },

  'DELETE /api/rooms/:id': async ({ id }) => {
    findRoom(id)
    const gone = db.images.filter((i) => i.roomId === id)
    db.rooms = db.rooms.filter((r) => r.id !== id)
    db.images = db.images.filter((i) => i.roomId !== id)
    await save()
    await removeFiles(gone)
    return { state: db }
  },

  'POST /api/images': async (_, body) => {
    const kind = body.kind === 'item' ? 'item' : 'room'
    if (kind === 'room') findRoom(body.roomId)
    const { id, file } = await storeDataUrl(body.dataUrl)
    const cutout = kind === 'item' && body.cutoutDataUrl ? (await storeDataUrl(body.cutoutDataUrl)).file : undefined
    db.images.push({
      id,
      kind,
      roomId: kind === 'room' ? body.roomId : null,
      name: text(body.name, 80),
      note: '',
      file,
      cutout,
      cutoutTried: kind === 'item' ? !!cutout : undefined,
      createdAt: Date.now(),
    })
    await save()
    return { state: db, id }
  },

  'PUT /api/images/:id/cutout': async ({ id }, body) => {
    const img = findImage(id)
    if (img.kind !== 'item') throw new HttpError(400, 'Only things have cut-outs.')
    const next = body.dataUrl ? (await storeDataUrl(body.dataUrl)).file : undefined
    const old = [img.cutout, img.cutoutThumb].filter(Boolean)
    img.cutout = next
    img.cutoutThumb = undefined
    // "retry" hands the thing back to the app to cut out again; anything else settles the matter.
    img.cutoutTried = body.retry !== true
    if (body.retry === true) img.cutoutAttempt = (img.cutoutAttempt ?? 0) + 1
    await save()
    await Promise.all(old.map((name) => unlink(path.join(FILES, name)).catch(() => {})))
    return { state: db, id }
  },

  'POST /api/images/:id/isolate': async ({ id }) => {
    const img = findImage(id)
    if (img.kind !== 'item') throw new HttpError(400, 'Only things have cut-outs.')
    const out = await isolateProduct({ part: await imagePart(img), name: img.name })
    return { dataUrl: `data:${out.mime};base64,${out.bytes.toString('base64')}` }
  },

  // Small copies for tiles and strips, made by the browser, so a phone never decodes a full photo for a thumbnail.
  'PUT /api/images/:id/thumb': async ({ id }, body) => {
    const img = findImage(id)
    const old = []
    if (body.dataUrl) {
      const { file } = await storeDataUrl(body.dataUrl)
      if (img.thumb) old.push(img.thumb)
      img.thumb = file
    }
    if (body.cutoutDataUrl && img.cutout) {
      const { file } = await storeDataUrl(body.cutoutDataUrl)
      if (img.cutoutThumb) old.push(img.cutoutThumb)
      img.cutoutThumb = file
    }
    if (!db.images.includes(img)) {
      await removeFiles([{ thumb: img.thumb, cutoutThumb: img.cutoutThumb }])
      throw new HttpError(404, 'That image no longer exists.')
    }
    await save()
    await Promise.all(old.map((name) => unlink(path.join(FILES, name)).catch(() => {})))
    return { state: db, id }
  },

  'PATCH /api/images/:id': async ({ id }, body) => {
    const img = findImage(id)
    if (typeof body.name === 'string') img.name = text(body.name, 80)
    if (typeof body.note === 'string') img.note = text(body.note, 300)
    if (typeof body.favorite === 'boolean') img.favorite = body.favorite
    await save()
    return { state: db }
  },

  'DELETE /api/images/:id': async ({ id }) => {
    const img = findImage(id)
    db.images = db.images.filter((i) => i.id !== id)
    await save()
    await removeFiles([img])
    return { state: db }
  },

  'POST /api/render': async (_, body) => {
    const room = findRoom(body.roomId)
    const prompt = text(body.prompt, 2000)
    const { items, input } = await scene(body)
    const layout = cleanLayout(body.layout, items)
    let guide
    if (layout.length && body.guideDataUrl) {
      const { mime, bytes } = parseDataUrl(body.guideDataUrl)
      guide = { inlineData: { mimeType: mime, data: bytes.toString('base64') } }
    }
    const placed = new Set(guide ? layout.map((p) => p.itemId) : [])
    input.items.forEach((item, i) => (item.placed = placed.has(items[i].id)))
    const out = await renderDesign({ ...input, guide, prompt })
    const { id, file } = await storeBytes(out.bytes, out.mime)
    db.images.push({
      id,
      kind: 'render',
      roomId: room.id,
      name: '',
      note: '',
      file,
      createdAt: Date.now(),
      baseId: body.baseId,
      itemIds: items.map((i) => i.id),
      layout: guide ? layout : undefined,
      prompt,
      model: out.model,
    })
    await save()
    return { state: db, id }
  },

  'POST /api/rooms/:id/guess-name': async ({ id }) => {
    const room = findRoom(id)
    const photo = db.images.find((i) => i.roomId === id && i.kind === 'room')
    if (room.name || !photo) return { state: db, id }
    const guess = await namePhoto({ part: await imagePart(photo), kind: 'room' }).catch(() => null)
    if (guess?.confident && guess.name && !room.name) {
      const taken = (name) => db.rooms.some((r) => r.name.toLowerCase() === name.toLowerCase())
      let name = text(guess.name, 60)
      for (let n = 2; taken(name); n++) name = `${text(guess.name, 56)} ${n}`
      room.name = name
      await save()
    }
    return { state: db, id }
  },

  'POST /api/images/:id/guess-name': async ({ id }) => {
    const img = findImage(id)
    if (img.kind !== 'item' || img.name) return { state: db, id }
    const guess = await namePhoto({ part: await imagePart(img), kind: 'item' }).catch(() => null)
    if (guess?.confident && guess.name && !img.name && db.images.includes(img)) {
      img.name = text(guess.name, 80)
      await save()
    }
    return { state: db, id }
  },
}

const compiled = Object.entries(routes).map(([key, handler]) => {
  const [method, pattern] = key.split(' ')
  const regex = new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[\\w-]+)') + '$')
  return { method, regex, handler }
})

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new HttpError(413, 'That photo is too large.')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'Malformed request.')
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(body)
}

async function sendFile(res, file, cacheControl) {
  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) return false
  res.writeHead(200, {
    'content-type': MIME[file.split('.').pop()] || 'application/octet-stream',
    'content-length': info.size,
    'cache-control': cacheControl,
  })
  createReadStream(file).pipe(res)
  return true
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const pathname = decodeURIComponent(url.pathname)

  try {
    if (pathname.startsWith('/api/')) {
      for (const route of compiled) {
        const match = route.method === req.method && route.regex.exec(pathname)
        if (!match) continue
        const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req)
        if (!body || typeof body !== 'object') throw new HttpError(400, 'Malformed request.')
        return sendJson(res, 200, await route.handler(match.groups ?? {}, body))
      }
      throw new HttpError(404, 'Not found.')
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.')

    if (pathname.startsWith('/files/')) {
      const name = pathname.slice('/files/'.length)
      if (!/^[a-f0-9]+\.(jpg|png|webp)$/.test(name)) throw new HttpError(404, 'Not found.')
      if (await sendFile(res, path.join(FILES, name), 'private, max-age=31536000, immutable')) return
      throw new HttpError(404, 'Not found.')
    }

    const asset = path.join(DIST, pathname)
    if (asset.startsWith(DIST + path.sep) && path.extname(asset)) {
      const cache = pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
      if (await sendFile(res, asset, cache)) return
      throw new HttpError(404, 'Not found.')
    }
    if (await sendFile(res, path.join(DIST, 'index.html'), 'no-cache')) return
    throw new HttpError(404, 'The app has not been built yet. Run "npm run build", or use "npm run dev".')
  } catch (e) {
    const status = Number.isInteger(e.status) ? e.status : 500
    if (status === 500) console.error(e)
    if (!res.headersSent) sendJson(res, status, { error: e.message || 'Something went wrong.' })
    else res.end()
  }
})

server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e
  console.error(
    `Port ${PORT} is already taken, most likely by a Designer-chan server that is still running.\n` +
      `Open http://localhost:${PORT} to use that one, or close it first (run "npm run stop") and start again.`,
  )
  process.exit(1)
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Designer-chan is running. On this computer: http://localhost:${PORT}`)
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    // Virtual adapters (WSL, Hyper-V) and self-assigned addresses are not reachable from a phone.
    if (/^vEthernet|WSL|Loopback/i.test(name)) continue
    for (const n of addresses ?? []) {
      if (n.family !== 'IPv4' || n.internal || n.address.startsWith('169.254.')) continue
      const where = /tailscale/i.test(name) ? 'anywhere, with Tailscale on' : `on the same network (${name})`
      console.log(`On a phone ${where}: http://${n.address}:${PORT}`)
    }
  }
  if (!apiKey()) console.warn('No Gemini API key is set, so generating designs will fail.')
})
