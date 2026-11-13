# Interior Designer-chan

See furniture, rugs and art in your own rooms before you buy them.

Add a photo of a room. Add photos of the things you are considering. Each thing becomes a cut-out you can drag,
pinch and twist into place right on the room photo, like a sticker. "Make it real" hangs a photorealistic
design beneath it. Carry on from there, or go back up, change something and make another to branch a different
way: everything in every picture stays movable.

The whole app is pictures, a dock of your things, and one button. It runs on your own computer, keeps your
photos there, and is built for an iPhone first.

## Run it

Needs Node 22 or newer and a Gemini API key with billing turned on. The free tier does not include image models.

```
npm install
cp .env.example .env     # then paste your key into .env
npm run phone            # build and serve on http://localhost:8787
```

The server prints the addresses other devices can use. On an iPhone, open one in Safari and choose
Share → Add to Home Screen to get an app icon.

| Command          |                                                   |
| ---------------- | ------------------------------------------------- |
| `npm run phone`  | Stop any running server, build, and serve the app |
| `npm run dev`    | API on :8787 and Vite on :5173 with hot reload    |
| `npm run build`  | Type-check and build the front end into `dist/`   |
| `npm start`      | Serve the last build                              |
| `npm run stop`   | Stop the server on the app's port                 |
| `npm run format` | Format the code with Prettier                     |

## Configuration

Read from the environment or from `.env`.

| Variable                   | Default                        |                                     |
| -------------------------- | ------------------------------ | ----------------------------------- |
| `DESIGNER_CHAN_GEMINI_KEY` | falls back to `GEMINI_API_KEY` | Gemini API key for this app         |
| `PORT`                     | `8787`                         |                                     |
| `DATA_DIR`                 | `./data`                       | Photos, designs and `db.json`       |
| `IMAGE_MODEL_FAST`         | `gemini-3.1-flash-image`       | Designs and cut-outs                |
| `TEXT_MODEL`               | `gemini-3.8-flash`             | Naming rooms and things from photos |

## How it works

- **Rooms** each start from one photo and sit side by side: swipe the top picture sideways to move between
  them. The room's name is a menu for switching, adding, renaming and deleting rooms. Rooms are named from what
  the photo shows.
- **Things** live in the dock at the bottom. Tap one and it lands on the picture nearest the middle of the
  screen. Pull the dock up to see every thing, rename it, or change its cut-out.
- **Cut-outs** are made when a thing is added. A plain backdrop is removed in the browser. A busy photo is sent
  to the image model, which redraws the object on a flat colour that the browser then removes.
- **Arranging** happens on the picture itself, with no toolbar. One finger on a thing drags it; with a thing
  held, two fingers anywhere resize and rotate it. Moving a thing brings it to the front, a double tap flips it,
  the small cross takes it out, and a tap elsewhere lets go. With a mouse, a corner handle turns and resizes,
  the scroll wheel resizes, arrow keys nudge and Delete removes.
- **Make it real** appears in the dock when there is something to make. It sends the room photo, the rough
  collage and the original photos of the things to the image model, asking it to keep each thing where it was
  put and make it physically believable.
- **A room is a thread of pictures.** The designs made from a picture sit beneath it side by side; swipe
  sideways or tap the dots to move between them. The one in view is the one the thread carries on from, with
  its own designs beneath. Designs remember their pieces, so moving something in a finished design redraws
  from the original photo.
- **"…" on a design** saves it, marks it as a favourite, or deletes it.

## Layout

```
server/index.mjs    HTTP API, file storage, static hosting. No dependencies.
server/gemini.mjs   Every prompt and every call to Gemini.
server/stop.mjs     Stops the server on the app's port.
src/App.tsx         The one screen: rooms, the thread of designs, the dock.
src/Canvas.tsx      A picture with movable things, and its gestures.
src/cutout.ts       Background removal, thumbnails, the collage.
src/api.ts          Types and the client for the HTTP API.
src/styles.css      All styling.
```

## Privacy and safety

Photos and designs stay in `DATA_DIR` on the machine running the server. Images are sent to Google's Gemini API
when a room or thing is named, a busy photo is cut out, or a design is made.

There is no login. Anyone who can reach the server can use it and spend the API key, so keep it on a network you
trust.

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md). You may use, change and share it for any noncommercial purpose. You may
not sell it or use it commercially.

See [CONTRIBUTING.md](CONTRIBUTING.md) to work on it and [AGENTS.md](AGENTS.md) for the conventions coding agents
follow here.
