// ===========================================================================
// crop.js — an interactive pan/zoom cropper.
//
// Cover art is stored locally and only uploaded when the user shares, so we can
// afford to keep the image at the exact shape it will be shown at. The cropper
// shows a fixed-aspect window over the chosen photo: drag to reposition,
// pinch / wheel / slider to zoom, and "Use" bakes the visible region into a
// JPEG blob. It opens as its own overlay stacked above whatever modal launched
// it, so the caller's UI (and any half-filled form) is left untouched.
// ===========================================================================

import { el, icon } from "./util.js";

const MAX_ZOOM = 5;

function bake(img, view, aspect, outWidth) {
  const scale = view.cover * view.z;
  const sx = -view.ox / scale;
  const sy = -view.oy / scale;
  const sw = view.W / scale;
  const sh = view.H / scale;
  const outH = Math.max(1, Math.round(outWidth / aspect));
  const canvas = document.createElement("canvas");
  canvas.width = outWidth;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outWidth, outH);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.86));
}

// Open the cropper for `blob`. Resolves with a cropped JPEG Blob, or null if the
// user cancelled.
export function openCropper(blob, { aspect = 1.7, title = "Adjust image" } = {}) {
  return new Promise((resolve) => {
    const root = document.getElementById("modalRoot") || document.body;
    const url = URL.createObjectURL(blob);
    const view = { iw: 0, ih: 0, W: 0, H: 0, cover: 1, z: 1, ox: 0, oy: 0 };

    const img = el("img", { class: "crop-img", alt: "", draggable: "false", src: url });
    const grid = el("div", { class: "crop-grid", "aria-hidden": "true" });
    const stage = el("div", { class: "crop-stage", style: { aspectRatio: String(aspect) } }, [img, grid]);

    const slider = el("input", { class: "crop-zoom", type: "range", min: "0", max: "1000", value: "0", "aria-label": "Zoom" });
    const outBtn = el("button", { class: "icon-btn crop-step", type: "button", "aria-label": "Zoom out", html: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 11h14v2H5z" fill="currentColor"/></svg>' });
    const inBtn = el("button", { class: "icon-btn crop-step", type: "button", "aria-label": "Zoom in", html: icon("plus", { size: 18 }) });
    const resetBtn = el("button", { class: "chip ghost", type: "button" }, ["Reset"]);
    const tools = el("div", { class: "crop-tools" }, [outBtn, slider, inBtn, resetBtn]);

    const cancelBtn = el("button", { class: "btn btn-ghost", type: "button" }, ["Cancel"]);
    const useBtn = el("button", { class: "btn btn-primary", type: "button" }, ["Use image"]);
    const actions = el("div", { class: "crop-actions" }, [cancelBtn, useBtn]);

    const panel = el("div", { class: "modal-panel cropper-panel" }, [
      el("div", { class: "modal-head" }, [
        el("h2", { class: "modal-title", text: title }),
        el("div", { class: "crop-hint", text: "Drag to reposition · pinch or scroll to zoom" }),
      ]),
      el("div", { class: "modal-body" }, [stage, tools, actions]),
    ]);
    const overlay = el("div", { class: "modal-overlay cropper-overlay" }, [panel]);

    let done = false;
    let observer = null;

    const finish = (val) => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      if (observer) observer.disconnect();
      try { URL.revokeObjectURL(url); } catch (e) {}
      overlay.classList.remove("open");
      setTimeout(() => overlay.remove(), 220);
      resolve(val);
    };

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        finish(null);
      }
    };

    // --- geometry ---------------------------------------------------------
    const clamp = () => {
      const s = view.cover * view.z;
      const dw = view.iw * s;
      const dh = view.ih * s;
      view.ox = Math.min(0, Math.max(view.W - dw, view.ox));
      view.oy = Math.min(0, Math.max(view.H - dh, view.oy));
    };
    const render = () => {
      const s = view.cover * view.z;
      img.style.width = view.iw * s + "px";
      img.style.height = view.ih * s + "px";
      img.style.left = view.ox + "px";
      img.style.top = view.oy + "px";
    };
    const layout = (reset) => {
      if (!view.iw) return;
      // clientWidth/Height read the layout box, so they're unaffected by the
      // modal's open animation transform — measuring mid-animation with
      // getBoundingClientRect would leave the image a couple of percent short.
      const r = { width: stage.clientWidth, height: stage.clientHeight };
      if (r.width < 2 || r.height < 2) return;
      const cx = view.W ? (view.ox + view.W / 2) / (view.cover * view.z) : view.iw / 2;
      const cy = view.H ? (view.oy + view.H / 2) / (view.cover * view.z) : view.ih / 2;
      view.W = r.width;
      view.H = r.height;
      view.cover = Math.max(view.W / view.iw, view.H / view.ih);
      if (reset) {
        view.z = 1;
      } else {
        // Keep the same spot centred when the window changes size.
        view.ox = view.W / 2 - cx * view.cover * view.z;
        view.oy = view.H / 2 - cy * view.cover * view.z;
      }
      setSlider();
      clamp();
      render();
    };
    const setSlider = () => { slider.value = String(Math.round((Math.log(view.z) / Math.log(MAX_ZOOM)) * 1000)); };

    const zoomTo = (next, px, py) => {
      next = Math.min(MAX_ZOOM, Math.max(1, next));
      if (px == null) { px = view.W / 2; py = view.H / 2; }
      if (next === view.z) return;
      const ix = (px - view.ox) / (view.cover * view.z);
      const iy = (py - view.oy) / (view.cover * view.z);
      view.z = next;
      view.ox = px - ix * view.cover * view.z;
      view.oy = py - iy * view.cover * view.z;
      setSlider();
      clamp();
      render();
    };

    // --- interaction ------------------------------------------------------
    const pointers = new Map();
    let drag = null;
    let pinch = null;
    const pair = () => {
      const [a, b] = [...pointers.values()];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      return { dist: Math.max(1, Math.hypot(dx, dy)), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    };
    const local = (e) => {
      const r = stage.getBoundingClientRect();
      // View coordinates are relative to the padding box (the img's containing
      // block), so drop the border; the panel has no transform once it's open.
      return { x: e.clientX - r.left - stage.clientLeft, y: e.clientY - r.top - stage.clientTop };
    };

    stage.addEventListener("pointerdown", (e) => {
      if (done) return;
      try { stage.setPointerCapture(e.pointerId); } catch (err) {}
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        drag = { x: e.clientX, y: e.clientY, ox: view.ox, oy: view.oy };
        stage.classList.add("dragging");
      } else if (pointers.size === 2) {
        drag = null;
        const p = pair();
        const l = local({ clientX: p.mx, clientY: p.my });
        pinch = {
          dist: p.dist,
          z: view.z,
          ix: (l.x - view.ox) / (view.cover * view.z),
          iy: (l.y - view.oy) / (view.cover * view.z),
        };
      }
    });
    stage.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId) || done) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1 && drag) {
        view.ox = drag.ox + (e.clientX - drag.x);
        view.oy = drag.oy + (e.clientY - drag.y);
        clamp();
        render();
      } else if (pointers.size === 2 && pinch) {
        const p = pair();
        const l = local({ clientX: p.mx, clientY: p.my });
        const nz = Math.min(MAX_ZOOM, Math.max(1, pinch.z * (p.dist / pinch.dist)));
        view.z = nz;
        view.ox = l.x - pinch.ix * view.cover * nz;
        view.oy = l.y - pinch.iy * view.cover * nz;
        setSlider();
        clamp();
        render();
      }
    });
    const endPointer = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 0) { drag = null; stage.classList.remove("dragging"); }
      else if (pointers.size === 1) {
        const [p] = [...pointers.values()];
        drag = { x: p.x, y: p.y, ox: view.ox, oy: view.oy };
      }
    };
    stage.addEventListener("pointerup", endPointer);
    stage.addEventListener("pointercancel", endPointer);
    stage.addEventListener("pointerleave", endPointer);
    stage.addEventListener("wheel", (e) => {
      if (done) return;
      e.preventDefault();
      const l = local(e);
      zoomTo(view.z * Math.exp(-e.deltaY * 0.0015), l.x, l.y);
    }, { passive: false });

    slider.addEventListener("input", () => {
      zoomTo(Math.pow(MAX_ZOOM, Number(slider.value) / 1000));
    });
    outBtn.addEventListener("click", () => zoomTo(view.z / 1.25));
    inBtn.addEventListener("click", () => zoomTo(view.z * 1.25));
    resetBtn.addEventListener("click", () => {
      view.z = 1;
      setSlider();
      clamp();
      render();
      view.ox = (view.W - view.iw * view.cover) / 2;
      view.oy = (view.H - view.ih * view.cover) / 2;
      clamp();
      render();
    });

    cancelBtn.addEventListener("click", () => finish(null));
    useBtn.addEventListener("click", async () => {
      if (done) return;
      useBtn.disabled = true;
      const label = useBtn.textContent;
      useBtn.textContent = "Saving…";
      try {
        const outW = Math.min(1600, Math.max(720, Math.round(view.W / (view.cover * view.z))));
        const out = await bake(img, view, aspect, outW);
        if (!out) throw new Error("encode failed");
        finish(out);
      } catch (err) {
        useBtn.disabled = false;
        useBtn.textContent = label;
      }
    });

    const onReady = () => {
      view.iw = img.naturalWidth || 1;
      view.ih = img.naturalHeight || 1;
      view.z = 1;
      view.W = 0;
      // Centre the image the first time.
      view.W = Math.max(2, stage.clientWidth);
      view.H = Math.max(2, stage.clientHeight);
      view.cover = Math.max(view.W / view.iw, view.H / view.ih);
      view.ox = (view.W - view.iw * view.cover) / 2;
      view.oy = (view.H - view.ih * view.cover) / 2;
      clamp();
      render();
      if (typeof ResizeObserver === "function") {
        observer = new ResizeObserver(() => layout(false));
        observer.observe(stage);
      }
    };
    if (img.complete && img.naturalWidth) onReady();
    else img.addEventListener("load", onReady, { once: true });
    img.addEventListener("error", () => finish(null), { once: true });

    root.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("open"));
    document.addEventListener("keydown", onKey, true);
  });
}
