# Interior Designer-chan

See furniture, rugs and art in your own rooms before you buy them.

Add a photo of a room. Add photos of the things you are considering. Each thing becomes a cut-out you can drag,
pinch and twist into place on the room photo, like a sticker. "Make it real" turns the rough arrangement into a
photorealistic picture of the room, and any design can be reopened to move its pieces again.

It runs on your own computer, keeps your photos there, and is built for an iPhone first.

## Run it

Needs Node 22 or newer and a Gemini API key with billing turned on. The free tier does not include image models.

```
npm install
cp .env.example .env     # then paste your key into .env
npm run phone            # build and serve on http://localhost:8787
```

The server prints the addresses other devices can use. On an iPhone, open one in Safari and choose
Share → Add to Home Screen to get an app icon.

| Command | |
| --- | --- |
| `npm run phone` | Stop any running server, build, and serve the app |
| `npm run dev` | API on :8787 and Vite on :5173 with hot reload |
| `npm run build` | Type-check and build the front end into `dist/` |
| `npm start` | Serve the last build |
| `npm run stop` | Stop the server on the app's port |

## Configuration

Read from the environment or from `.env`.

| Variable | Default | |
| --- | --- | --- |
| `DESIGNER_CHAN_GEMINI_KEY` | falls back to `GEMINI_API_KEY` | Gemini API key for this app |
| `PORT` | `8787` | |
| `DATA_DIR` | `./data` | Photos, designs and `db.json` |
| `IMAGE_MODEL_FAST` | `gemini-3.1-flash-image` | Quick designs and cut-outs |
| `IMAGE_MODEL_BEST` | `gemini-3-pro-image` | Best-quality designs |
| `TEXT_MODEL` | `gemini-3.8-flash` | Naming photos and suggesting ideas |

## How it works

- **Rooms** start from a photo. The room is named from what the photo shows, and you are asked only when that is
  not obvious.
- **Things** are cut out when added. A plain backdrop is removed in the browser. A busy photo is sent to the image
  model, which redraws the object on a flat colour that the browser then removes.
- **Arranging** happens on a full-screen canvas: one finger drags, two fingers resize and rotate, with a corner
  handle and scroll wheel for a mouse.
- **Make it real** sends the room photo, the rough collage and the original photos of the things to the image
  model, asking it to keep each thing where it was put and make it physically believable.
- **Designs** remember their pieces, so reopening one brings back the original room photo with every sticker
  still movable.

## Layout

```
server/index.mjs    HTTP API, file storage, static hosting. No dependencies.
server/gemini.mjs   Every prompt and every call to Gemini.
server/stop.mjs     Stops the server on the app's port.
src/App.tsx         Screens: rooms, things, the picture viewer.
src/Arranger.tsx    The sticker canvas and its gestures.
src/cutout.ts       Background removal, thumbnails, the collage.
src/api.ts          Types and the client for the HTTP API.
src/styles.css      All styling.
```

## Privacy and safety

Photos and designs stay in `DATA_DIR` on the machine running the server. Images are sent to Google's Gemini API
when a room or thing is named, a busy photo is cut out, ideas are suggested, or a design is made.

There is no login. Anyone who can reach the server can use it and spend the API key, so keep it on a network you
trust.

See [CONTRIBUTING.md](CONTRIBUTING.md) to work on it and [AGENTS.md](AGENTS.md) for the conventions coding agents
follow here.
