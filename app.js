(function () {
  "use strict";

  const BOOK = window.BOOK || { title: "FoodLi", subtitle: "ספר המתכונים שלי" };
  const RAW = Array.isArray(window.RECIPES) ? window.RECIPES : [];

  document.documentElement.lang = "he";
  document.documentElement.dir = "rtl";

  // ---------- data ----------
  const chapterOrder = (BOOK.chapters || []).slice();
  RAW.forEach(r => { if (r.category && !chapterOrder.includes(r.category)) chapterOrder.push(r.category); });
  const recipes = RAW
    .map((r, i) => ({ ...r, id: r.id || "r" + (i + 1), _i: i }))
    .sort((a, b) => (chapterOrder.indexOf(a.category) - chapterOrder.indexOf(b.category)) || (a._i - b._i));
  const chapters = chapterOrder.filter(c => recipes.some(r => r.category === c));

  // units: what one "turn" shows. Cover, TOC, then one per recipe.
  const units = [{ type: "cover" }, { type: "toc" }].concat(recipes.map(r => ({ type: "recipe", r })));
  const chIndex = c => Math.max(0, chapterOrder.indexOf(c)) % 6;
  const chClass = c => "ch-" + chIndex(c);
  // the same six chapter colors as style.css, for the Story canvas
  const CH_COLORS = ["#ff7a59", "#f2a516", "#22b386", "#8b6cf0", "#ef5f9b", "#3d9bf0"];

  // ---------- helpers ----------
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const $ = id => document.getElementById(id);
  const wideMQ = window.matchMedia("(min-width: 900px) and (min-height: 560px)");
  const reduceMQ = window.matchMedia("(prefers-reduced-motion: reduce)");
  const stage = $("stage");
  const isSub = l => String(l).trim().endsWith(":");
  const countIngredients = r => (r.ingredients || []).filter(l => !isSub(l)).length;
  const tipsOf = r => Array.isArray(r.tips) ? r.tips : (r.tips ? [r.tips] : []);

  let current = 0;
  let query = "";
  let activeChapter = "";
  let busy = false;

  // ======================================================
  //  Photos
  //  Inside claude.ai: uploaded to the artifact (shared with everyone who opens the book).
  //  Anywhere else: kept in this browser only (IndexedDB).
  // ======================================================
  const photos = {};           // recipeId -> display url
  let canUpload = false;
  let store = null;            // { save(id, blob), remove(id) }
  let photoNote = "";

  recipes.forEach(r => { if (r.photo) photos[r.id] = r.photo; });

  async function initClaudeStore() {
    const [db, assets] = await Promise.all([window.claude.use("db"), window.claude.use("assets")]);
    if (db) {
      db.collection("photos").onSnapshot(snap => {
        snap.docs.forEach(d => { const a = d.exists && d.data() && d.data().asset; if (typeof a === "string" && /^[0-9a-f]{32}$/.test(a)) photos[d.id] = "/_blob/" + a; });
        snap.docChanges().forEach(ch => { if (ch.type === "removed") { const r = recipes.find(x => x.id === ch.doc.id); if (r && r.photo) photos[ch.doc.id] = r.photo; else delete photos[ch.doc.id]; } });
        refreshPhotos();
      }, () => {});
    }
    if (db && assets) {
      canUpload = true;
      store = {
        async save(id, blob) {
          const res = await assets.upload(blob, { type: "image/jpeg" });
          await db.collection("photos").doc(id).set({ asset: res.id, updatedAt: Date.now() });
          photos[id] = res.url;
        },
        async remove(id) { await db.collection("photos").doc(id).delete(); delete photos[id]; }
      };
      refreshPhotos();
    }
  }

  function idb() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open("foodli", 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore("photos");
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  }
  async function initLocalStore() {
    try {
      const d = await idb();
      const tx = d.transaction("photos", "readonly").objectStore("photos");
      await new Promise(res => {
        const c = tx.openCursor();
        c.onsuccess = () => { const cur = c.result; if (!cur) return res(); photos[cur.key] = URL.createObjectURL(cur.value); cur.continue(); };
        c.onerror = () => res();
      });
      const put = (id, v) => new Promise((res, rej) => {
        const t = d.transaction("photos", "readwrite"); const s = t.objectStore("photos");
        v ? s.put(v, id) : s.delete(id);
        t.oncomplete = res; t.onerror = () => rej(t.error);
      });
      canUpload = true;
      photoNote = "התמונות נשמרות בדפדפן הזה בלבד.";
      store = {
        async save(id, blob) { await put(id, blob); photos[id] = URL.createObjectURL(blob); },
        async remove(id) { await put(id, null); const r = recipes.find(x => x.id === id); if (r && r.photo) photos[id] = r.photo; else delete photos[id]; }
      };
      refreshPhotos();
    } catch (e) { /* no storage: photos stay read-only */ }
  }

  if (window.claude && typeof window.claude.use === "function") initClaudeStore();
  else initLocalStore();

  // shrink a picked photo to a sensible size before storing it
  function shrinkImage(file, max = 1600) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement("canvas");
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(b => b ? res(b) : rej(new Error("encode")), "image/jpeg", 0.86);
      };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("decode")); };
      img.src = url;
    });
  }

  let pendingPhotoFor = null;
  const photoInput = $("photo-input");
  photoInput.addEventListener("change", async () => {
    const file = photoInput.files && photoInput.files[0];
    const id = pendingPhotoFor;
    photoInput.value = "";
    if (!file || !id || !store) return;
    setPhotoBusy(id, "מעלה תמונה…");
    try {
      await store.save(id, await shrinkImage(file));
      refreshPhotos();
    } catch (e) {
      const code = e && e.code;
      setPhotoBusy(id, code === "too_large" ? "התמונה גדולה מדי. נסי תמונה אחרת." :
        code === "quota_or_state" ? "אין מקום לעוד תמונות." :
        code === "decode" || (e && e.message === "decode") ? "לא הצלחתי לקרוא את הקובץ. נסי תמונה בפורמט JPG או PNG." :
        "ההעלאה לא הצליחה. נסי שוב בעוד רגע.", true);
    }
  });

  function setPhotoBusy(id, msg, isError) {
    stage.querySelectorAll(`[data-photo-for="${id}"] .polaroid-msg`).forEach(n => { n.textContent = msg; n.classList.toggle("error", !!isError); });
  }

  function polaroidHTML(r) {
    const url = photos[r.id];
    const controls = canUpload
      ? (url
        ? `<div class="photo-tools"><button type="button" class="mini-btn" data-photo-pick="${esc(r.id)}">החלפה</button><button type="button" class="mini-btn" data-photo-remove="${esc(r.id)}">הסרה</button></div>`
        : "")
      : "";
    const inner = url
      ? `<img src="${esc(url)}" alt="${esc(r.title)}" loading="lazy">`
      : canUpload
        ? `<button type="button" class="photo-empty" data-photo-pick="${esc(r.id)}">
             <svg viewBox="0 0 48 48" aria-hidden="true"><rect x="6" y="13" width="36" height="26" rx="5" fill="none" stroke="currentColor" stroke-width="2.5"/><circle cx="24" cy="26" r="7" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M17 13l3-5h8l3 5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/></svg>
             <span>הוסיפי תמונה של המנה</span>${photoNote ? `<small>${esc(photoNote)}</small>` : ""}
           </button>`
        : `<div class="photo-empty static"><span>${esc(r.title)}</span></div>`;
    return `<figure class="polaroid${url ? " has-photo" : ""}" data-photo-for="${esc(r.id)}">
      <span class="tape" aria-hidden="true"></span>
      <div class="polaroid-img">${inner}</div>
      <figcaption>${url ? esc(r.title) : ""}<span class="polaroid-msg" role="status"></span></figcaption>
      ${controls}
    </figure>`;
  }

  function refreshPhotos() {
    stage.querySelectorAll("[data-photo-for]").forEach(fig => {
      const r = recipes.find(x => x.id === fig.dataset.photoFor);
      if (r) fig.outerHTML = polaroidHTML(r);
    });
    stage.querySelectorAll("[data-thumb-for]").forEach(t => {
      const url = photos[t.dataset.thumbFor];
      if (url && !t.querySelector("img")) t.innerHTML = `<img src="${esc(url)}" alt="" loading="lazy">`;
      if (!url && t.querySelector("img")) t.textContent = t.dataset.letter || "";
    });
    if (units[current].type === "cover") { const c = stage.querySelector(".cover-photos"); if (c) c.outerHTML = coverPhotosHTML(); }
  }

  // ======================================================
  //  Page content
  // ======================================================
  function coverPhotosHTML() {
    const ids = recipes.filter(r => photos[r.id]).slice(0, 3);
    if (!ids.length) return `<div class="cover-photos" aria-hidden="true"></div>`;
    return `<div class="cover-photos" aria-hidden="true">${ids.map((r, i) =>
      `<span class="cover-pol p${i}"><img src="${esc(photos[r.id])}" alt=""></span>`).join("")}</div>`;
  }

  function coverHTML() {
    const stickers = chapters.map((c, i) => `<span class="cover-sticker ${chClass(c)} s${i % 6}">${esc(c)}</span>`).join("");
    return `<section class="page cover">
      ${coverPhotosHTML()}
      <div class="cover-body">
        <span class="cover-eyebrow">${esc(BOOK.subtitle || "")}</span>
        <h1>${esc(BOOK.title)}</h1>
        <div class="cover-stickers">${stickers}</div>
        <p class="cover-count">${recipes.length} מתכונים שאני אוהבת</p>
        <button class="sticker-btn primary big" type="button" data-go="1">לפתוח את הספר</button>
      </div>
    </section>`;
  }

  function tocListHTML() {
    const q = query.trim();
    const parts = [];
    chapters.forEach(ch => {
      if (activeChapter && ch !== activeChapter) return;
      const items = recipes
        .map((r, k) => ({ r, unit: k + 2 }))
        .filter(x => x.r.category === ch)
        .filter(x => !q || [x.r.title, x.r.intro, (x.r.ingredients || []).join(" ")].join(" ").includes(q));
      if (!items.length) return;
      parts.push(`<section class="toc-group ${chClass(ch)}"><h3><span>${esc(ch)}</span></h3><ul>${items.map(x => {
        const n = countIngredients(x.r);
        const sub = x.r.time || (n ? n + " מצרכים" : (x.r.link ? "בסרטון" : ""));
        const url = photos[x.r.id];
        const letter = x.r.title.trim().charAt(0);
        return `<li><button class="toc-row" type="button" data-go="${x.unit}">
          <span class="thumb" data-thumb-for="${esc(x.r.id)}" data-letter="${esc(letter)}">${url ? `<img src="${esc(url)}" alt="" loading="lazy">` : esc(letter)}</span>
          <span class="toc-text"><span class="toc-title">${esc(x.r.title)}</span>${sub ? `<span class="toc-sub">${esc(sub)}</span>` : ""}</span>
        </button></li>`;
      }).join("")}</ul></section>`);
    });
    return parts.length ? parts.join("") : `<p class="empty">לא מצאתי מתכון כזה. אפשר לנסות מילה אחרת.</p>`;
  }

  function tocParts() {
    const a = `<div class="page-inner toc-head">
      <h2 class="display">מה מבשלים<br>היום?</h2>
      <div class="search-wrap">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M20 20l-4-4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
        <input class="search" id="search" type="search" aria-label="חיפוש מתכון" placeholder="מתכון או מצרך…" value="${esc(query)}" autocomplete="off">
      </div>
      <div class="chapters" role="group" aria-label="פרקים">
        <button class="chapter-chip" type="button" data-chapter="" aria-pressed="${!activeChapter}">הכול</button>
        ${chapters.map(c => `<button class="chapter-chip ${chClass(c)}" type="button" data-chapter="${esc(c)}" aria-pressed="${activeChapter === c}">${esc(c)}</button>`).join("")}
      </div>
      <p class="note-hand">בתוך מתכון אפשר לסמן מצרכים ושלבים, להוסיף תמונה ולשתף לסטורי</p>
    </div>`;
    const b = `<div class="page-inner"><div class="toc-list" id="toc-list">${tocListHTML()}</div></div>`;
    return [a, b];
  }

  function recipeBlocks(r) {
    const meta = [r.time, r.servings].filter(Boolean);
    const ings = (r.ingredients || []).map((line, i) => {
      const s = String(line).trim();
      if (isSub(s)) return `<li class="sub">${esc(s.slice(0, -1))}</li>`;
      return `<li><label><input type="checkbox" id="ing-${esc(r.id)}-${i}"><span>${esc(s)}</span></label></li>`;
    }).join("");
    const tips = tipsOf(r);
    const hasLink = /^https:\/\//.test(r.link || "");
    return {
      head: `<header class="recipe-head">
          <span class="chapter-badge">${esc(r.category || "")}</span>
          <h2 class="display recipe-title">${esc(r.title)}</h2>
          ${meta.length ? `<p class="meta">${meta.map(m => `<span>${esc(m)}</span>`).join("")}</p>` : ""}
          <button class="sticker-btn share-btn" type="button" data-story="${esc(r.id)}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="2.5" width="14" height="19" rx="3.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/></svg>
            שיתוף לסטורי
          </button>
        </header>`,
      photo: polaroidHTML(r),
      intro: r.intro ? `<p class="intro">${esc(r.intro)}</p>` : "",
      ingredients: ings ? `<section class="block"><h3 class="block-title"><span>מה צריך</span></h3><ul class="ingredients">${ings}</ul></section>` : "",
      steps: `<section class="block">
          ${(r.steps || []).length || !hasLink ? `<h3 class="block-title"><span>איך מכינים</span></h3>` : ""}
          ${(r.steps || []).length
            ? `<ol class="steps">${r.steps.map((s, i) => `<li tabindex="0"><b aria-hidden="true">${i + 1}</b><span>${esc(s)}</span></li>`).join("")}</ol>`
            : (hasLink ? "" : `<p class="empty">אופן ההכנה עוד לא נכתב.</p>`)}
          ${hasLink ? `<a class="sticker-btn primary video-link" href="${esc(r.link)}" target="_blank" rel="noopener">${esc(r.linkLabel || "למתכון המלא בסרטון")}</a>` : ""}
        </section>`,
      tips: tips.length ? `<aside class="sticky-note">${tips.map(t => `<p>${esc(t)}</p>`).join("")}</aside>` : "",
      source: r.source ? `<p class="source">מקור: ${esc(r.source)}</p>` : ""
    };
  }

  const unitClass = idx => units[idx].type === "recipe" ? chClass(units[idx].r.category) : "";

  // ---------- rendering ----------
  function buildWide(idx) {
    const u = units[idx];
    if (u.type === "cover") return `<div class="book closed">${coverHTML()}</div>`;
    let a, b;
    if (u.type === "toc") [a, b] = tocParts();
    else {
      const k = recipeBlocks(u.r);
      a = `<div class="page-inner">${k.head}${k.photo}${k.intro}${k.tips}${k.source}</div>`;
      b = `<div class="page-inner">${k.ingredients}${k.steps}</div>`;
    }
    return `<div class="book ${unitClass(idx)}">
      <section class="page right">${a}</section>
      <section class="page left">${b}</section>
    </div>`;
  }

  function buildNarrow(idx) {
    const u = units[idx];
    if (u.type === "cover") return coverHTML().replace('class="page cover"', 'class="page cover sheet fade"');
    let inner;
    if (u.type === "toc") inner = tocParts().join("");
    else {
      const k = recipeBlocks(u.r);
      inner = `<div class="page-inner">${k.head}${k.photo}${k.intro}${k.ingredients}${k.steps}${k.tips}${k.source}</div>`;
    }
    return `<section class="page sheet fade ${unitClass(idx)}">${inner}</section>`;
  }

  function render(idx) {
    $("story-modal").hidden = true;
    stage.innerHTML = wideMQ.matches ? buildWide(idx) : buildNarrow(idx);
    updateControls();
  }

  function updateControls() {
    $("prev").disabled = current === 0;
    $("next").disabled = current === units.length - 1;
    const u = units[current];
    $("folio").textContent = u.type === "cover" ? ""
      : u.type === "toc" ? "תוכן העניינים"
      : `${current - 1} מתוך ${recipes.length}`;
    $("go-toc").hidden = u.type === "toc";
    $("wake").hidden = !("wakeLock" in navigator) || u.type !== "recipe";
    document.body.className = unitClass(current) || "ch-0";
  }

  function setHash() {
    const u = units[current];
    const h = u.type === "cover" ? "" : u.type === "toc" ? "#toc" : "#" + u.r.id;
    try { history.replaceState(null, "", h || location.pathname + location.search); } catch (e) { /* ignore */ }
  }

  function unitFromHash() {
    const h = decodeURIComponent((location.hash || "").slice(1));
    if (!h) return 0;
    if (h === "toc") return 1;
    const k = recipes.findIndex(r => r.id === h);
    return k >= 0 ? k + 2 : 0;
  }

  // ---------- page turning ----------
  function animate(el, from, to, ms) {
    return new Promise(res => {
      if (!el.animate) return res();
      const a = el.animate([{ transform: from }, { transform: to }], { duration: ms, easing: "ease-in-out", fill: "forwards" });
      a.onfinish = res; a.oncancel = res;
    });
  }

  function leaf(pageEl, side, extra) {
    const d = document.createElement("div");
    d.className = "leaf on-" + side + (extra ? " " + extra : "");
    const c = pageEl.cloneNode(true);
    c.querySelectorAll("[id]").forEach(n => n.removeAttribute("id"));
    const sc = pageEl.scrollTop;
    d.appendChild(c);
    requestAnimationFrame(() => { c.scrollTop = sc; });
    return d;
  }

  async function go(idx) {
    idx = Math.max(0, Math.min(units.length - 1, idx));
    if (idx === current || busy) return;
    const forward = idx > current;
    const wide = wideMQ.matches;
    const canFlip = wide && !reduceMQ.matches && units[current].type !== "cover" && units[idx].type !== "cover";

    if (!canFlip) {
      current = idx; render(current); setHash();
      if (!wide) window.scrollTo({ top: 0 });
      return;
    }

    busy = true;
    const oldBook = stage.querySelector(".book");
    const oldR = oldBook.querySelector(".page.right");
    const oldL = oldBook.querySelector(".page.left");
    const l1 = leaf(forward ? oldL : oldR, forward ? "left" : "right");
    const st = leaf(forward ? oldR : oldL, forward ? "right" : "left", "static");

    current = idx;
    render(current);
    const book = stage.querySelector(".book");
    book.append(st, l1);
    await animate(l1, "rotateY(0deg)", forward ? "rotateY(90deg)" : "rotateY(-90deg)", 260);
    l1.remove();
    const l2 = leaf(book.querySelector(forward ? ".page.right" : ".page.left"), forward ? "right" : "left");
    l2.style.zIndex = 4;
    book.append(l2);
    await animate(l2, forward ? "rotateY(-90deg)" : "rotateY(90deg)", "rotateY(0deg)", 260);
    l2.remove(); st.remove();
    setHash();
    busy = false;
  }

  // ======================================================
  //  Story image (1080 × 1920)
  // ======================================================
  function wrapLines(ctx, text, maxW) {
    const words = String(text).split(/\s+/); const lines = []; let line = "";
    words.forEach(w => {
      const t = line ? line + " " + w : w;
      if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
    });
    if (line) lines.push(line);
    return lines;
  }

  function loadImage(src) {
    return new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  async function makeStory(r) {
    const W = 1080, H = 1920;
    const color = CH_COLORS[chIndex(r.category)];
    try {
      await Promise.all(["700 120px Karantina", "700 60px 'Amatic SC'", "600 40px Assistant", "800 40px Assistant"].map(f => document.fonts.load(f)));
    } catch (e) { /* fall back to system fonts */ }
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    ctx.direction = "rtl";

    // gingham tablecloth
    ctx.fillStyle = "#fffaf4"; ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 0.16; ctx.fillStyle = color;
    for (let x = 0; x < W; x += 96) ctx.fillRect(x, 0, 48, H);
    for (let y = 0; y < H; y += 96) ctx.fillRect(0, y, W, 48);
    ctx.globalAlpha = 1;

    // brand
    ctx.textAlign = "center"; ctx.fillStyle = "#2a2234";
    ctx.font = "700 64px Karantina, sans-serif";
    ctx.fillText(BOOK.title, W / 2, 120);

    let y = 170;
    const items = (r.ingredients || []).map(s => String(s).trim()).filter(s => s && !isSub(s));
    const imgSrc = photos[r.id];
    const img = imgSrc ? await loadImage(imgSrc) : null;
    if (img) {
      // polaroid
      const pw = items.length > 12 ? 700 : 820, ph = items.length > 12 ? 560 : 700, px = (W - pw) / 2;
      ctx.save(); ctx.translate(W / 2, y + ph / 2); ctx.rotate(-0.035); ctx.translate(-W / 2, -(y + ph / 2));
      ctx.shadowColor = "rgba(40,30,50,.25)"; ctx.shadowBlur = 40; ctx.shadowOffsetY = 18;
      ctx.fillStyle = "#ffffff"; ctx.fillRect(px, y, pw, ph); ctx.shadowColor = "transparent";
      const iw = pw - 60, ih = ph - 140, ix = px + 30, iy = y + 30;
      const k = Math.max(iw / img.naturalWidth, ih / img.naturalHeight);
      const sw = iw / k, sh = ih / k;
      ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, ix, iy, iw, ih);
      ctx.fillStyle = "#2a2234"; ctx.font = "700 58px 'Amatic SC', sans-serif";
      ctx.fillText(r.title, W / 2, y + ph - 40);
      ctx.restore();
      // washi tape
      ctx.save(); ctx.translate(W / 2, y + 4); ctx.rotate(0.06);
      ctx.globalAlpha = 0.8; ctx.fillStyle = color; ctx.fillRect(-120, -26, 240, 52); ctx.restore();
      y += ph + 70;
    } else {
      y += 60;
    }

    // title + meta
    const titleSize = img ? (items.length > 12 ? 110 : 130) : 190;
    ctx.font = `700 ${titleSize}px Karantina, sans-serif`;
    const titleLines = wrapLines(ctx, r.title, W - 160).slice(0, 2);
    const metaLine = [r.category, r.time, r.servings].filter(Boolean).join("  ·  ");
    const headH = titleLines.length * titleSize * 0.85 + 20 + (metaLine ? 70 : 0) + 50;

    // ingredients layout (measured first so the card hugs its content)
    const cardX = 90, cardW = W - 180, footer = 150, pad = 210;
    const maxH = H - footer - y - headH - pad;
    let colW = 0;
    const layout = (size, cols, truncate) => {
      colW = (cardW - 112 - (cols - 1) * 40) / cols;
      ctx.font = `600 ${size}px Assistant, sans-serif`;
      const lh = size * 1.32; const per = items.map(t => wrapLines(ctx, t, colW - 34));
      const colsOut = [[]]; const heights = [0];
      for (let i = 0; i < per.length; i++) {
        const need = per[i].length * lh + size * 0.35;
        if (heights[heights.length - 1] + need > maxH) {
          if (colsOut.length >= cols) {
            if (!truncate) return null;
            colsOut[colsOut.length - 1].pop();   // make room for the "and N more" line
            colsOut[colsOut.length - 1].push([`ועוד ${per.length - i + 1} מצרכים בספר…`]);
            break;
          }
          colsOut.push([]); heights.push(0);
        }
        colsOut[colsOut.length - 1].push(per[i]); heights[heights.length - 1] += need;
      }
      return { colsOut, lh, size, used: Math.max(...heights) };
    };
    let L = null;
    if (items.length && maxH > 80) {
      // one column if it fits in large type, otherwise two columns, shrinking the type as needed
      for (let fs = 42; fs >= 36 && !L; fs -= 2) L = layout(fs, 1);
      for (let fs = 40; fs >= 30 && !L; fs -= 2) L = layout(fs, 2);
      if (!L) L = layout(30, 2, true);
    }
    const cardH = L ? pad + L.used : 0;
    if (!img) y = 170 + Math.max(0, (H - footer - 170 - headH - cardH) / 2);

    ctx.fillStyle = "#2a2234"; ctx.textAlign = "center";
    ctx.font = `700 ${titleSize}px Karantina, sans-serif`;
    titleLines.forEach(l => { y += titleSize * 0.85; ctx.fillText(l, W / 2, y); });
    y += 20;
    if (metaLine) { ctx.fillStyle = color; ctx.font = "700 60px 'Amatic SC', sans-serif"; y += 70; ctx.fillText(metaLine, W / 2, y); }
    y += 50;

    if (L) {
      ctx.save(); ctx.shadowColor = "rgba(40,30,50,.12)"; ctx.shadowBlur = 30; ctx.shadowOffsetY = 10;
      ctx.fillStyle = "#ffffff"; roundRect(ctx, cardX, y, cardW, cardH, 36); ctx.fill(); ctx.restore();
      ctx.textAlign = "right"; ctx.fillStyle = "#2a2234"; ctx.font = "700 84px Karantina, sans-serif";
      const hw = ctx.measureText("מה צריך").width;
      ctx.fillText("מה צריך", cardX + cardW - 56, y + 104);
      ctx.fillStyle = color; ctx.fillRect(cardX + cardW - 56 - hw, y + 116, hw, 10);
      const top = y + 170;
      L.colsOut.forEach((col, ci) => {
        const xr = cardX + cardW - 56 - ci * (colW + 40);
        let yy = top;
        col.forEach(ls => {
          ctx.fillStyle = color; ctx.beginPath(); ctx.arc(xr - 8, yy + L.size * 0.62, 7, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = "#2a2234"; ctx.font = `600 ${L.size}px Assistant, sans-serif`;
          ls.forEach(l => { ctx.fillText(l, xr - 30, yy + L.size); yy += L.lh; });
          yy += L.size * 0.35;
        });
      });
    }
    // footer
    ctx.textAlign = "center"; ctx.fillStyle = "#2a2234"; ctx.font = "700 56px 'Amatic SC', sans-serif";
    ctx.fillText("מתוך ספר המתכונים שלי · " + BOOK.title, W / 2, H - 70);

    return new Promise(res => cv.toBlob(b => res(b), "image/png"));
  }

  let storyBlob = null, storyRecipe = null, storyUrl = null;
  async function openStory(id) {
    const r = recipes.find(x => x.id === id); if (!r) return;
    storyRecipe = r; storyBlob = null;
    const modal = $("story-modal");
    $("story-preview").innerHTML = `<span class="loading">מכינה את התמונה…</span>`;
    $("story-status").textContent = "";
    $("story-save").disabled = true;
    modal.hidden = false;
    $("story-close").focus();
    storyBlob = await makeStory(r);
    if (storyUrl) URL.revokeObjectURL(storyUrl);
    storyUrl = URL.createObjectURL(storyBlob);
    $("story-preview").innerHTML = `<img src="${storyUrl}" alt="סטורי של ${esc(r.title)}">`;
    $("story-save").disabled = false;
  }

  async function saveStory() {
    if (!storyBlob) return;
    const filename = `${storyRecipe.id}-story.png`;
    const status = $("story-status");
    const downloads = window.claude && window.claude.use ? await window.claude.use("downloads") : null;
    if (downloads) {
      try { await downloads.save({ filename, data: storyBlob }); status.textContent = "נשמר. עכשיו אפשר להעלות אותו לסטורי."; }
      catch (e) { status.textContent = e && e.code === "declined" ? "" : "לא הצלחתי לשמור כאן. לחיצה ארוכה על התמונה תשמור אותה."; }
      return;
    }
    const file = new File([storyBlob], filename, { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: storyRecipe.title }); return; } catch (e) { if (e && e.name === "AbortError") return; }
    }
    const a = document.createElement("a"); a.href = storyUrl; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    status.textContent = "התמונה ירדה למכשיר.";
  }

  function closeStory() { $("story-modal").hidden = true; }
  $("story-close").addEventListener("click", closeStory);
  $("story-save").addEventListener("click", saveStory);
  $("story-modal").addEventListener("click", e => { if (e.target.id === "story-modal") closeStory(); });

  // ---------- events ----------
  $("prev").addEventListener("click", () => go(current - 1));
  $("next").addEventListener("click", () => go(current + 1));
  $("go-toc").addEventListener("click", () => go(1));
  $("go-cover").addEventListener("click", () => go(0));
  $("go-cover").textContent = BOOK.title;

  stage.addEventListener("click", async e => {
    const g = e.target.closest("[data-go]");
    if (g) { go(+g.dataset.go); return; }
    const story = e.target.closest("[data-story]");
    if (story) { openStory(story.dataset.story); return; }
    const pick = e.target.closest("[data-photo-pick]");
    if (pick) { pendingPhotoFor = pick.dataset.photoPick; photoInput.click(); return; }
    const rm = e.target.closest("[data-photo-remove]");
    if (rm && store) {
      const id = rm.dataset.photoRemove;
      if (rm.dataset.confirm !== "1") { rm.dataset.confirm = "1"; rm.textContent = "להסיר?"; return; }
      try { await store.remove(id); refreshPhotos(); } catch (err) { setPhotoBusy(id, "ההסרה לא הצליחה.", true); }
      return;
    }
    const ch = e.target.closest("[data-chapter]");
    if (ch) {
      activeChapter = ch.dataset.chapter;
      stage.querySelectorAll("[data-chapter]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.chapter === activeChapter)));
      const list = $("toc-list"); if (list) list.innerHTML = tocListHTML();
      return;
    }
    const step = e.target.closest(".steps li");
    if (step) step.classList.toggle("done");
  });
  stage.addEventListener("keydown", e => {
    const step = e.target.closest && e.target.closest(".steps li");
    if (step && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); step.classList.toggle("done"); }
  });
  stage.addEventListener("input", e => {
    if (e.target.id !== "search") return;
    query = e.target.value;
    const list = $("toc-list"); if (list) list.innerHTML = tocListHTML();
  });

  document.addEventListener("keydown", e => {
    if (!$("story-modal").hidden) { if (e.key === "Escape") closeStory(); return; }
    if (e.target.matches && e.target.matches("input, textarea")) return;
    if (e.key === "ArrowLeft") go(current + 1);      // RTL: left is forward
    else if (e.key === "ArrowRight") go(current - 1);
  });

  // swipe on phones: swipe right = next page (Hebrew books open to the left)
  let sx = null, sy = null;
  stage.addEventListener("touchstart", e => { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; }, { passive: true });
  stage.addEventListener("touchend", e => {
    if (sx == null) return;
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    sx = sy = null;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.8) go(current + (dx > 0 ? 1 : -1));
  }, { passive: true });

  window.addEventListener("hashchange", () => { const u = unitFromHash(); if (u !== current) { current = u; render(current); } });
  wideMQ.addEventListener && wideMQ.addEventListener("change", () => render(current));

  // keep the screen on while cooking
  let lock = null;
  const wakeBtn = $("wake");
  if ("wakeLock" in navigator) {
    const setPressed = on => { wakeBtn.setAttribute("aria-pressed", String(on)); wakeBtn.textContent = on ? "המסך דולק" : "מסך דולק"; };
    const acquire = async () => {
      try { lock = await navigator.wakeLock.request("screen"); setPressed(true); lock.addEventListener("release", () => { if (!document.hidden) setPressed(false); }); }
      catch (e) { lock = null; setPressed(false); wakeBtn.textContent = "לא זמין"; }
    };
    wakeBtn.addEventListener("click", async () => {
      if (lock) { const l = lock; lock = null; try { await l.release(); } catch (e) { /* ignore */ } setPressed(false); }
      else acquire();
    });
    document.addEventListener("visibilitychange", () => { if (!document.hidden && wakeBtn.getAttribute("aria-pressed") === "true") acquire(); });
  }

  current = unitFromHash();
  render(current);
})();
