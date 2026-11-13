import type { Placement } from './api'

export async function loadImage(src: string): Promise<HTMLImageElement> {
  const el = new Image()
  el.src = src
  await el.decode()
  return el
}

/** A small copy of an image. PNG keeps a cut-out's transparency. */
export async function shrink(src: string, maxSide: number, type: 'image/jpeg' | 'image/png'): Promise<string> {
  const img = await loadImage(src)
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL(type, 0.82)
}

/**
 * Removes a plain backdrop (the white or grey of a product photo) by flooding in from the edges.
 * Returns a transparent PNG cropped to the object, or null when the photo has no plain backdrop
 * to remove, in which case the whole photo is the sticker.
 */
export async function cutOut(
  src: string,
  { maxSide = 1024, shave = 1, despill = false }: { maxSide?: number; shave?: number; despill?: boolean } = {},
): Promise<string | null> {
  const img = await loadImage(src)
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.round(img.naturalWidth * scale)
  const h = Math.round(img.naturalHeight * scale)
  if (w < 8 || h < 8) return null

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(img, 0, 0, w, h)
  const image = ctx.getImageData(0, 0, w, h)
  const px = image.data

  const border: number[] = []
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x)
  for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1)

  let r = 0
  let g = 0
  let b = 0
  for (const i of border) {
    r += px[i * 4]
    g += px[i * 4 + 1]
    b += px[i * 4 + 2]
  }
  r /= border.length
  g /= border.length
  b /= border.length
  const fromBackdrop = (i: number) => Math.hypot(px[i * 4] - r, px[i * 4 + 1] - g, px[i * 4 + 2] - b)

  // A backdrop is "plain" when most of the frame's edge is close to one colour.
  const plainEdge = border.filter((i) => fromBackdrop(i) < 40).length / border.length
  if (plainEdge < 0.8) return null

  // 1 = backdrop. Spread from the edges through pixels near the backdrop colour, following soft
  // gradients and shadows a little further as long as each step is small.
  const mask = new Uint8Array(w * h)
  const stack = new Int32Array(w * h)
  let top = 0
  for (const i of border) {
    if (!mask[i] && fromBackdrop(i) < 48) {
      mask[i] = 1
      stack[top++] = i
    }
  }
  while (top) {
    const i = stack[--top]
    const x = i % w
    const y = (i - x) / w
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
      if (j < 0 || mask[j]) continue
      const d = fromBackdrop(j)
      const step = Math.hypot(px[j * 4] - px[i * 4], px[j * 4 + 1] - px[i * 4 + 1], px[j * 4 + 2] - px[i * 4 + 2])
      if (d < 48 || (d < 90 && step < 7)) {
        mask[j] = 1
        stack[top++] = j
      }
    }
  }

  // On a chroma backdrop, the key colour also shows through gaps the flood cannot reach from the edge:
  // car windows, chair legs, the handle of a mug. Those become holes too.
  if (despill) {
    const keyGreen = g > r + 50 && g > b + 50
    const keyMagenta = r > g + 50 && b > g + 50
    for (let i = 0; i < mask.length && (keyGreen || keyMagenta); i++) {
      if (mask[i]) continue
      const pr = px[i * 4]
      const pg = px[i * 4 + 1]
      const pb = px[i * 4 + 2]
      const keyed = keyGreen
        ? pg > 90 && pg > pr * 1.4 && pg > pb * 1.4
        : pr > 90 && pb > 90 && pr > pg * 1.4 && pb > pg * 1.4
      if (keyed || fromBackdrop(i) < 70) mask[i] = 1
    }
  }

  let removed = 0
  for (let i = 0; i < mask.length; i++) removed += mask[i]
  const share = removed / mask.length
  if (share < 0.04 || share > 0.97) return null

  // Shave one pixel off the object to drop the backdrop-coloured fringe, then soften the edge.
  let shaved = mask
  for (let pass = 0; pass < shave; pass++) {
    const prev = shaved
    shaved = prev.slice()
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x
        if (!prev[i] && (prev[i - 1] || prev[i + 1] || prev[i - w] || prev[i + w])) shaved[i] = 1
      }
    }
  }

  // A bright green or magenta backdrop bleeds into the object's edge. Pull that colour back out near the outline.
  if (despill) {
    const green = g > r + 50 && g > b + 50
    const magenta = r > g + 50 && b > g + 50
    for (let y = 3; y < h - 3 && (green || magenta); y++) {
      for (let x = 3; x < w - 3; x++) {
        const i = y * w + x
        if (shaved[i]) continue
        let nearEdge = false
        for (let d = 1; d <= 3 && !nearEdge; d++) {
          nearEdge = !!(shaved[i - d] || shaved[i + d] || shaved[i - d * w] || shaved[i + d * w])
        }
        if (!nearEdge) continue
        const o = i * 4
        if (green) {
          px[o + 1] = Math.min(px[o + 1], Math.max(px[o], px[o + 2]))
        } else {
          const excess = Math.min(px[o], px[o + 2]) - px[o + 1]
          if (excess > 0) {
            px[o] -= excess * 0.7
            px[o + 2] -= excess * 0.7
          }
        }
      }
    }
  }
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      let solid = 0
      let count = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          const yy = y + dy
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
          count++
          solid += 1 - shaved[yy * w + xx]
        }
      }
      const alpha = shaved[i] ? 0 : Math.round((255 * solid) / count)
      px[i * 4 + 3] = alpha
      if (alpha > 8) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (x1 < x0 || y1 < y0) return null
  ctx.putImageData(image, 0, 0)

  const out = document.createElement('canvas')
  out.width = x1 - x0 + 1
  out.height = y1 - y0 + 1
  out.getContext('2d')!.drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height)
  return out.toDataURL('image/png')
}

/** Flattens the room photo and its stickers into one picture, exactly as they appear on the canvas. */
export async function composeGuide(
  baseUrl: string,
  layout: Placement[],
  stickerUrl: (itemId: string) => string | undefined,
  maxSide = 2048,
): Promise<string> {
  const base = await loadImage(baseUrl)
  const scale = Math.min(1, maxSide / Math.max(base.naturalWidth, base.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(base.naturalWidth * scale)
  canvas.height = Math.round(base.naturalHeight * scale)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(base, 0, 0, canvas.width, canvas.height)

  for (const p of layout) {
    const url = stickerUrl(p.itemId)
    if (!url) continue
    const sticker = await loadImage(url)
    const w = p.w * canvas.width
    const h = (w * sticker.naturalHeight) / sticker.naturalWidth
    ctx.save()
    ctx.translate(p.x * canvas.width, p.y * canvas.height)
    ctx.rotate(p.rot)
    if (p.flip) ctx.scale(-1, 1)
    ctx.drawImage(sticker, -w / 2, -h / 2, w, h)
    ctx.restore()
  }
  return canvas.toDataURL('image/jpeg', 0.9)
}
