const API = 'https://generativelanguage.googleapis.com/v1beta/models'

export const IMAGE_MODELS = {
  fast: process.env.IMAGE_MODEL_FAST || 'gemini-3.1-flash-image',
  best: process.env.IMAGE_MODEL_BEST || 'gemini-3-pro-image',
}
const TEXT_MODEL = process.env.TEXT_MODEL || 'gemini-3.8-flash'

/** The app's own key wins over a machine-wide GEMINI_API_KEY, which Node will not let a .env file override. */
export const apiKey = () => process.env.DESIGNER_CHAN_GEMINI_KEY || process.env.GEMINI_API_KEY

/** A failure on Gemini's side, reported to the app as a 502 with a readable message. */
class UpstreamError extends Error {
  status = 502
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function call(model, body, timeoutMs, retries = 3) {
  const key = apiKey()
  if (!key) throw new UpstreamError('No Gemini API key is set on the server.')

  for (let attempt = 0; ; attempt++) {
    let res
    try {
      res = await fetch(`${API}/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      throw new UpstreamError(
        e.name === 'TimeoutError'
          ? 'Gemini took too long to answer. Try again.'
          : 'Could not reach Gemini. Check the internet connection.',
      )
    }
    const json = await res.json().catch(() => null)
    if (res.ok) return json

    const detail = json?.error?.message || ''
    if (res.status === 429) {
      throw new UpstreamError(
        /free_tier/.test(detail)
          ? `The Gemini API key is on the free tier, which does not include ${model}. Turn on billing for the key at aistudio.google.com.`
          : 'Gemini is rate-limiting this key right now. Wait a minute and try again.',
      )
    }
    // Overload and transient server errors usually clear within seconds.
    if (res.status >= 500 && attempt < retries) {
      await wait(1500 * 2 ** attempt)
      continue
    }
    throw new UpstreamError(detail || `Gemini request failed (${res.status}).`)
  }
}

function itemLabel(item, i) {
  const name = item.name?.trim()
  const note = item.note?.trim()
  return `ITEM ${i + 1}${name ? `: ${name}` : ''}${note ? ` (${note})` : ''}`
}

/** Room photo first, then each candidate product, each preceded by a text label. */
function sceneParts(base, items, guide) {
  const parts = [{ text: 'ROOM:' }, base.part]
  if (guide) parts.push({ text: 'LAYOUT GUIDE:' }, guide)
  items.forEach((item, i) => parts.push({ text: itemLabel(item, i) }, item.part))
  return parts
}

/**
 * @param {{ base: { part: object }, items: { part: object, name?: string, note?: string }[], prompt: string, quality: 'fast' | 'best' }} input
 * @returns {Promise<{ bytes: Buffer, mime: string, model: string }>}
 */
export async function renderDesign({ base, items, guide, prompt, quality }) {
  const model = IMAGE_MODELS[quality] || IMAGE_MODELS.fast
  const request =
    prompt.trim() ||
    (guide
      ? 'Make the layout guide real.'
      : items.length
        ? 'Place the items where they would naturally go in this room.'
        : 'Furnish and style this room tastefully.')

  const instructions = [
    'You are rendering an interior design visualisation for someone deciding what to buy for their home.',
    'Edit the ROOM image and return one photorealistic image of the same room.',
    "Keep fixed: the room's architecture, camera position, lens and perspective, walls, windows, doors, flooring, built-in fixtures and natural light. Anything the request does not mention stays exactly as it is.",
    items.length
      ? 'Each ITEM is a real product being considered. Show it as pictured (same shape, colours, pattern, materials and proportions), at a believable real-world scale for this room, resting properly on the floor or wall, with perspective, contact shadows and lighting that match the room. Use only the product from each ITEM photo, never its background.'
      : '',
    guide
      ? [
          'The LAYOUT GUIDE is the ROOM with rough cut-outs of the items pasted on by hand to show where each one goes. Treat it as a placement sketch, not as pixels to keep.',
          "For every cut-out in the guide, put that item in the same spot, covering about the same area of the picture, turned the same way, and as many times as it appears. Then make it physically real: a rug lies flat on the floor in the room's perspective, art hangs flat on the wall it was placed over, furniture stands on the floor with correct foreshortening, and nearer objects overlap farther ones.",
          'The result must show no cut-out edges, halos, flat pasted look or leftover background from the guide.',
          items.some((i) => !i.placed)
            ? 'Items that do not appear in the guide go wherever they naturally belong, once each.'
            : '',
        ]
          .filter(Boolean)
          .join(' ')
      : items.length
        ? 'Each item appears once unless the request says otherwise.'
        : '',
    `Request: ${request}`,
  ]
    .filter(Boolean)
    .join('\n\n')

  const json = await call(
    model,
    {
      contents: [{ role: 'user', parts: [...sceneParts(base, items, guide), { text: instructions }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    },
    180_000,
  )

  const candidate = json.candidates?.[0]
  const parts = candidate?.content?.parts ?? []
  const image = parts.findLast((p) => p.inlineData?.data && !p.thought)
  if (!image) {
    const said = parts
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join(' ')
      .trim()
    const reason = json.promptFeedback?.blockReason || candidate?.finishReason
    throw new UpstreamError(
      said || `The model returned no image${reason ? ` (${reason})` : ''}. Try rewording the request.`,
    )
  }
  return {
    bytes: Buffer.from(image.inlineData.data, 'base64'),
    mime: image.inlineData.mimeType || 'image/png',
    model,
  }
}

/** @returns {Promise<{ title: string, prompt: string }[]>} */
export async function suggestIdeas({ base, items }) {
  const brief = [
    'You are a warm, practical interior designer helping a couple furnish their home. Prefer changes that need no renovation: furniture, rugs, art, lighting, textiles, plants.',
    items.length
      ? 'Look at the ROOM and the ITEMs they are considering buying. Propose 4 clearly different ways to arrange or combine them in this room. You may leave an item out if it does not suit the room, and say so in the title.'
      : 'Look at the ROOM. Propose 4 clearly different directions for furnishing and styling it.',
    'For each: "title" is 2 to 4 words. "prompt" is one or two sentences telling an image editor exactly what to place and where, referring to items by name and to real features of this room (the window, the left wall, the corner by the door).',
  ].join('\n\n')

  const json = await call(
    TEXT_MODEL,
    {
      contents: [{ role: 'user', parts: [...sceneParts(base, items), { text: brief }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: { title: { type: 'STRING' }, prompt: { type: 'STRING' } },
            required: ['title', 'prompt'],
          },
        },
      },
    },
    60_000,
  )

  const text = (json.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join('')
  const ideas = JSON.parse(text)
  if (!Array.isArray(ideas) || !ideas.length) throw new UpstreamError('No ideas came back. Try again.')
  return ideas.slice(0, 4)
}

/**
 * Names a photo so nobody has to type: the room it shows, or the product in it.
 * "confident" is false when a person could not tell at a glance, and the app asks instead.
 * @param {{ part: object, kind: 'room' | 'item' }} input
 * @returns {Promise<{ name: string, confident: boolean }>}
 */
export async function namePhoto({ part, kind }) {
  const brief =
    kind === 'room'
      ? 'Which room of a home does this photo show? Give "name" as the short everyday name: Living room, Bedroom, Kitchen, Bathroom, Dining room, Hallway, Office, Balcony, or similar. Set "confident" to true only if anyone would agree at a glance. An empty room that could equally be a bedroom or a living room is not confident.'
      : 'Name the product in this photo in two to four plain words, the way someone would say it out loud: "Striped wool rug", "Oak dining table", "Mountain print poster". Set "confident" to false only if there is no single clear product.'

  // One short try: this runs behind the scenes right after an upload, and asking the person is a fine fallback.
  const json = await call(
    TEXT_MODEL,
    {
      contents: [{ role: 'user', parts: [part, { text: brief }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: { name: { type: 'STRING' }, confident: { type: 'BOOLEAN' } },
          required: ['name', 'confident'],
        },
      },
    },
    15_000,
    0,
  )
  const text = (json.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join('')
  const out = JSON.parse(text)
  return { name: String(out.name ?? '').trim(), confident: out.confident === true }
}

/**
 * Redraws the main object of a busy photo alone on a flat colour, which the app then keys out to make a sticker.
 * The image model cannot return transparency, so a chroma backdrop stands in for it.
 * @param {{ part: object, name?: string }} input
 * @returns {Promise<{ bytes: Buffer, mime: string }>}
 */
export async function isolateProduct({ part, name }) {
  const what = name?.trim() ? `the ${name.trim()}` : 'the main object'
  const brief = [
    `Cut ${what} out of this photo for a furniture catalogue.`,
    'Show only that one object, whole, from the same viewing angle as in the photo, with the same colours, materials, markings and proportions. If part of it is hidden or cropped, complete it plausibly. Do not restyle or improve it.',
    'Remove everything else: no surroundings, no people, no ground, no shadow, no reflection of the surroundings, no text.',
    'Fill the whole background with one flat, perfectly uniform colour: pure green #00FF00. If the object itself has green in it, use pure magenta #FF00FF instead. The background must be the same colour in every corner, with no gradient, vignette or texture.',
    'Light the object evenly so the background colour does not tint it. Leave a clear margin of background on all four sides; the object must not touch the edge.',
  ].join('\n\n')

  const json = await call(
    IMAGE_MODELS.fast,
    {
      contents: [{ role: 'user', parts: [part, { text: brief }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    },
    120_000,
    1,
  )
  const image = (json.candidates?.[0]?.content?.parts ?? []).findLast((p) => p.inlineData?.data && !p.thought)
  if (!image) throw new UpstreamError('The cut-out could not be made.')
  return { bytes: Buffer.from(image.inlineData.data, 'base64'), mime: image.inlineData.mimeType || 'image/png' }
}
