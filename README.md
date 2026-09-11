# iPhone Duo Tester

A 1:1 model of iPhone Duo, built in plain HTML/CSS/JS, that folds and unfolds with
spring-animated hinge physics. Enter any URL and it is loaded on the device: on the 5.4″
outer display when closed and on the 7.6″ inner display when open, at the device's real
CSS viewport size. A small server-side check reads the site's frame headers first, so
the page can tell you *why* a site does or does not work instead of showing a blank
screen.

## Deploy it (one click)

The tester needs a tiny server for two routes: the header check and the rendering
proxy that lets sites which refuse framing still render inside the phone. Either host
below runs it with no configuration:

- **Vercel**: https://vercel.com/new/clone?repository-url=https://github.com/jayesh96/iphone-duo-tester&project-name=iphone-duo-tester
- **Render**: https://render.com/deploy?repo=https://github.com/jayesh96/iphone-duo-tester (uses `render.yaml` at the repo root)

Static hosts (GitHub Pages, the claude.ai artifact) can show the
model but cannot run the proxy, so on those only sites that allow framing will load.

## Run it

```bash
npm start            # http://localhost:3000
```

No dependencies, Node 18+. `npm run dev` additionally allows testing URLs on
`localhost` and private networks (the production check refuses them to prevent SSRF).

Deploying to Vercel works with zero configuration. The static files are served as-is and `api/check.js` becomes a serverless
function. Any other Node host can run `server.mjs` directly.

If the site is hosted somewhere without the `/api/check` endpoint (plain static hosting),
the tester still loads the URL in the frame but tells you it could not verify headers.

## What "works or not" means

`GET /api/check?url=…` fetches the URL server-side (headers only, redirects followed hop
by hop) and reports:

| Field | Meaning |
| --- | --- |
| `status`, `ok` | HTTP status of the final response |
| `embeddable`, `reason` | Whether `X-Frame-Options` / CSP `frame-ancestors` allow framing, and which header decides |
| `redirects` | Every redirect hop and its status |
| `contentType`, `isHtml`, `headers.server` | Extra context shown as chips |

CSP `frame-ancestors` takes precedence over `X-Frame-Options`, as browsers do. Bare
hosts default to `https://` and fall back to `http://` if the host only speaks plain HTTP.
Local, link-local and private addresses are refused unless `ALLOW_PRIVATE=1`.

The frame itself is sandboxed (`allow-scripts allow-same-origin allow-forms allow-popups`),
which also neutralises script-based frame busting.

## Running any website: the rendering proxy

Many sites (Google, GitHub, banks, most logged-in apps) send `X-Frame-Options` or CSP
`frame-ancestors` so browsers refuse to show them inside another page. The **Load** control
under the URL bar decides what happens then:

| Mode | Behaviour |
| --- | --- |
| Auto (default) | Load directly; if the header check says the site refuses framing, render it through `/api/proxy` instead |
| Direct | Never proxy. Sites that refuse framing show a notice on the device |
| Proxied | Always render through `/api/proxy` |

`GET /api/proxy?url=…` fetches the document server-side, drops the framing/CSP/cookie
headers, injects `<base href>` so images, CSS and scripts load straight from the original
site, and injects a small runtime that keeps links, forms, `history`, `fetch`, `XHR` and
`window.open` inside the proxy. CSS fetched through the proxy has its `url()`s made
absolute; everything else (JSON, images, fonts, media) streams through untouched. The same
SSRF guard as the header check applies, and the proxy refuses to load itself.

Limits: no cookies are stored or replayed, so logged-in views show as logged out; service
workers are disabled; sites that verify their own origin in script may misbehave. The
verdict says "via proxy" whenever this mode was used.

## Geometry

All dimensions are in millimetres, scaled by one CSS custom property (`--mm`) that the
script sets from the available width. Numbers come from Apple's published tech specs
(announced 9 September 2026):

| | Closed | Open |
| --- | --- | --- |
| Size | 84.1 × 117.8 × 11.3 mm | 164.6 × 117.8 × 5.2 mm |
| Display | 5.4″ · 2034 × 1398 · 460 ppi | 7.6″ · 2670 × 1878 · 430 ppi |
| Active area (derived) | 77.2 × 112.3 mm | 157.7 × 110.9 mm |
| Emulated web viewport | 466 × 678 CSS px @3x | 890 × 626 CSS px @3x |

The body is two slabs of stacked rounded layers plus flat edge faces; the hinge is a
half-cylinder of slats that morphs from flush (open) to spine (closed). The folding half
rotates about an axis offset by half the hinge gap so the closed stack lands at 11.3 mm.

## Controls

- Drag horizontally on the stage to fold; release to snap open/closed or free-stop in the
  middle range like the real hinge. Click to toggle. Arrow keys nudge, Space toggles.
- Closed / Flex / Open buttons and the hinge slider set the angle directly.
- Night Sky / Star White switch the finish. "Turn around" shows the rear cameras.
- `?url=…` in the address bar loads a site on arrival, so results can be shared. Without
  it the page opens with jayeshbidani.com (`DEFAULT_URL` near the end of `app.js`).
- Motion follows Apple's fluid-interface guidance: springs are critically damped by
  default and only bounce after a flick, release velocity is handed to the spring,
  the landing angle is projected from momentum, and dragging past a stop rubber-bands.

Unofficial fan-made tool, not affiliated with Apple. Jayesh would be very happy if Apple
gave him one for free 🙂
