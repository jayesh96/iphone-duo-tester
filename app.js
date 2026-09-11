/* iPhone Duo Lab — fold animation, interaction and URL tester. */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const DEG = Math.PI / 180;
  // Momentum projection (scroll-style exponential decay) and rubber-banding.
  const project = (v, d = 0.995) => ((v / 1000) * d) / (1 - d);
  const rubberband = (offset, dimension, c = 0.55) => (offset * dimension * c) / (dimension + c * Math.abs(offset));
  // Header-check endpoint. A host that cannot run it (static hosting) can set
  // data-api="" on the script tag; the tester then loads sites directly.
  const API_URL = document.currentScript && document.currentScript.dataset.api !== undefined
    ? document.currentScript.dataset.api
    : 'api/check';

  // Published geometry, in millimetres. See the spec sheet on the page.
  const SPEC = {
    W: 164.6, H: 117.8, HW: 82.3, T: 5.2, A: 0.45,
    closedW: 84.1, closedT: 11.3,
    innerW: 157.7, innerH: 110.9, innerPx: [2670, 1878], innerVw: 890, innerVh: 626,
    outerW: 77.2, outerH: 112.3, outerPx: [1398, 2034], outerVw: 466, outerVh: 678,
  };

  const stage = $('#stage');
  const rig = $('#rig');
  const phone = $('#phone');
  const floorShadow = $('#floor-shadow');
  const range = $('#fold-range');
  const rangeOut = $('#fold-out');
  const flipBtn = $('#flip-btn');
  const screens = {
    inner: $('#screen-inner'),
    outer: $('#screen-outer'),
  };
  const frames = {
    inner: $('#frame-inner'),
    outer: $('#frame-outer'),
  };
  const ro = {
    state: $('#ro-state'),
    size: $('#ro-size'),
    display: $('#ro-display'),
    viewport: $('#ro-viewport'),
  };

  const state = {
    mm: 4,
    fold: 180,          // degrees; 0 = open, 180 = closed
    target: 180,
    vel: 0,
    zeta: 1,            // spring damping ratio: 1 = no overshoot, 0.8 after a flick
    over: 0,            // rubber-band overshoot past the hinge stops, in degrees
    dragging: false,
    settled: true,
    flipped: false,
    tilt: { x: 6, y: -16 },
    tiltTarget: { x: 6, y: -16 },
    innerActive: false,
    outerActive: false,
    reduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  };

  /* ---------------------------------------------------------------------- */
  /* Sizing                                                                 */
  /* ---------------------------------------------------------------------- */

  function fitStage() {
    const w = stage.clientWidth || 800;
    const mm = clamp((w - 28) / 178, 1.6, 4.4);
    state.mm = mm;
    stage.style.setProperty('--mm', mm.toFixed(3) + 'px');
    // Scale each display's iframe so that its CSS viewport matches the device
    // (physical pixels ÷ 3, like every 3x iPhone).
    screens.inner.style.setProperty('--k', ((SPEC.innerW * mm) / SPEC.innerVw).toFixed(5));
    screens.outer.style.setProperty('--k', ((SPEC.outerW * mm) / SPEC.outerVw).toFixed(5));
    apply(true);
  }

  /* ---------------------------------------------------------------------- */
  /* Fold geometry → CSS variables                                          */
  /* ---------------------------------------------------------------------- */

  function apply(force) {
    const fold = state.fold;
    const th = fold * DEG;
    const mm = state.mm;
    const HW = SPEC.HW * mm;
    const cos = Math.cos(th);
    const sin = Math.sin(th);
    const t = fold / 180;

    phone.style.setProperty('--fold', fold.toFixed(3) + 'deg');

    // Keep the visual centre of the body in the middle of the stage.
    const leftExtent = -HW * Math.max(cos, 0);
    const centre = (leftExtent + HW) / 2;
    phone.style.setProperty('--shift', (-centre).toFixed(2) + 'px');

    // Hinge: a half-cylinder that sits flush inside the body when open and
    // becomes the spine when closed.
    phone.style.setProperty('--hx', (-2.8 * sin * mm).toFixed(3) + 'px');
    phone.style.setProperty('--hz', ((-SPEC.T / 2 + (SPEC.T / 2 + SPEC.A * 2) * t) * mm).toFixed(3) + 'px');
    phone.style.setProperty('--hr', ((SPEC.T / 2 + (SPEC.T / 2 + SPEC.A * 2) * Math.pow(t, 1.5)) * mm).toFixed(3) + 'px');
    phone.style.setProperty('--hphi', (180 + fold / 2).toFixed(3) + 'deg');

    shadeFaces();

    // Floor shadow follows the footprint.
    const footprint = HW + HW * Math.max(cos, 0);
    floorShadow.style.setProperty('--sw', (footprint * 1.15 + 40).toFixed(1) + 'px');
    floorShadow.style.setProperty('--sx', (-centre + (footprint - SPEC.W * mm) / 2 + HW - footprint / 2).toFixed(1) + 'px');

    // Which display is live?
    const innerActive = fold < 6;
    const outerActive = fold > 174;
    if (innerActive !== state.innerActive || force) {
      state.innerActive = innerActive;
      phone.classList.toggle('inner-active', innerActive);
      if (innerActive) ensureLoaded('inner');
    }
    if (outerActive !== state.outerActive || force) {
      state.outerActive = outerActive;
      phone.classList.toggle('outer-active', outerActive);
      if (outerActive) ensureLoaded('outer');
    }

    // Slider + readout.
    if (!state.sliderActive) range.value = fold.toFixed(1);
    rangeOut.value = Math.round(fold) + '°';
    updateReadout(fold, th);
  }

  // Lighting: darken each face as its normal turns away from the viewer,
  // taking both the hinge angle and the rig's yaw into account.
  function shadeFaces() {
    const yaw = state.tilt.y;
    const shade = (normalYaw) => {
      const facing = Math.cos((normalYaw + yaw) * DEG);
      return clamp(0.6 * (1 - facing) / 2, 0, 0.6).toFixed(3);
    };
    phone.style.setProperty('--shade-lf', shade(-state.fold));
    phone.style.setProperty('--shade-lb', shade(180 - state.fold));
    phone.style.setProperty('--shade-rf', shade(0));
    phone.style.setProperty('--shade-rb', shade(180));
  }

  function updateReadout(fold, th) {
    let label, size;
    if (fold <= 0.5) {
      label = 'Open';
      size = `${SPEC.W} × ${SPEC.H} × ${SPEC.T} mm`;
    } else if (fold >= 179.5) {
      label = 'Closed';
      size = `${SPEC.closedW} × ${SPEC.H} × ${SPEC.closedT} mm`;
    } else {
      label = state.dragging || !state.settled ? `Folding · ${Math.round(fold)}°` : `Flex mode · ${Math.round(fold)}°`;
      const w = fold <= 90 ? SPEC.HW + SPEC.HW * Math.cos(th) : SPEC.closedW;
      const d = fold < 90 ? SPEC.T + SPEC.HW * Math.sin(th) : Math.max(SPEC.closedT, SPEC.T + SPEC.HW * Math.sin(th));
      size = `≈ ${w.toFixed(1)} × ${SPEC.H} × ${d.toFixed(1)} mm`;
    }
    ro.state.textContent = label;
    ro.size.textContent = size;
    if (state.innerActive) {
      ro.display.textContent = `Inner · 7.6″ · ${SPEC.innerPx[0]} × ${SPEC.innerPx[1]}`;
      ro.viewport.textContent = `${SPEC.innerVw} × ${SPEC.innerVh} CSS px @3x`;
    } else if (state.outerActive) {
      ro.display.textContent = `Outer · 5.4″ · ${SPEC.outerPx[0]} × ${SPEC.outerPx[1]}`;
      ro.viewport.textContent = `${SPEC.outerVw} × ${SPEC.outerVh} CSS px @3x`;
    } else {
      ro.display.textContent = 'Folding · displays sleep';
      ro.viewport.textContent = '—';
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Animation loop: spring towards target, ease the rig tilt               */
  /* ---------------------------------------------------------------------- */

  let last = performance.now();
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (!state.dragging && !state.sliderActive) {
      // Spring in Apple's terms: response ≈ 0.5 s; damping ratio 1.0 by
      // default (no overshoot), 0.8 only after a gesture that carried momentum.
      const k = state.reduced ? 600 : Math.pow((2 * Math.PI) / 0.5, 2);
      const c = 2 * Math.sqrt(k) * (state.reduced ? 1 : state.zeta);
      const dx = state.fold - state.target;
      const a = -k * dx - c * state.vel;
      state.vel += a * dt;
      state.fold += state.vel * dt;
      if (state.fold < 0) { state.fold = 0; state.vel *= -0.25; }
      if (state.fold > 180) { state.fold = 180; state.vel *= -0.25; }
      if (Math.abs(state.fold - state.target) < 0.04 && Math.abs(state.vel) < 0.8) {
        state.fold = state.target;
        state.vel = 0;
        if (!state.settled) { state.settled = true; }
      } else {
        state.settled = false;
      }
      apply();
    }

    // Tilt easing. Any rubber-band overshoot relaxes back once released.
    if (!state.dragging) state.over += (0 - state.over) * Math.min(1, dt * 8);
    const ty = state.tiltTarget.y + (state.flipped ? 180 : 0) + state.over * 0.12;
    state.tilt.x += (state.tiltTarget.x - state.tilt.x) * Math.min(1, dt * 6);
    state.tilt.y += (ty - state.tilt.y) * Math.min(1, dt * 6);
    rig.style.setProperty('--tx', state.tilt.x.toFixed(3) + 'deg');
    rig.style.setProperty('--ty', state.tilt.y.toFixed(3) + 'deg');
    shadeFaces();

    requestAnimationFrame(loop);
  }

  function setTarget(deg, opts = {}) {
    state.target = clamp(deg, 0, 180);
    state.zeta = opts.bounce ? 0.8 : 1;
    state.settled = false;
    syncSegments();
  }

  function syncSegments() {
    $$('.seg [data-fold]').forEach((b) => {
      b.classList.toggle('active', Math.abs(Number(b.dataset.fold) - state.target) < 0.5);
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Interaction: buttons, slider, drag, keyboard, parallax                 */
  /* ---------------------------------------------------------------------- */

  $$('.seg [data-fold]').forEach((b) => {
    b.addEventListener('click', () => { touched(); setTarget(Number(b.dataset.fold)); });
  });

  range.addEventListener('pointerdown', () => { state.sliderActive = true; touched(); });
  range.addEventListener('input', () => {
    state.sliderActive = true;
    state.fold = Number(range.value);
    state.target = state.fold;
    state.vel = 0;
    apply();
  });
  const releaseSlider = () => {
    if (!state.sliderActive) return;
    state.sliderActive = false;
    state.target = Number(range.value);
    state.settled = true;
    syncSegments();
    apply();
  };
  range.addEventListener('change', releaseSlider);
  window.addEventListener('pointerup', releaseSlider);

  $$('.seg [data-color]').forEach((b) => {
    b.addEventListener('click', () => setColor(b.dataset.color));
  });
  function setColor(c) {
    phone.dataset.color = c;
    stage.dataset.color = c;
    $$('.seg [data-color]').forEach((b) => b.classList.toggle('active', b.dataset.color === c));
    try { localStorage.setItem('duo-color', c); } catch {}
  }

  flipBtn.addEventListener('click', () => {
    state.flipped = !state.flipped;
    flipBtn.setAttribute('aria-pressed', String(state.flipped));
    flipBtn.textContent = state.flipped ? 'Turn back' : 'Turn around';
    touched();
  });

  function touched() { stage.classList.add('touched'); }

  // Drag to fold. Dragging on the interactive screen contents is left alone so
  // the previewed site stays usable.
  const drag = { active: false, id: null, startX: 0, startFold: 0, lastX: 0, lastT: 0, moved: false, vel: 0 };
  const isInteractive = (el) => !!el.closest('iframe, a, button, input, .viewer, .notice');

  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || isInteractive(e.target)) return;
    drag.active = true;
    drag.id = e.pointerId;
    drag.startX = drag.lastX = e.clientX;
    drag.startFold = state.fold;
    drag.lastT = performance.now();
    drag.moved = false;
    drag.vel = 0;
    state.dragging = true;
    stage.classList.add('dragging');
    stage.setPointerCapture(e.pointerId);
    touched();
  });

  stage.addEventListener('pointermove', (e) => {
    if (drag.active && e.pointerId === drag.id) {
      const dx = e.clientX - drag.startX;
      if (Math.abs(dx) > 4) drag.moved = true;
      const travel = 2 * SPEC.HW * state.mm; // the free edge travels twice the half width
      const dir = state.flipped ? -1 : 1;
      const raw = drag.startFold + (dx / travel) * 180 * dir;
      const next = clamp(raw, 0, 180);
      // Past either stop the hinge resists instead of freezing: the body yaws
      // a little with the drag, and progressively less the further you go.
      state.over = rubberband(raw - next, 180, 0.55);
      const now = performance.now();
      const dt = Math.max(1, now - drag.lastT) / 1000;
      const v = (next - state.fold) / dt;
      drag.vel = drag.vel * 0.6 + v * 0.4;
      drag.lastT = now;
      drag.lastX = e.clientX;
      state.fold = next;
      state.target = next;
      apply();
      return;
    }
    // Parallax when hovering.
    if (e.pointerType === 'mouse') {
      const r = stage.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      state.tiltTarget = { x: 6 - py * 10, y: -16 + px * 18 };
    }
  });

  const endDrag = (e) => {
    if (!drag.active || e.pointerId !== drag.id) return;
    drag.active = false;
    state.dragging = false;
    stage.classList.remove('dragging');
    if (!drag.moved) {
      // Plain click: toggle.
      setTarget(state.fold < 90 ? 180 : 0);
    } else {
      // Project where the momentum would carry the hinge; snap to a stop if
      // that lands near one, otherwise free-stop there like the real hinge.
      // The spring starts at the finger's velocity, so there is no seam.
      const projected = state.fold + project(drag.vel);
      let target;
      if (projected < 36) target = 0;
      else if (projected > 144) target = 180;
      else target = clamp(projected, 36, 144);
      setTarget(target, { bounce: true });
      state.vel = clamp(drag.vel, -900, 900);
    }
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('pointerleave', () => { if (!drag.active) state.tiltTarget = { x: 6, y: -16 }; });

  stage.addEventListener('keydown', (e) => {
    if (e.target !== stage) return;
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setTarget(state.target < 90 ? 180 : 0); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); setTarget(state.target - 10); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); setTarget(state.target + 10); }
    else return;
    touched();
  });

  /* ---------------------------------------------------------------------- */
  /* Clock                                                                  */
  /* ---------------------------------------------------------------------- */

  function tickClock() {
    const d = new Date();
    let h = d.getHours() % 12; if (h === 0) h = 12;
    const time = `${h}:${String(d.getMinutes()).padStart(2, '0')}`;
    const date = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    $$('[data-time]').forEach((el) => { el.textContent = time; });
    $$('[data-date]').forEach((el) => { el.textContent = date; });
  }
  tickClock();
  setInterval(tickClock, 15000);

  /* ---------------------------------------------------------------------- */
  /* URL tester                                                             */
  /* ---------------------------------------------------------------------- */

  const form = $('#url-form');
  const input = $('#url-input');
  const clearBtn = $('#url-clear');
  const testBtn = $('#test-btn');
  const verdict = $('#verdict');
  const verdictTitle = $('#verdict-title');
  const verdictDetail = $('#verdict-detail');
  const verdictChips = $('#verdict-chips');

  const site = { token: 0, url: null, src: null, proxied: false, result: null, unverified: false, loadedAt: {}, startedAt: 0, watchdog: null, lastInput: '' };

  // How to load a site: 'auto' falls back to the rendering proxy when a site
  // refuses to be embedded, 'direct' never proxies, 'proxy' always does.
  const modeBox = $('#mode');
  const modeHint = $('#mode-hint');
  const PROXY_URL = API_URL ? API_URL.replace(/check$/, 'proxy') : '';
  let mode = 'auto';
  try { mode = localStorage.getItem('duo-mode') || 'auto'; } catch {}
  if (!['auto', 'direct', 'proxy'].includes(mode)) mode = 'auto';
  const MODE_HINTS = {
    auto: 'Sites that refuse embedding are rendered through this site’s proxy.',
    direct: 'Loads the site exactly as a browser would. Sites that refuse embedding show a notice.',
    proxy: 'Always renders through this site’s proxy. Works for almost any site; logins and some scripts may not.',
  };
  function setMode(m) {
    mode = m;
    $$('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
    modeHint.textContent = MODE_HINTS[m];
    try { localStorage.setItem('duo-mode', m); } catch {}
  }
  $$('[data-mode]').forEach((b) => b.addEventListener('click', () => { setMode(b.dataset.mode); if (site.lastInput) run(site.lastInput); }));
  if (!PROXY_URL) modeBox.hidden = true; else setMode(mode);

  input.addEventListener('input', () => { clearBtn.hidden = !input.value; });
  clearBtn.addEventListener('click', () => { input.value = ''; clearBtn.hidden = true; input.focus(); });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    run(input.value);
  });

  function normalizeClient(raw) {
    let s = String(raw || '').trim();
    if (!s) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
    try {
      const u = new URL(s);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u;
    } catch { return null; }
  }

  function setScreens(stateName, payload) {
    for (const key of ['inner', 'outer']) {
      const sc = screens[key];
      sc.dataset.state = stateName;
      if (payload) {
        $('.notice-title', sc).textContent = payload.title || '';
        $('.notice-text', sc).innerHTML = payload.html || '';
        const link = $('.notice-link', sc);
        if (payload.href) { link.href = payload.href; link.hidden = false; } else { link.hidden = true; }
      }
    }
  }

  function setVerdict(kind, title, detailHtml, chips) {
    verdict.hidden = false;
    verdict.dataset.kind = kind;
    verdictTitle.textContent = title;
    verdictDetail.innerHTML = detailHtml || '';
    verdictChips.innerHTML = '';
    (chips || []).forEach(([label, value]) => {
      const el = document.createElement('span');
      el.className = 'chip';
      if (value === undefined) el.textContent = label;
      else { el.innerHTML = `<b></b> `; el.firstChild.textContent = label; el.append(String(value)); }
      verdictChips.appendChild(el);
    });
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function run(raw) {
    const u = normalizeClient(raw);
    if (!u) {
      setVerdict('error', 'That does not look like a web address', 'Try something like <code>example.com</code> or a full <code>https://</code> URL.');
      input.focus();
      return;
    }
    const token = ++site.token;
    site.lastInput = raw;
    site.url = null;
    site.result = null;
    site.unverified = false;
    clearTimeout(site.watchdog);
    input.value = u.href.replace(/^https:\/\//, '').replace(/\/$/, '');
    clearBtn.hidden = false;
    testBtn.disabled = true;
    setScreens('checking', { title: '', html: '', href: null });
    setVerdict('checking', `Checking ${u.hostname}…`, 'Fetching the page headers to see whether it can be shown inside another site.');
    try { history.replaceState(null, '', `?url=${encodeURIComponent(u.href)}`); } catch {}
    touched();

    let result = null;
    let apiMissing = !API_URL;
    if (API_URL) try {
      const r = await fetch(`${API_URL}?url=${encodeURIComponent(String(raw).trim())}`, { headers: { accept: 'application/json' } });
      const isJson = (r.headers.get('content-type') || '').includes('json');
      if (!isJson) apiMissing = true;
      else {
        result = await r.json();
        if (token !== site.token) return;
        if (!r.ok || result.error) {
          testBtn.disabled = false;
          showError(u, result.error || 'Unexpected error.');
          return;
        }
      }
    } catch {
      apiMissing = true;
    }
    if (token !== site.token) return;
    testBtn.disabled = false;

    if (apiMissing) {
      site.unverified = true;
      load(u.href);
      setVerdict('unknown', `Loading ${u.hostname} without a header check`,
        'This host cannot inspect the site’s headers, so the site is loaded directly. If the screen stays blank, the site refuses to be embedded (X-Frame-Options or CSP).');
      return;
    }

    site.result = result;
    const finalHost = new URL(result.url).hostname;
    const useProxy = !!PROXY_URL && (mode === 'proxy' || (mode === 'auto' && !result.embeddable));
    if (!result.embeddable && !useProxy) {
      showBlocked(result, finalHost);
      return;
    }
    load(result.url, useProxy);
    const kind = result.ok ? 'checking' : 'warn';
    const how = useProxy
      ? (result.embeddable ? 'Rendering through the proxy as requested.' : `The site sends <code>${esc(result.reason)}</code>, so it is rendered through this site’s proxy instead.`)
      : 'Headers allow embedding. Waiting for the page to render on the device.';
    setVerdict(kind, result.ok ? `Loading ${finalHost}…` : `${finalHost} responds with HTTP ${result.status}`,
      result.ok ? how : 'The server returned an error status. Rendering whatever it sent.',
      chipsFor(result));
  }

  function chipsFor(result, extra) {
    const chips = [];
    chips.push(['HTTP', `${result.status}${result.statusText ? ' ' + result.statusText : ''}`]);
    chips.push(['Headers', `${result.timeMs} ms`]);
    if (extra && extra.renderMs != null) chips.push(['Rendered in', `${extra.renderMs} ms`]);
    if (result.redirects && result.redirects.length) {
      chips.push([`${result.redirects.length} redirect${result.redirects.length > 1 ? 's' : ''} →`, new URL(result.url).host]);
    }
    if (result.contentType) chips.push(['Type', result.contentType.split(';')[0]]);
    if (result.headers && result.headers.xFrameOptions) chips.push(['X-Frame-Options', result.headers.xFrameOptions]);
    if (result.headers && result.headers.contentSecurityPolicy) {
      const fa = /frame-ancestors[^;]*/i.exec(result.headers.contentSecurityPolicy);
      if (fa) chips.push(['CSP', fa[0].trim()]);
    }
    if (result.headers && result.headers.server) chips.push(['Server', result.headers.server]);
    return chips;
  }

  function showBlocked(result, host) {
    site.url = null;
    const title = 'Can’t be shown here';
    const html = `<code>${esc(host)}</code> sends <code>${esc(result.reason)}</code>, which tells browsers not to display it inside another site. It is reachable (HTTP ${esc(result.status)}) — it just refuses to be embedded, so it can’t be previewed on this device.`;
    setScreens('blocked', { title, html, href: result.url });
    setVerdict('blocked', `${host} works, but refuses to be embedded`,
      `The site responds normally, but its <code>${esc(result.reason)}</code> header blocks framing. ${PROXY_URL ? 'Switch Load to <b>Auto</b> or <b>Proxied</b> to render it through this site’s proxy, or ' : 'That is a deliberate security choice by the site, so it cannot be previewed here. '}<a href="${esc(result.url)}" target="_blank" rel="noopener noreferrer">open it in a new tab</a>.`,
      chipsFor(result));
  }

  function showError(u, message) {
    site.url = null;
    setScreens('error', { title: 'Couldn’t reach it', html: esc(message), href: u.href });
    setVerdict('error', `${u.hostname} is not working`, esc(message) + ` <a href="${esc(u.href)}" target="_blank" rel="noopener noreferrer">Try it in a new tab</a>.`);
  }

  function load(url, proxied = false) {
    site.url = url;
    site.proxied = !!proxied;
    site.src = proxied ? `${PROXY_URL}?url=${encodeURIComponent(url)}` : url;
    site.loadedAt = {};
    site.startedAt = performance.now();
    for (const key of ['inner', 'outer']) frames[key].dataset.src = '';
    setScreens('loading', { title: '', html: '', href: null });
    ensureLoaded('inner');
    ensureLoaded('outer');
    clearTimeout(site.watchdog);
    site.watchdog = setTimeout(() => {
      if (!site.url) return;
      const anyLoaded = Object.keys(site.loadedAt).length > 0;
      if (!anyLoaded) {
        setVerdict('warn', 'Still loading…',
          'The page has not finished rendering after 20 seconds. It may be very slow, or it may be blocking frames with a script rather than a header.',
          site.result ? chipsFor(site.result) : []);
      }
    }, 20000);
  }

  // Load the current URL into a display's frame the first time that display is shown.
  function ensureLoaded(key) {
    if (!site.url) return;
    const active = key === 'inner' ? state.innerActive : state.outerActive;
    if (!active) return;
    const fr = frames[key];
    if (fr.dataset.src === site.src) return;
    fr.dataset.src = site.src;
    screens[key].dataset.state = 'loading';
    fr.src = site.src;
  }

  // A host whose own Content-Security-Policy forbids embedding other sites
  // (frame-src) reports the block here rather than in the frame, so the
  // page can say so instead of showing an empty screen.
  let hostBlocked = false;
  document.addEventListener('securitypolicyviolation', (e) => {
    if (!/^(frame|child)-src$/.test(e.violatedDirective) || !site.url) return;
    if (!e.blockedURI || e.blockedURI === 'about' || !site.url.startsWith(e.blockedURI.replace(/\/$/, ''))) {
      if (!e.blockedURI.startsWith(new URL(site.url).origin)) return;
    }
    hostBlocked = true;
    const host = new URL(site.url).hostname;
    site.url = null;
    setScreens('error', {
      title: 'This host can’t embed sites',
      html: `The page you are viewing is hosted somewhere whose security policy forbids embedding other websites, so <code>${esc(host)}</code> cannot be shown on the device here. Run the full version from the repository to test it.`,
      href: null,
    });
    setVerdict('error', 'Preview blocked by this host, not by the site',
      `This hosted copy is not allowed to embed other websites at all. It says nothing about <code>${esc(host)}</code>. Run the full version (see the repository README) to get a real verdict.`);
  });

  for (const key of ['inner', 'outer']) {
    frames[key].addEventListener('load', () => {
      const fr = frames[key];
      if (hostBlocked || !site.url || fr.dataset.src !== site.src) return;
      if (site.proxied) {
        // Proxied documents are same-origin, so the proxy's own error pages
        // can be recognised and shown as a device notice.
        let err = null;
        try { err = fr.contentDocument && fr.contentDocument.documentElement.dataset.duoError; } catch {}
        if (err) {
          const u = new URL(site.url);
          const s = site.result;
          setScreens('error', { title: 'Couldn’t render it', html: esc(err), href: site.url });
          setVerdict('error', `${u.hostname} could not be rendered`, esc(err) + (s ? ` The site itself answered HTTP ${s.status} to the header check.` : ''), s ? chipsFor(s) : []);
          site.url = null;
          return;
        }
      }
      screens[key].dataset.state = 'live';
      const first = Object.keys(site.loadedAt).length === 0;
      site.loadedAt[key] = performance.now();
      if (!first) return;
      const renderMs = Math.round(site.loadedAt[key] - site.startedAt);
      const host = new URL(site.url).hostname;
      if (site.unverified) {
        setVerdict('unknown', `${host} loaded (unverified)`,
          'The frame finished loading, but without the header check this page cannot tell a real page from a browser “refused to connect” screen. Check the display.',
          [['Rendered in', `${renderMs} ms`]]);
      } else if (site.result) {
        const r = site.result;
        const where = `on the ${state.innerActive ? '7.6″ inner' : '5.4″ outer'} display. Fold the device to see it on the other screen.`;
        const via = site.proxied
          ? (r.embeddable ? `Rendered through the proxy ${where}` : `The site refuses to be embedded (<code>${esc(r.reason)}</code>), so it was rendered through this site’s proxy ${where} Logins and some scripts may not work in this mode.`)
          : `Headers allow embedding and the page rendered ${where}`;
        setVerdict(r.ok ? 'ok' : 'warn',
          r.ok ? `${host} works on iPhone Duo${site.proxied ? ' (via proxy)' : ''}` : `${host} renders, but with HTTP ${r.status}`,
          r.ok ? via : 'The page rendered, but the server reported an error status.',
          chipsFor(r, { renderMs }));
      }
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Boot                                                                   */
  /* ---------------------------------------------------------------------- */

  try { setColor(localStorage.getItem('duo-color') || 'night'); } catch { setColor('night'); }
  syncSegments();
  fitStage();
  window.addEventListener('resize', fitStage);
  requestAnimationFrame((t) => { last = t; loop(t); });

  const params = new URLSearchParams(location.search);
  // Site shown on arrival when no ?url= is given.
  const DEFAULT_URL = 'jayeshbidani.com';
  const initial = params.get('url') || DEFAULT_URL;
  if (initial) { input.value = initial; clearBtn.hidden = false; }

  // Opening demo.
  setTimeout(() => {
    setTarget(0);
    if (initial) run(initial);
  }, state.reduced ? 100 : 700);
})();
