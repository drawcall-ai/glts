# GLTS Preview

A static page that renders one frame of a GLTS asset:

```
https://<host>/?url=<asset.glts>
```

It loads the asset with `isPreview: true` and an `AuthoringWorld`, so physics
objects are constructed but never simulated. Then it runs `update()` once, so
frame callbacks can apply state such as animation poses. It renders with
`scene.defaultCamera`, or with a camera fitted to the scene's bounds if the
asset has none. After the frame is drawn it logs `ready` to the console. If
anything fails, it logs the error with `console.error` and shows it on the
page. The asset URL must allow cross-origin requests (CORS).

```sh
pnpm --filter @drawcall/glts-preview... build   # outputs preview/dist
pnpm --filter @drawcall/glts-preview dev
```

`.github/workflows/pages.yml` deploys `preview/dist` to GitHub Pages on every
push to `main`.
