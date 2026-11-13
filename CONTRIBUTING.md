# Contributing

Thanks for wanting to help. This is a small project with strong opinions about how it should feel, so please read
the product rules in [AGENTS.md](AGENTS.md) first. They apply to people as much as to coding agents.

## Set up

You need Node 22 or newer and a Gemini API key with billing enabled.

```
npm install
cp .env.example .env     # paste your key
npm run dev              # API on :8787, app on :5173 with hot reload
```

To work without touching your own library, or without a key, point the server at a scratch folder:

```
DATA_DIR=./scratch-data PORT=8799 node server/index.mjs
API_URL=http://localhost:8799 npx vite
```

Everything except naming, busy-photo cut-outs, idea suggestions and "Make it real" works with no key.

## Making a change

1. Branch from `main`.
2. Keep the change to one idea. A bug fix does not need a refactor around it.
3. Run `npm run build`. It type-checks and builds; it must pass.
4. Try it in a browser at phone width and at desktop width. If you touched the canvas, try it with touch.
5. Open a pull request that says what changed for the person using the app, what you checked, and what you did
   not check. Include a screenshot for anything visible.

## What makes a change easy to accept

- It starts from a picture, not a form.
- It keeps things movable after a design is made.
- It works on an iPhone in Safari.
- It adds no server dependency, and no front-end dependency without a clear reason.
- Its copy is short and says what will happen.

## Reporting a problem

Open an issue with what you did, what you expected, what happened, and the device and browser. A screenshot or
screen recording helps most. Please do not attach photos you would not want public.

## Costs and privacy

Calls to the image model cost money on the key in your `.env`. Never commit `.env`, the `data/` folder, or
anyone's photos.
