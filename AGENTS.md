# Working on Interior Designer-chan

A self-hosted web app for trying furniture, rugs and art in photos of your own rooms. The README describes what
it does and how to run it. This file is what to know before changing it.

## Product rules

These came from the people who use it. They outrank convenience.

1. **Pictures before words.** Every flow begins with a photo, never with a name or a text box. Infer names and
   labels from the image, and ask a question only when the answer is not obvious. Text input stays optional and
   visually secondary.
2. **No modes.** A picture of a room is always a live canvas. There is no "edit" screen to enter and no "done"
   to press: things are dragged where they sit, in the page.
3. **A room is a loom.** The room photo is the top of a thread. Making a design hangs it beneath the picture it
   came from, beside any made there before, and any picture in the thread can be carried on or branched again.
4. **Things are playthings.** Whatever enters the library becomes a cut-out that can be dragged, resized, rotated
   and removed, and it stays that way after a design is made. Never leave the user with an object baked into a
   picture that they can no longer move.
5. **Direct manipulation for where, words for taste.** Position and size are set by hand on the canvas. Text is
   for mood and style.
6. **iPhone first.** Touch targets of at least 44px, standard gestures, no hover-only affordances. Desktop must
   work well too, with a mouse equivalent for every gesture.
7. **Calm, Japanese, a little kawaii.** Paper white, sumi ink, indigo accent, vermilion only as a small seal.
   Mincho-style headings. Kaomoji are short asides in a few places, simple faces only. No pastel overload, no
   decorative Japanese text.
8. **Never block on the model.** Naming, cut-outs and thumbnails run in the background and fall back quietly.
   Only an explicit "make a design" may wait on the image model, and it shows that it is waiting.

## Architecture

- `server/index.mjs` is a dependency-free Node HTTP server. It owns storage: `DATA_DIR/db.json` plus image files
  in `DATA_DIR/files`. Every mutating route returns the whole state, and the client replaces its copy with it.
- `server/gemini.mjs` holds every prompt and every Gemini call. The API key never leaves the server.
- The front end is React with no router and no state library. `App.tsx` holds the state; `Canvas.tsx` is a
  picture with movable things; `cutout.ts` does pixel work in the browser, because the server has no image library.
- A sticker placement is `{ x, y, w, rot, flip }` with `x`, `y`, `w` as fractions of the room photo, so layouts
  are independent of screen size.
- A design stores the clean picture the model was given (`baseId`), its placements (`layout`), its things
  (`itemIds`) and, when it differs from `baseId`, the picture it hangs under in the thread (`parentId`). A
  design made from stickers is always drawn from the clean picture plus every sticker, never on top of rendered
  pixels, which is what keeps its things movable.
- The designs under one picture are a carousel (`Options` in `App.tsx`). The slide in view is the option the
  thread follows. Its page is set through a controller once the slides are measured, because the carousel
  drops a starting page given before that.
- Which option is followed under each picture, and arrangements in progress, are browser state only.
- The canvas sits in the page with `touch-action: pan-x pan-y`, so a finger on the picture scrolls the page or
  swipes between options. Touching a thing
  holds it, and while a thing is held the canvas takes every touch so a second finger anywhere can pinch.
- Derived images (`thumb`, `cutout`, `cutoutThumb`) are made by the browser and uploaded. An effect in `App.tsx`
  fills in any that are missing, which is how both new uploads and new designs get them.

## Conventions

- TypeScript in `src/`, plain ES modules in `server/`. Formatting is Prettier's: run `npm run format`.
- Keep the server dependency-free. Adding a front-end dependency needs a reason a reader would accept.
- Standard interface behaviours (carousels, popups, menus, focus and keyboard handling) come from UI SDK
  (`@ui-sdk/react`), which is in beta: check a behaviour in the browser before relying on it. The sticker
  gestures in `Canvas.tsx` are our own. Anything inside a carousel that must keep its own mouse drag carries
  `data-carousel-no-drag`.
- Comments explain why, not what. Docs describe the code as it is: no history, no "previously", no notes about
  how a change was made. Commit messages carry the past.
- No compatibility paths for data shapes nobody depends on. Change the shape and the code together.
- User-facing copy is plain and short. Buttons say what will happen ("Move or add things"), not what the
  mechanism is.
- Errors shown to the user are sentences they can act on. Upstream failures are `UpstreamError` (HTTP 502).

## Checking your work

```
npm run format       # Prettier
npm run build        # type-check and build
npm run phone        # serve the build on :8787
```

There is no automated test suite yet. Until there is, verify changes in a real browser at phone width (390px)
and at desktop width, including touch gestures on the canvas. To try things without touching the real library,
point a second server at a scratch folder: `DATA_DIR=<folder> PORT=8799 node server/index.mjs`.

Calls to the image model cost money. Stub `/api/render` and `/api/images/:id/isolate` when a check does not
need a real picture.

Say what you verified and what you did not. A change to a prompt is unverified until a real image has come back.

## Do not

- Commit `data/`, `.env`, or anything containing an API key or a user's photos.
- Send user photos anywhere except the configured Gemini API.
- Add login-free features that widen who can reach the server; it has no authentication.
