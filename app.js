(function () {
  "use strict";

  // Shared books are on when firebase-config.js holds a config (and we are not inside claude.ai)
  const CLOUD_CONFIG = window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey && !window.claude ? window.FIREBASE_CONFIG : null;
  const DEFAULT_CHAPTERS = ["מרקים", "עיקריות", "תוספות", "סלטים", "מאפים", "עוגות", "עוגיות", "קינוחים"];

  document.documentElement.lang = "he";
  document.documentElement.dir = "rtl";

  // ---------- data: the book that is open ----------
  let BOOK = {}, chapterOrder = [], recipes = [], chapters = [];
  // units: what one "turn" shows. Cover, TOC, then one per recipe.
  let units = [{ type: "cover" }, { type: "toc" }];
  const createdSec = r => (r.createdAt && r.createdAt.seconds) || 1e12;

  function setBook(book, list, keepPhotos) {
    BOOK = book || {};
    list = list || [];
    chapterOrder = (BOOK.chapters && BOOK.chapters.length ? BOOK.chapters : DEFAULT_CHAPTERS).slice();
    list.forEach(r => { if (r.category && !chapterOrder.includes(r.category)) chapterOrder.push(r.category); });
    recipes = list
      .map((r, i) => ({ ...r, id: r.id || "r" + (i + 1), _i: i }))
      .sort((a, b) => (chapterOrder.indexOf(a.category) - chapterOrder.indexOf(b.category))
        || ((a.order ?? 1e9) - (b.order ?? 1e9)) || (createdSec(a) - createdSec(b)) || (a._i - b._i));
    chapters = chapterOrder.filter(c => recipes.some(r => r.category === c));
    units = [{ type: "cover" }, { type: "toc" }].concat(recipes.map(r => ({ type: "recipe", r })));
    if (!keepPhotos) Object.keys(photos).forEach(k => delete photos[k]);
    recipes.forEach(r => { if (r.photo && !photos[r.id]) photos[r.id] = r.photo; });
  }
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
  let me = null;               // signed-in user (shared books only)
  let openBookId = null;
  const isOwn = () => CLOUD_CONFIG ? !!(me && openBookId === me.uid) : canEditHere();
  const countLabel = n => n === 1 ? "מתכון אחד" : `${n} מתכונים`;
  const isSub = l => String(l).trim().endsWith(":");
  const countIngredients = r => (r.ingredients || []).filter(l => !isSub(l)).length;
  const tipsOf = r => Array.isArray(r.tips) ? r.tips : (r.tips ? [r.tips] : []);

  let view = "book";           // book | login | shelf | loading
  let loadingText = "";
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
  let photosUnavailable = false;

  // Books built into the site (no accounts): recipes.js, plus any extra book files such as friend.js
  const staticBooks = CLOUD_CONFIG ? [] : [
    { id: "main", book: window.BOOK || { title: "FoodLi", subtitle: "ספר המתכונים שלי" }, recipes: window.RECIPES },
    { id: "friend", book: window.FRIEND_BOOK, recipes: window.FRIEND_RECIPES }
  ].filter(b => b.book && Array.isArray(b.recipes));
  staticBooks.forEach(b => { b.builtin = b.recipes; });
  const multiBook = staticBooks.length > 1;
  const hasShelf = !!CLOUD_CONFIG || multiBook;
  let myBookId = null;         // which built-in book belongs to whoever uses this phone
  try { myBookId = localStorage.getItem("foodli-me"); } catch (e) { /* ignore */ }
  if (!staticBooks.some(b => b.id === myBookId)) myBookId = null;

  if (!CLOUD_CONFIG) setBook(staticBooks[0].book, staticBooks[0].recipes);

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
  // ======================================================
  //  Photos on the website
  //  Built-in photos come from the recipe files ("photo"), shared uploads from photos.json in the
  //  repository (written through the GitHub API with a key pasted once on the phone), and photos
  //  added without a key stay in this browser only (IndexedDB).
  // ======================================================
  const GH_REPO = "dekelPK/FoodLi", GH_BRANCH = "master";
  let ghToken = null;
  try { ghToken = localStorage.getItem("foodli-gh-token"); } catch (e) { /* ignore */ }
  const sharedPhotos = {};     // recipeId -> {path, ts}   from photos.json
  const localPhotos = {};      // recipeId -> {url, ts}    from this browser

  function applyPhotos() {
    Object.keys(photos).forEach(k => delete photos[k]);
    staticBooks.forEach(b => b.recipes.forEach(r => { if (r.photo) photos[r.id] = r.photo; }));
    Object.entries(sharedPhotos).forEach(([id, v]) => { photos[id] = v.path; });
    // this phone's own copy wins while it is newer (a fresh upload takes a minute to reach the site)
    Object.entries(localPhotos).forEach(([id, v]) => { if (!sharedPhotos[id] || (v.ts || 0) >= sharedPhotos[id].ts) photos[id] = v.url; });
    refreshPhotos();
  }

  async function loadSharedPhotos() {
    try {
      const map = await readSiteJson("photos.json");
      if (!map) return;
      Object.keys(sharedPhotos).forEach(k => delete sharedPhotos[k]);
      Object.entries(map || {}).forEach(([id, v]) => {
        if (v && typeof v.path === "string" && /^images\/[\w./-]+$/.test(v.path)) sharedPhotos[id] = { path: v.path, ts: Number(v.ts) || 0 };
      });
      applyPhotos();
    } catch (e) { /* offline: keep what we have */ }
  }

  const ghError = status => Object.assign(new Error("github " + status), { code: status === 401 || status === 403 || status === 404 ? "gh_auth" : "gh" });
  async function ghApi(path, opts = {}, token = ghToken) {
    return fetch(`https://api.github.com/repos/${GH_REPO}${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", ...(opts.body ? { "Content-Type": "application/json" } : {}) }
    });
  }
  const toB64 = str => btoa(unescape(encodeURIComponent(str)));
  const fromB64 = b64 => decodeURIComponent(escape(atob(String(b64).replace(/\n/g, ""))));

  // A JSON file of the site. With a key it is read straight from GitHub, so a change made a
  // moment ago shows up before the site has republished; without one, from the site itself.
  async function readSiteJson(path) {
    if (ghToken) {
      try {
        const g = await ghApi(`/contents/${path}?ref=${GH_BRANCH}`, { cache: "no-store" });
        if (g.ok) return JSON.parse(fromB64((await g.json()).content)) || {};
        if (g.status === 404) return {};
      } catch (e) { /* fall back to the site */ }
    }
    const res = await fetch(path + "?t=" + Date.now(), { cache: "no-store" });
    return res.ok ? await res.json() : null;
  }

  const ghUpdatePhotoMap = (change, message) => ghUpdateJsonFile("photos.json", change, message);

  // read a JSON file, change it, write it back (retrying if someone else wrote in between)
  async function ghUpdateJsonFile(path, change, message) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const g = await ghApi(`/contents/${path}?ref=${GH_BRANCH}`, { cache: "no-store" });
      let map = {}, sha;
      if (g.ok) { const j = await g.json(); sha = j.sha; try { map = JSON.parse(fromB64(j.content)) || {}; } catch (e) { map = {}; } }
      else if (g.status !== 404) throw ghError(g.status);
      change(map);
      const p = await ghApi(`/contents/${path}`, { method: "PUT", body: JSON.stringify({ message, branch: GH_BRANCH, content: toB64(JSON.stringify(map, null, 2) + "\n"), ...(sha ? { sha } : {}) }) });
      if (p.ok) return map;
      if (p.status !== 409 && p.status !== 422) throw ghError(p.status);
    }
    throw ghError(409);
  }

  async function ghSavePhoto(id, blob, ts) {
    const r = staticBooks.flatMap(b => b.recipes).find(x => x.id === id);
    const path = `images/uploads/${id}-${ts}.jpg`;
    const content = (await blobToDataURL(blob)).split(",")[1];
    const up = await ghApi(`/contents/${path}`, { method: "PUT", body: JSON.stringify({ message: `תמונה: ${r ? r.title : id}`, branch: GH_BRANCH, content }) });
    if (!up.ok) throw ghError(up.status);
    const old = sharedPhotos[id];
    await ghUpdatePhotoMap(map => { map[id] = { path, ts }; }, `תמונה: ${r ? r.title : id}`);
    sharedPhotos[id] = { path, ts };
    if (old && old.path.startsWith("images/uploads/")) ghDeleteFile(old.path).catch(() => {});
  }

  async function ghDeleteFile(path) {
    const g = await ghApi(`/contents/${path}?ref=${GH_BRANCH}`);
    if (!g.ok) return;
    const { sha } = await g.json();
    await ghApi(`/contents/${path}`, { method: "DELETE", body: JSON.stringify({ message: "הסרת תמונה", sha, branch: GH_BRANCH }) });
  }

  async function ghRemovePhoto(id) {
    const old = sharedPhotos[id];
    await ghUpdatePhotoMap(map => { delete map[id]; }, "הסרת תמונה");
    delete sharedPhotos[id];
    if (old && old.path.startsWith("images/uploads/")) ghDeleteFile(old.path).catch(() => {});
  }

  function setPhotoNote() {
    photoNote = ghToken ? "התמונה תופיע אצל כולן תוך כדקה." : "התמונה נשמרת רק בטלפון הזה.";
  }

  async function initLocalStore() {
    const fromSite = !CLOUD_CONFIG && staticBooks.length > 0;
    if (fromSite) { loadSharedPhotos(); loadAddedRecipes(); }
    try {
      const d = await idb();
      const tx = d.transaction("photos", "readonly").objectStore("photos");
      await new Promise(res => {
        const c = tx.openCursor();
        c.onsuccess = () => {
          const cur = c.result; if (!cur) return res();
          const v = cur.value;   // a Blob (older saves) or {type, buf, ts}
          try { localPhotos[cur.key] = { url: URL.createObjectURL(v instanceof Blob ? v : new Blob([v.buf], { type: v.type || "image/jpeg" })), ts: (v && v.ts) || 0 }; } catch (err) { /* skip a broken entry */ }
          cur.continue();
        };
        c.onerror = () => res();
      });
      const put = (id, v) => new Promise((res, rej) => {
        const t = d.transaction("photos", "readwrite"); const st = t.objectStore("photos");
        v ? st.put(v, id) : st.delete(id);
        t.oncomplete = res; t.onerror = () => rej(t.error);
      });
      canUpload = true;
      setPhotoNote();
      store = {
        // stored as plain bytes: some iPhone versions fail to keep Blobs in IndexedDB
        async save(id, blob) {
          const ts = Date.now();
          await put(id, { type: blob.type || "image/jpeg", buf: await blob.arrayBuffer(), ts });
          localPhotos[id] = { url: URL.createObjectURL(blob), ts };
          applyPhotos();
          if (ghToken) await ghSavePhoto(id, blob, ts);
        },
        async remove(id) {
          if (ghToken && sharedPhotos[id]) await ghRemovePhoto(id);
          await put(id, null);
          delete localPhotos[id];
          applyPhotos();
        },
        // a shared photo can only be taken down by someone holding the key
        canRemove: id => !!localPhotos[id] || (!!ghToken && !!sharedPhotos[id])
      };
      applyPhotos();
    } catch (e) {
      photosUnavailable = true;   // e.g. storage blocked: say so instead of hiding the button silently
      applyPhotos();
    }
  }

  if (CLOUD_CONFIG) { /* photos are loaded per book, see openBook() */ }
  else if (window.claude && typeof window.claude.use === "function") initClaudeStore();
  else initLocalStore();

  // shrink a picked photo to a sensible size before storing it
  function shrinkImage(file, max = 1600, quality = 0.86) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement("canvas");
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(b => b ? res(b) : rej(new Error("encode")), "image/jpeg", quality);
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
      await store.save(id, await shrinkImage(file, CLOUD_CONFIG ? 1100 : 1600));
      refreshPhotos();
    } catch (e) {
      const code = e && e.code;
      setPhotoBusy(id, code === "too_large" ? "התמונה גדולה מדי. נסי תמונה אחרת." :
        code === "quota_or_state" ? "אין מקום לעוד תמונות." :
        code === "decode" || (e && e.message === "decode") ? "לא הצלחתי לקרוא את הקובץ. נסי תמונה בפורמט JPG או PNG." :
        code === "gh_auth" ? "התמונה נשמרה בטלפון, אבל המפתח לשיתוף לא עובד. אפשר לחבר מפתח חדש במדף." :
        code === "gh" ? "התמונה נשמרה בטלפון, אבל השיתוף עם כולן לא הצליח. נסי שוב כשיש אינטרנט." :
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
        ? `<div class="photo-tools"><button type="button" class="mini-btn" data-photo-pick="${esc(r.id)}">החלפה</button>${(store && store.canRemove ? store.canRemove(r.id) : url !== r.photo) ? `<button type="button" class="mini-btn" data-photo-remove="${esc(r.id)}">הסרה</button>` : ""}</div>`
        : "")
      : "";
    const inner = url
      ? `<img src="${esc(url)}" alt="${esc(r.title)}" loading="lazy">`
      : canUpload
        ? `<button type="button" class="photo-empty" data-photo-pick="${esc(r.id)}">
             <svg viewBox="0 0 48 48" aria-hidden="true"><rect x="6" y="13" width="36" height="26" rx="5" fill="none" stroke="currentColor" stroke-width="2.5"/><circle cx="24" cy="26" r="7" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M17 13l3-5h8l3 5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/></svg>
             <span>הוסיפי תמונה של המנה</span>${photoNote ? `<small>${esc(photoNote)}</small>` : ""}
           </button>`
        : photosUnavailable
          ? `<div class="photo-empty"><span>אי אפשר לשמור תמונות בדפדפן הזה</span><small>בדרך כלל זה קורה במצב גלישה פרטית. פתחי את האתר בחלון רגיל ונסי שוב.</small></div>`
          : `<div class="photo-empty static"><span>${esc(r.title)}</span></div>`;
    return `<figure class="polaroid${url ? " has-photo" : ""}" data-photo-for="${esc(r.id)}">
      <span class="tape" aria-hidden="true"></span>
      <div class="polaroid-img">${inner}</div>
      <figcaption>${url ? esc(r.title) : ""}<span class="polaroid-msg" role="status"></span></figcaption>
      ${controls}
    </figure>${canUpload && !CLOUD_CONFIG && !window.claude && !ghToken ? `<button type="button" class="link-btn share-photos-link" data-action="gh-connect">איך משתפים את התמונות עם כולן?</button>` : ""}`;
  }

  function refreshPhotos() {
    stage.querySelectorAll(".recipe-head .head-actions").forEach(h => {
      const r = units[current] && units[current].r; if (!r) return;
      const tmp = document.createElement("div"); tmp.innerHTML = recipeBlocks(r).head;
      const fresh = tmp.querySelector(".head-actions"); if (fresh) h.replaceWith(fresh);
    });
    stage.querySelectorAll("[data-photo-for]").forEach(fig => {
      const r = recipes.find(x => x.id === fig.dataset.photoFor);
      if (!r) return;
      const next = fig.nextElementSibling;
      if (next && next.classList.contains("share-photos-link")) next.remove();
      fig.outerHTML = polaroidHTML(r);
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
        <h1 class="${[...String(BOOK.title || "")].length > 7 ? "long" : ""}">${esc(BOOK.title)}</h1>
        <div class="cover-stickers">${stickers}</div>
        <p class="cover-count">${recipes.length ? `${countLabel(recipes.length)} שאני אוהבת` : "הספר מחכה למתכון הראשון"}</p>
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
    if (!recipes.length) {
      return isOwn()
        ? `<div class="empty-book"><p class="empty">הספר עוד ריק. בואי נוסיף את המתכון הראשון!</p>
            <button class="sticker-btn primary" type="button" data-action="new-recipe">+ מתכון חדש</button>
            ${CLOUD_CONFIG && Array.isArray(window.RECIPES) && window.RECIPES.length ? `<button class="sticker-btn small" type="button" data-action="import">להעתיק לכאן את ${window.RECIPES.length} המתכונים של FoodLi</button>` : ""}</div>`
        : `<p class="empty">עוד אין כאן מתכונים.</p>`;
    }
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
      ${isOwn() ? `<div class="owner-actions">
        <button class="sticker-btn primary" type="button" data-action="new-recipe">+ מתכון חדש</button>
        ${CLOUD_CONFIG ? `<button class="sticker-btn small" type="button" data-action="book-settings">שם וצבע הספר</button>` : ""}
      </div>` : ""}
      <p class="note-hand">בתוך מתכון אפשר לסמן מצרכים ושלבים, ${isOwn() || !CLOUD_CONFIG ? "להוסיף תמונה " : ""}ולשתף לסטורי</p>
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
          <div class="head-actions">
            <button class="sticker-btn share-btn" type="button" data-story="${esc(r.id)}">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="2.5" width="14" height="19" rx="3.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/></svg>
              שיתוף לסטורי
            </button>
            ${canUpload ? `<button class="sticker-btn small photo-btn" type="button" data-photo-pick="${esc(r.id)}">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="18" height="13" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="13.5" r="3.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8.5 7l1.5-2.5h4L15.5 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
              ${photos[r.id] ? "החלפת תמונה" : "הוספת תמונה"}</button>` : ""}
            ${isOwn() ? `<button class="sticker-btn small" type="button" data-edit="${esc(r.id)}">עריכה</button>` : ""}
          </div>
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
    if (view === "loading") stage.innerHTML = `<p class="loading-page">${esc(loadingText)}</p>`;
    else if (view === "login") stage.innerHTML = loginHTML();
    else if (view === "shelf") stage.innerHTML = CLOUD_CONFIG ? shelfHTML() : staticShelfHTML();
    else stage.innerHTML = wideMQ.matches ? buildWide(idx) : buildNarrow(idx);
    updateControls();
  }

  function updateControls() {
    const inBook = view === "book";
    $("controls").hidden = !inBook;
    $("go-shelf").hidden = !hasShelf || view !== "book";
    $("go-cover").disabled = !inBook;
    if (!inBook) { $("go-toc").hidden = true; document.body.className = "ch-0"; return; }
    $("prev").disabled = current === 0;
    $("next").disabled = current === units.length - 1;
    const u = units[current];
    $("folio").textContent = u.type === "cover" ? ""
      : u.type === "toc" ? "תוכן העניינים"
      : `${current - 1} מתוך ${recipes.length}`;
    $("go-toc").hidden = u.type === "toc";
    $("wake").hidden = !("wakeLock" in navigator) || u.type !== "recipe";
    document.body.className = unitClass(current) || "ch-" + ((BOOK.color || 0) % 6);
  }

  function setHash() {
    if (view !== "book") { try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { /* ignore */ } return; }
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
    if (view !== "book") return;
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

  const STORY_W = 1080, STORY_H = 1920, STORY_FOOTER = 170, INK = "#2a2234";

  async function storyFonts() {
    try { await Promise.all(["700 120px Karantina", "700 60px 'Amatic SC'", "600 40px Assistant", "800 40px Assistant"].map(f => document.fonts.load(f))); }
    catch (e) { /* fall back to system fonts */ }
  }

  // a blank story: gingham tablecloth + the book name on top
  function storyCanvas(color) {
    const cv = document.createElement("canvas"); cv.width = STORY_W; cv.height = STORY_H;
    const ctx = cv.getContext("2d");
    ctx.direction = "rtl";
    ctx.fillStyle = "#fffaf4"; ctx.fillRect(0, 0, STORY_W, STORY_H);
    ctx.globalAlpha = 0.16; ctx.fillStyle = color;
    for (let x = 0; x < STORY_W; x += 96) ctx.fillRect(x, 0, 48, STORY_H);
    for (let y = 0; y < STORY_H; y += 96) ctx.fillRect(0, y, STORY_W, 48);
    ctx.globalAlpha = 1;
    ctx.textAlign = "center"; ctx.fillStyle = INK; ctx.font = "700 64px Karantina, sans-serif";
    ctx.fillText(BOOK.title || "", STORY_W / 2, 120);
    return { cv, ctx };
  }

  // footer, plus page dots when the story has several images
  function storyFinish(ctx, color, page, total) {
    if (total > 1) {
      const gap = 34, x0 = STORY_W / 2 + (total - 1) * gap / 2;
      for (let i = 0; i < total; i++) {
        ctx.beginPath(); ctx.arc(x0 - i * gap, STORY_H - 150, 10, 0, Math.PI * 2);
        ctx.fillStyle = i === page ? color : "rgba(42,34,52,.22)"; ctx.fill();
      }
    }
    ctx.textAlign = "center"; ctx.fillStyle = INK; ctx.font = "700 56px 'Amatic SC', sans-serif";
    ctx.fillText("מתוך ספר המתכונים שלי · " + (BOOK.title || ""), STORY_W / 2, STORY_H - 70);
    return new Promise(res => ctx.canvas.toBlob(b => res(b), "image/png"));
  }

  // a white card with a marker-underlined heading
  function storyCard(ctx, color, x, y, w, h, heading, compact) {
    ctx.save(); ctx.shadowColor = "rgba(40,30,50,.12)"; ctx.shadowBlur = 30; ctx.shadowOffsetY = 10;
    ctx.fillStyle = "#ffffff"; roundRect(ctx, x, y, w, h, 36); ctx.fill(); ctx.restore();
    ctx.textAlign = "right"; ctx.fillStyle = INK; ctx.font = `700 ${compact ? 68 : 84}px Karantina, sans-serif`;
    const hw = ctx.measureText(heading).width;
    const base = compact ? 82 : 104;
    ctx.fillText(heading, x + w - 56, y + base);
    ctx.fillStyle = color; ctx.fillRect(x + w - 56 - hw, y + base + 12, hw, compact ? 8 : 10);
  }

  // numbered steps: measure (draw = false) or draw them from `top`
  const STEP_NUM = 64;
  function stepBlocks(ctx, steps, size, width) {
    ctx.font = `600 ${size}px Assistant, sans-serif`;
    const lh = size * 1.34;
    return steps.map(t => { const lines = wrapLines(ctx, t, width - STEP_NUM); return { lines, h: Math.max(lines.length * lh, 56) + size * 0.55 }; });
  }
  function drawSteps(ctx, color, blocks, startNo, size, xr, top) {
    const lh = size * 1.34; let yy = top;
    blocks.forEach((b, i) => {
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(xr - 24, yy + 26, 26, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#ffffff"; ctx.textAlign = "center"; ctx.font = "700 40px Karantina, sans-serif";
      ctx.fillText(String(startNo + i), xr - 24, yy + 40);
      ctx.fillStyle = INK; ctx.textAlign = "right"; ctx.font = `600 ${size}px Assistant, sans-serif`;
      b.lines.forEach((l, k) => ctx.fillText(l, xr - STEP_NUM, yy + size + k * lh));
      yy += b.h;
    });
  }

  function drawStickyNote(ctx, color, text, cx, y, w) {
    ctx.font = "700 56px 'Amatic SC', sans-serif";
    const lines = wrapLines(ctx, text, w - 80).slice(0, 4);
    const h = lines.length * 60 + 70;
    ctx.save(); ctx.translate(cx, y + h / 2); ctx.rotate(0.03);
    ctx.shadowColor = "rgba(40,30,0,.25)"; ctx.shadowBlur = 24; ctx.shadowOffsetY = 12;
    ctx.fillStyle = "#fff0a3"; ctx.fillRect(-w / 2, -h / 2, w, h); ctx.shadowColor = "transparent";
    ctx.globalAlpha = 0.8; ctx.fillStyle = color; ctx.fillRect(-60, -h / 2 - 16, 120, 34); ctx.globalAlpha = 1;
    ctx.fillStyle = "#3a3020"; ctx.textAlign = "center";
    lines.forEach((l, i) => ctx.fillText(l, 0, -h / 2 + 78 + i * 60));
    ctx.restore();
    return h;
  }

  // Story images for a recipe: the first has the photo, title and ingredients;
  // the preparation steps follow (on the same image when they fit, otherwise on more images)
  async function makeStories(r) {
    const W = STORY_W, H = STORY_H, footer = STORY_FOOTER;
    const color = CH_COLORS[chIndex(r.category)];
    await storyFonts();
    const steps = (r.steps || []).map(s => String(s).trim()).filter(Boolean);
    const tips = tipsOf(r).map(String).filter(Boolean);
    const first = storyCanvas(color);
    const ctx = first.ctx;

    const items = (r.ingredients || []).map(s => String(s).trim()).filter(s => s && !isSub(s));
    const imgSrc = photos[r.id];
    const img = imgSrc ? await loadImage(imgSrc) : null;
    const metaLine = [r.category, r.time, r.servings].filter(Boolean).join("  ·  ");
    const cardX = 90, cardW = W - 180, stepsW = cardW - 112;

    // Lay out the first image for a given photo size, without drawing.
    // compact: smaller card headings and gaps, used when trying to fit everything on one image.
    function plan(pw, ph, compact, titleOverride) {
      const pad = compact ? 170 : 210, cardGap = compact ? 28 : 40, contentTop = compact ? 130 : 170;
      const top0 = img ? 170 + ph + (compact ? 50 : 70) : 230;
      const titleSize = titleOverride || (img ? (ph <= 520 || items.length > 12 ? 110 : 130) : 190);
      ctx.font = `700 ${titleSize}px Karantina, sans-serif`;
      const titleLines = wrapLines(ctx, r.title, W - 160).slice(0, 2);
      const headH = titleLines.length * titleSize * 0.85 + 20 + (metaLine ? 70 : 0) + (compact ? 36 : 50);
      const maxH = H - footer - top0 - headH - pad;
      let colW = 0;
      const layout = (size, cols, truncate) => {
        colW = (cardW - 112 - (cols - 1) * 40) / cols;
        ctx.font = `600 ${size}px Assistant, sans-serif`;
        const lh = size * 1.32; const per = items.map(t => wrapLines(ctx, t, colW - 34));
        const needs = per.map(ls => ls.length * lh + size * 0.35);
        if (cols === 2 && !truncate) {
          // split evenly: the first part in the right column, the rest in the left one
          if (per.length < 4) return null;
          const total = needs.reduce((a, b) => a + b, 0);
          let best = null, acc = 0;
          for (let k = 1; k < per.length; k++) {
            acc += needs[k - 1];
            const m = Math.max(acc, total - acc);
            if (!best || m < best.m) best = { k, m };
          }
          if (best.m > maxH) return null;
          return { colsOut: [per.slice(0, best.k), per.slice(best.k)], lh, size, used: best.m, colW, cut: false };
        }
        const colsOut = [[]]; const heights = [0]; let cut = false;
        for (let i = 0; i < per.length; i++) {
          const need = needs[i];
          if (heights[heights.length - 1] + need > maxH) {
            if (colsOut.length >= cols) {
              if (!truncate) return null;
              colsOut[colsOut.length - 1].pop();   // make room for the "and N more" line
              colsOut[colsOut.length - 1].push([`ועוד ${per.length - i + 1} מצרכים בספר…`]);
              cut = true;
              break;
            }
            colsOut.push([]); heights.push(0);
          }
          colsOut[colsOut.length - 1].push(per[i]); heights[heights.length - 1] += need;
        }
        return { colsOut, lh, size, used: Math.max(...heights), colW, cut };
      };
      // ingredient layouts from roomiest to most compact: one column, then two columns, smaller type
      const options = [];
      if (items.length && maxH > 80) {
        for (let fs = 42; fs >= 36; fs -= 2) options.push([fs, 1]);
        for (let fs = 40; fs >= 30; fs -= 2) options.push([fs, 2]);
      }
      const stepsFit = cardH => {
        const room = H - footer - top0 - headH - (cardH ? cardH + cardGap : 0) - pad;
        for (let fs = 38; fs >= (compact ? 32 : 34); fs -= 2) {
          const blocks = stepBlocks(ctx, steps, fs, stepsW);
          const used = blocks.reduce((a, b) => a + b.h, 0);
          if (used <= room) return { blocks, size: fs, h: pad + used };
        }
        return null;
      };
      // take the roomiest ingredient layout that still leaves space for the steps on this image;
      // if none does, the roomiest one that fits by itself (the steps then go on extra images)
      let L = null, inline = null, firstFit = null;
      for (const [fs, cols] of options) {
        const l = layout(fs, cols);
        if (!l) continue;
        if (!firstFit) firstFit = l;
        if (!steps.length) { L = l; break; }
        const st = stepsFit(pad + l.used);
        if (st) { L = l; inline = st; break; }
      }
      if (!L) L = firstFit || (items.length && maxH > 80 ? layout(30, 2, true) : null);
      const cardH = L ? pad + L.used : 0;
      if (!inline && steps.length && !items.length) inline = stepsFit(0);
      const fitsAll = (!items.length || (L && !L.cut)) && (!steps.length || !!inline);
      return { pw, ph, compact, pad, cardGap, contentTop, top0, titleSize, titleLines, headH, L, cardH, inline, fitsAll };
    }

    // Prefer one image: try the photo (or the title, when there is no photo) at shrinking sizes and
    // keep the layout with the most readable text; otherwise keep the big photo and add step pages.
    const sizes = img
      ? [[820, 700], [760, 620], [700, 540], [640, 460], [580, 400]].map(([pw, ph]) => [pw, ph, 0])
      : [190, 150, 120].map(t => [0, 0, t]);
    const score = t => (t.L ? t.L.size : 40) + (t.inline ? t.inline.size : 40) + t.ph / 200 + t.titleSize / 100 - (t.compact ? 1 : 0);
    let P = null;
    for (const compact of [false, true]) {
      for (const [pw, ph, ts] of sizes) {
        const t = plan(pw, ph, compact, ts);
        if (t.fitsAll && (!P || score(t) > score(P))) P = t;
      }
    }
    if (!P) P = img ? plan(items.length > 12 ? 700 : 820, items.length > 12 ? 560 : 700, false) : plan(0, 0, false);
    const { L, cardH, inline, titleSize, titleLines, cardGap } = P;

    let y = 170;
    if (img) {
      // polaroid
      const pw = P.pw, ph = P.ph, px = (W - pw) / 2;
      ctx.save(); ctx.translate(W / 2, y + ph / 2); ctx.rotate(-0.035); ctx.translate(-W / 2, -(y + ph / 2));
      ctx.shadowColor = "rgba(40,30,50,.25)"; ctx.shadowBlur = 40; ctx.shadowOffsetY = 18;
      ctx.fillStyle = "#ffffff"; ctx.fillRect(px, y, pw, ph); ctx.shadowColor = "transparent";
      const capH = ph >= 600 ? 140 : 110;
      const iw = pw - 60, ih = ph - capH, ix = px + 30, iy = y + 30;
      const k = Math.max(iw / img.naturalWidth, ih / img.naturalHeight);
      const sw = iw / k, sh = ih / k;
      ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, ix, iy, iw, ih);
      ctx.fillStyle = INK; ctx.textAlign = "center"; ctx.font = `700 ${ph >= 600 ? 58 : 50}px 'Amatic SC', sans-serif`;
      ctx.fillText(r.title, W / 2, y + ph - (ph >= 600 ? 40 : 30));
      ctx.restore();
      // washi tape
      ctx.save(); ctx.translate(W / 2, y + 4); ctx.rotate(0.06);
      ctx.globalAlpha = 0.8; ctx.fillStyle = color; ctx.fillRect(-120, -26, 240, 52); ctx.restore();
      y = P.top0;
    } else {
      y = 170 + Math.max(0, (H - footer - 170 - P.headH - cardH - (inline ? cardGap + inline.h : 0)) / 2);
    }

    ctx.fillStyle = INK; ctx.textAlign = "center";
    ctx.font = `700 ${titleSize}px Karantina, sans-serif`;
    titleLines.forEach(l => { y += titleSize * 0.85; ctx.fillText(l, W / 2, y); });
    y += 20;
    if (metaLine) { ctx.fillStyle = color; ctx.font = "700 60px 'Amatic SC', sans-serif"; y += 70; ctx.fillText(metaLine, W / 2, y); }
    y += P.compact ? 36 : 50;

    if (L) {
      storyCard(ctx, color, cardX, y, cardW, cardH, "מה צריך", P.compact);
      const top = y + P.contentTop;
      L.colsOut.forEach((col, ci) => {
        const xr = cardX + cardW - 56 - ci * (L.colW + 40);
        let yy = top;
        col.forEach(ls => {
          ctx.fillStyle = color; ctx.beginPath(); ctx.arc(xr - 8, yy + L.size * 0.62, 7, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = INK; ctx.font = `600 ${L.size}px Assistant, sans-serif`;
          ls.forEach(l => { ctx.fillText(l, xr - 30, yy + L.size); yy += L.lh; });
          yy += L.size * 0.35;
        });
      });
      y += cardH + cardGap;
    }
    if (inline) {
      storyCard(ctx, color, cardX, y, cardW, inline.h, "איך מכינים", P.compact);
      drawSteps(ctx, color, inline.blocks, 1, inline.size, cardX + cardW - 56, y + P.contentTop);
    }

    // more images for the steps, split into pages
    const pages = [];
    if (steps.length && !inline) {
      const top = 380, room = H - footer - 60 - top - 210;
      let size = 38, blocks = stepBlocks(ctx, steps, size, stepsW);
      const paginate = (bs, cap) => { const out = [[]]; let h = 0; bs.forEach((b, i) => { if (h + b.h > cap && out[out.length - 1].length) { out.push([]); h = 0; } out[out.length - 1].push(i); h += b.h; }); return out; };
      let split = paginate(blocks, room);
      if (split.length > 2) { size = 34; blocks = stepBlocks(ctx, steps, size, stepsW); split = paginate(blocks, room); }
      // balance the pages so the last one isn't nearly empty
      const total = blocks.reduce((a, b2) => a + b2.h, 0);
      for (let cap = total / split.length; cap < room; cap *= 1.05) {
        const s2 = paginate(blocks, cap);
        if (s2.length === split.length) { split = s2; break; }
      }
      split.forEach(idx => pages.push({ blocks: idx.map(i => blocks[i]), start: idx[0] + 1, size }));
    }

    const total = 1 + pages.length;
    const out = [await storyFinish(ctx, color, 0, total)];
    for (let p = 0; p < pages.length; p++) {
      const pg = pages[p];
      const { ctx: c } = storyCanvas(color);
      c.fillStyle = INK; c.textAlign = "center"; c.font = "700 110px Karantina, sans-serif";
      const tl = wrapLines(c, r.title, W - 160).slice(0, 1)[0] || "";
      c.fillText(tl, W / 2, 260);
      c.fillStyle = color; c.font = "700 60px 'Amatic SC', sans-serif";
      c.fillText(pages.length > 1 ? `אופן ההכנה · ${p + 1} מתוך ${pages.length}` : "אופן ההכנה", W / 2, 330);
      const used = pg.blocks.reduce((a, b) => a + b.h, 0);
      const ch = 210 + used;
      storyCard(c, color, cardX, 380, cardW, ch, "איך מכינים");
      drawSteps(c, color, pg.blocks, pg.start, pg.size, cardX + cardW - 56, 380 + 170);
      // a tip on the last page when there is room
      if (p === pages.length - 1 && tips.length) {
        const ty = 380 + ch + 70;
        if (H - footer - 60 - ty > 230) drawStickyNote(c, color, tips[0], W / 2, ty, 760);
      }
      out.push(await storyFinish(c, color, p + 1, total));
    }
    return out;
  }

  let storyBlobs = [], storyRecipe = null, storyUrls = [];
  async function openStory(id) {
    const r = recipes.find(x => x.id === id); if (!r) return;
    storyRecipe = r; storyBlobs = [];
    const modal = $("story-modal");
    $("story-preview").innerHTML = `<span class="loading">מכינה את התמונות…</span>`;
    $("story-status").textContent = "";
    $("story-hint").textContent = "";
    $("story-save").disabled = true;
    modal.hidden = false;
    $("story-close").focus();
    storyBlobs = await makeStories(r);
    storyUrls.forEach(u => URL.revokeObjectURL(u));
    storyUrls = storyBlobs.map(b => URL.createObjectURL(b));
    const n = storyUrls.length;
    $("story-preview").innerHTML = storyUrls.map((u, i) => `<img src="${u}" alt="סטורי של ${esc(r.title)}${n > 1 ? `, תמונה ${i + 1} מתוך ${n}` : ""}">`).join("");
    $("story-preview").classList.toggle("multi", n > 1);
    $("story-hint").textContent = n > 1
      ? `הסטורי יוצא ב־${n} תמונות. מחליקים כדי לראות את כולן, ומעלים אותן לסטורי לפי הסדר.`
      : "אפשר גם ללחוץ לחיצה ארוכה על התמונה כדי לשמור אותה.";
    $("story-save").disabled = false;
  }

  async function saveStory() {
    if (!storyBlobs.length) return;
    const n = storyBlobs.length;
    const name = i => `${storyRecipe.id}-story${n > 1 ? "-" + (i + 1) : ""}.png`;
    const status = $("story-status");
    const downloads = window.claude && window.claude.use ? await window.claude.use("downloads") : null;
    if (downloads) {
      let saved = 0;
      for (let i = 0; i < n; i++) {
        try { await downloads.save({ filename: name(i), data: storyBlobs[i] }); saved++; }
        catch (e) { if (e && e.code === "declined") break; status.textContent = "לא הצלחתי לשמור כאן. לחיצה ארוכה על תמונה תשמור אותה."; return; }
      }
      if (saved) status.textContent = saved === n ? (n > 1 ? "כל התמונות נשמרו. עכשיו אפשר להעלות אותן לסטורי." : "נשמר. עכשיו אפשר להעלות אותו לסטורי.") : `נשמרו ${saved} מתוך ${n} תמונות.`;
      return;
    }
    const files = storyBlobs.map((b, i) => new File([b], name(i), { type: "image/png" }));
    if (navigator.canShare && navigator.canShare({ files })) {
      try { await navigator.share({ files, title: storyRecipe.title }); return; } catch (e) { if (e && e.name === "AbortError") return; }
    }
    storyUrls.forEach((u, i) => { const a = document.createElement("a"); a.href = u; a.download = name(i); document.body.appendChild(a); a.click(); a.remove(); });
    status.textContent = n > 1 ? "התמונות ירדו למכשיר." : "התמונה ירדה למכשיר.";
  }

  function closeStory() { $("story-modal").hidden = true; }
  $("story-close").addEventListener("click", closeStory);
  $("story-save").addEventListener("click", saveStory);
  $("story-modal").addEventListener("click", e => { if (e.target.id === "story-modal") closeStory(); });

  // ======================================================
  //  Shared books (Firebase). Only runs when firebase-config.js is filled in.
  // ======================================================
  let cloud = null;
  let shelf = [];
  let loginMode = "in";        // in | up | reset
  let pendingName = "";
  let editingId = null;

  const AUTH_ERRORS = {
    "auth/invalid-credential": "האימייל או הסיסמה לא נכונים.",
    "auth/wrong-password": "האימייל או הסיסמה לא נכונים.",
    "auth/user-not-found": "לא מצאתי חשבון עם האימייל הזה.",
    "auth/email-already-in-use": "כבר יש חשבון עם האימייל הזה. אפשר להתחבר אליו.",
    "auth/weak-password": "הסיסמה צריכה להיות לפחות 6 תווים.",
    "auth/invalid-email": "כתובת האימייל לא תקינה.",
    "auth/missing-password": "צריך למלא סיסמה.",
    "auth/network-request-failed": "אין חיבור לאינטרנט. נסי שוב כשיש קליטה.",
    "auth/too-many-requests": "יותר מדי ניסיונות. נסי שוב בעוד כמה דקות."
  };
  const authError = e => AUTH_ERRORS[e && e.code] || "משהו השתבש. נסי שוב.";

  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 3200);
  }

  function showLoading(text) { view = "loading"; loadingText = text; render(0); }

  function loginHTML() {
    const up = loginMode === "up", reset = loginMode === "reset";
    return `<section class="page sheet auth fade">
      <div class="page-inner">
        <span class="chapter-badge">ספרי מתכונים משותפים</span>
        <h2 class="display auth-title">${up ? "ספר חדש" : reset ? "שכחתי סיסמה" : "שלום!"}</h2>
        <p class="intro">${up ? "פותחים חשבון ומקבלים ספר מתכונים משלך. תוכלי לראות גם את הספרים של החברות." : reset ? "נשלח לך מייל עם קישור לבחירת סיסמה חדשה." : "מתחברים כדי לפתוח את הספר שלך ואת הספרים של החברות."}</p>
        <form class="auth-form" id="auth-form" novalidate>
          ${up ? `<label class="field"><span>איך קוראים לך?</span><input id="auth-name" name="name" type="text" autocomplete="given-name" required></label>` : ""}
          <label class="field"><span>אימייל</span><input id="auth-email" name="email" type="email" autocomplete="email" dir="ltr" required></label>
          ${reset ? "" : `<label class="field"><span>סיסמה${up ? " (לפחות 6 תווים)" : ""}</span><input id="auth-password" name="password" type="password" autocomplete="${up ? "new-password" : "current-password"}" dir="ltr" required></label>`}
          <p class="form-error" id="auth-error" role="alert"></p>
          <button class="sticker-btn primary big" type="submit">${up ? "פתיחת ספר" : reset ? "שליחת מייל" : "כניסה"}</button>
        </form>
        <div class="auth-switch">
          ${loginMode !== "in" ? `<button type="button" class="link-btn" data-login-mode="in">יש לי כבר חשבון</button>` : `<button type="button" class="link-btn" data-login-mode="up">אין לי חשבון עדיין</button><button type="button" class="link-btn" data-login-mode="reset">שכחתי סיסמה</button>`}
        </div>
      </div>
    </section>`;
  }

  function shelfHTML() {
    const mine = shelf.find(b => me && b.id === me.uid);
    const others = shelf.filter(b => !me || b.id !== me.uid).sort((a, b) => String(a.title).localeCompare(String(b.title), "he"));
    const card = (b, own) => `<button type="button" class="shelf-book ch-${(b.color || 0) % 6}" data-open-book="${esc(b.id)}">
        ${own ? `<span class="own-tag">הספר שלי</span>` : ""}
        <span class="shelf-title">${esc(b.title || "")}</span>
        ${b.ownerName && b.ownerName !== b.title ? `<span class="shelf-owner">${esc(b.ownerName)}</span>` : ""}
        <span class="shelf-count">${countLabel(b.recipeCount || 0)}</span>
      </button>`;
    return `<section class="page sheet shelf fade">
      <div class="page-inner">
        <h2 class="display shelf-head">מדף הספרים</h2>
        <p class="note-hand">שלום ${esc((me && me.displayName) || "")}! כאן הספר שלך והספרים של החברות</p>
        <div class="shelf-grid">${mine ? card(mine, true) : ""}${others.map(b => card(b, false)).join("")}</div>
        ${others.length ? "" : `<p class="shelf-empty">עוד אין כאן ספרים של חברות. שלחי לחברה את הקישור לאתר. ברגע שהיא תפתח חשבון, הספר שלה יופיע כאן.</p>`}
        <div class="shelf-foot">
          <span class="me-line" dir="ltr">${esc((me && me.email) || "")}</span>
          <button class="sticker-btn small" type="button" data-action="signout">יציאה</button>
        </div>
      </div>
    </section>`;
  }

  async function startCloud() {
    showLoading("פותחת את המדף…");
    try {
      const mod = await import("./cloud.js");
      cloud = await mod.initCloud(CLOUD_CONFIG, !!window.FIREBASE_EMULATOR);
    } catch (e) {
      showLoading("לא הצלחתי להתחבר. בדקי שיש אינטרנט ונסי לפתוח שוב.");
      return;
    }
    cloud.onUser(async user => {
      me = user;
      if (!user) { openBookId = null; view = "login"; render(0); setHash(); return; }
      loginMode = "in";
      try {
        let mineBook = await cloud.getBook(user.uid);
        if (!mineBook) {
          const name = (pendingName || user.displayName || user.email.split("@")[0]).trim();
          mineBook = { title: name, subtitle: "ספר המתכונים שלי", ownerName: name, chapters: DEFAULT_CHAPTERS, color: Math.floor(Math.random() * 6) };
          await cloud.createBook(user.uid, mineBook);
        }
        pendingName = "";
        shelf = await cloud.listBooks();
      } catch (e) {
        showLoading("לא הצלחתי לטעון את הספרים. בדקי את החיבור ונסי שוב.");
        return;
      }
      let last = null;
      try { last = localStorage.getItem("foodli-book"); } catch (e) { /* ignore */ }
      if (location.hash && last && shelf.some(b => b.id === last)) openBook(last, true);
      else showShelf(false);
    });
  }

  async function showShelf(refresh) {
    if (refresh && CLOUD_CONFIG && cloud) { try { shelf = await cloud.listBooks(); } catch (e) { /* show what we have */ } }
    view = "shelf"; openBookId = null; render(0); setHash();
    window.scrollTo({ top: 0 });
  }

  const blobToDataURL = b => new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(f.result); f.onerror = () => rej(f.error); f.readAsDataURL(b); });

  function cloudPhotoStore(uid) {
    return {
      async save(id, blob) {
        let data = await blobToDataURL(blob);
        // a Firestore document holds up to 1 MB, so make sure the photo fits
        for (const [max, q] of [[900, 0.8], [700, 0.72], [520, 0.66]]) {
          if (data.length <= 900000) break;
          data = await blobToDataURL(await shrinkImage(blob, max, q));
        }
        await cloud.savePhoto(uid, id, data);
        photos[id] = data;
      },
      async remove(id) { await cloud.removePhoto(uid, id); delete photos[id]; }
    };
  }

  async function openBook(id, fromHash) {
    showLoading("פותחת את הספר…");
    try {
      const [book, list] = await Promise.all([cloud.getBook(id), cloud.listRecipes(id)]);
      if (!book) throw new Error("missing");
      openBookId = id;
      setBook(book, list);
      canUpload = isOwn(); photoNote = "";
      store = canUpload ? cloudPhotoStore(id) : null;
      try { localStorage.setItem("foodli-book", id); } catch (e) { /* ignore */ }
      view = "book"; query = ""; activeChapter = "";
      current = fromHash ? unitFromHash() : 0;
      render(current); setHash();
      window.scrollTo({ top: 0 });
      cloud.loadPhotos(id).then(map => { if (openBookId !== id) return; Object.assign(photos, map); refreshPhotos(); }).catch(() => {});
    } catch (e) {
      await showShelf(false);
      toast("לא הצלחתי לפתוח את הספר. בדקי את החיבור לאינטרנט.");
    }
  }

  // ---------- editor sheet ----------
  function closeSheet() { $("sheet-modal").hidden = true; editingId = null; }

  function recipeFormHTML(r) {
    const val = v => esc(v == null ? "" : v);
    const lines = a => esc((Array.isArray(a) ? a : (a ? [a] : [])).join("\n"));
    const cat = r ? r.category : (activeChapter || chapterOrder[0]);
    return `<form class="editor" id="recipe-form" novalidate>
      <h2 class="display editor-title">${r ? "עריכת מתכון" : "מתכון חדש"}</h2>
      ${!r && !CLOUD_CONFIG ? aiBoxHTML() : ""}
      <label class="field"><span>שם המתכון</span><input id="f-title" name="title" type="text" value="${val(r && r.title)}" required></label>
      <div class="field-row">
        <label class="field"><span>פרק</span><select id="f-category" name="category">
          ${chapterOrder.map(c => `<option value="${esc(c)}"${c === cat ? " selected" : ""}>${esc(c)}</option>`).join("")}
          <option value="__new">פרק חדש…</option>
        </select></label>
        <label class="field" id="f-newcat-wrap" hidden><span>שם הפרק החדש</span><input id="f-newcat" name="newCategory" type="text"></label>
      </div>
      <div class="field-row">
        <label class="field"><span>זמן הכנה</span><input id="f-time" name="time" type="text" placeholder="למשל: 40 דקות" value="${val(r && r.time)}"></label>
        <label class="field"><span>כמות</span><input id="f-servings" name="servings" type="text" placeholder="למשל: 6 מנות" value="${val(r && r.servings)}"></label>
      </div>
      <label class="field"><span>כמה מילים על המתכון</span><textarea id="f-intro" name="intro" rows="2">${val(r && r.intro)}</textarea></label>
      <label class="field"><span>מצרכים</span><small>כל מצרך בשורה נפרדת. כותרת משנה מסתיימת בנקודתיים, למשל: לרוטב:</small><textarea id="f-ingredients" name="ingredients" rows="8">${lines(r && r.ingredients)}</textarea></label>
      <label class="field"><span>אופן ההכנה</span><small>כל שלב בשורה נפרדת</small><textarea id="f-steps" name="steps" rows="8">${lines(r && r.steps)}</textarea></label>
      <label class="field"><span>טיפים</span><small>כל טיפ בשורה נפרדת</small><textarea id="f-tips" name="tips" rows="2">${lines(r && r.tips)}</textarea></label>
      <div class="field-row">
        <label class="field"><span>קישור לסרטון</span><input id="f-link" name="link" type="url" dir="ltr" placeholder="https://" value="${val(r && r.link)}"></label>
        <label class="field"><span>מקור</span><input id="f-source" name="source" type="text" value="${val(r && r.source)}"></label>
      </div>
      <p class="form-error" id="recipe-error" role="alert"></p>
      <div class="editor-actions">
        <button class="sticker-btn primary big" type="submit">שמירה</button>
        <button class="sticker-btn" type="button" data-sheet="close">ביטול</button>
        ${r ? `<button class="sticker-btn danger" type="button" data-sheet="delete">מחיקת המתכון</button>` : ""}
      </div>
    </form>`;
  }

  function bookFormHTML() {
    return `<form class="editor" id="book-form" novalidate>
      <h2 class="display editor-title">הספר שלי</h2>
      <label class="field"><span>שם הספר (מופיע בגדול על הכריכה)</span><input id="b-title" name="title" type="text" value="${esc(BOOK.title || "")}" required></label>
      <label class="field"><span>שורה קטנה מעל השם</span><input id="b-subtitle" name="subtitle" type="text" value="${esc(BOOK.subtitle || "")}"></label>
      <fieldset class="field colors"><legend>צבע הכריכה</legend>
        ${[0, 1, 2, 3, 4, 5].map(i => `<label class="swatch ch-${i}"><input type="radio" name="color" value="${i}"${(BOOK.color || 0) % 6 === i ? " checked" : ""}><span></span></label>`).join("")}
      </fieldset>
      <p class="form-error" id="book-error" role="alert"></p>
      <div class="editor-actions">
        <button class="sticker-btn primary big" type="submit">שמירה</button>
        <button class="sticker-btn" type="button" data-sheet="close">ביטול</button>
      </div>
    </form>`;
  }

  function openSheet(html, focusId) {
    $("sheet-card").innerHTML = html;
    $("sheet-modal").hidden = false;
    $("sheet-card").scrollTop = 0;
    const f = focusId && $(focusId); if (f) f.focus();
  }

  const splitLines = v => String(v || "").split("\n").map(x => x.trim()).filter(Boolean);
  const plain = r => { const { _i, ...rest } = r; return rest; };

  // checks the recipe form and returns {recipe, old}, or null after showing what is missing
  function readRecipeForm(form) {
    const f = new FormData(form);
    const err = $("recipe-error");
    const title = String(f.get("title") || "").trim();
    let category = String(f.get("category") || "");
    if (category === "__new") category = String(f.get("newCategory") || "").trim();
    if (!title) { err.textContent = "צריך לתת למתכון שם."; $("f-title").focus(); return null; }
    if (!category) { err.textContent = "צריך לבחור פרק או לכתוב שם לפרק חדש."; return null; }
    const link = String(f.get("link") || "").trim();
    if (link && !/^https:\/\//.test(link)) { err.textContent = "הקישור צריך להתחיל ב־https://"; return null; }
    const old = editingId ? recipes.find(x => x.id === editingId) : null;
    const recipe = {
      id: old ? old.id : undefined,
      title, category,
      time: String(f.get("time") || "").trim() || undefined,
      servings: String(f.get("servings") || "").trim() || undefined,
      intro: String(f.get("intro") || "").trim() || undefined,
      ingredients: splitLines(f.get("ingredients")),
      steps: splitLines(f.get("steps")),
      tips: splitLines(f.get("tips")),
      link: link || undefined,
      source: String(f.get("source") || "").trim() || undefined,
      order: old ? old.order : undefined,
      createdAt: old ? old.createdAt : undefined
    };
    err.textContent = "";
    return { recipe, old };
  }

  async function saveRecipeForm(form) {
    const read = readRecipeForm(form);
    if (!read) return;
    const { recipe } = read;
    const category = recipe.category, err = $("recipe-error");
    const btn = form.querySelector('[type="submit"]'); btn.disabled = true;
    try {
      const id = await cloud.saveRecipe(me.uid, recipe);
      const list = recipes.filter(x => x.id !== id).map(plain).concat({ ...recipe, id });
      const bookChapters = (BOOK.chapters && BOOK.chapters.length ? BOOK.chapters : DEFAULT_CHAPTERS).slice();
      if (!bookChapters.includes(category)) bookChapters.push(category);
      await cloud.updateBook(me.uid, { recipeCount: list.length, chapters: bookChapters });
      setBook({ ...BOOK, chapters: bookChapters, recipeCount: list.length }, list, true);
      closeSheet();
      current = Math.max(0, units.findIndex(u => u.r && u.r.id === id));
      render(current); setHash(); window.scrollTo({ top: 0 });
      toast("המתכון נשמר");
    } catch (e) {
      btn.disabled = false;
      err.textContent = "השמירה לא הצליחה. בדקי את החיבור לאינטרנט ונסי שוב.";
    }
  }

  async function deleteEditingRecipe(btn) {
    if (btn.dataset.confirm !== "1") { btn.dataset.confirm = "1"; btn.textContent = "בטוחה? לחיצה נוספת תמחק"; return; }
    const id = editingId; btn.disabled = true;
    try {
      await cloud.deleteRecipe(me.uid, id);
      const list = recipes.filter(x => x.id !== id).map(plain);
      await cloud.updateBook(me.uid, { recipeCount: list.length });
      delete photos[id];
      setBook({ ...BOOK, recipeCount: list.length }, list, true);
      closeSheet();
      current = 1; render(current); setHash();
      toast("המתכון נמחק");
    } catch (e) {
      btn.disabled = false; $("recipe-error").textContent = "המחיקה לא הצליחה. נסי שוב.";
    }
  }

  async function saveBookForm(form) {
    const f = new FormData(form);
    const title = String(f.get("title") || "").trim();
    if (!title) { $("book-error").textContent = "צריך לתת לספר שם."; return; }
    const data = { title, subtitle: String(f.get("subtitle") || "").trim(), color: Number(f.get("color") || 0) };
    try {
      await cloud.updateBook(me.uid, data);
      Object.assign(BOOK, data);
      const s = shelf.find(b => b.id === me.uid); if (s) Object.assign(s, data);
      closeSheet(); render(current); toast("הספר עודכן");
    } catch (e) { $("book-error").textContent = "השמירה לא הצליחה. נסי שוב."; }
  }

  async function importOriginals(btn) {
    if (btn.dataset.confirm !== "1") { btn.dataset.confirm = "1"; btn.textContent = "להעתיק? לחיצה נוספת מאשרת"; return; }
    btn.disabled = true; btn.textContent = "מעתיקה…";
    try {
      const list = window.RECIPES.map((r, i) => {
        const { example, ...rest } = r;
        return { ...rest, order: i };
      });
      await cloud.importRecipes(me.uid, list);
      const bookChapters = (BOOK.chapters || DEFAULT_CHAPTERS).slice();
      list.forEach(r => { if (r.category && !bookChapters.includes(r.category)) bookChapters.push(r.category); });
      await cloud.updateBook(me.uid, { recipeCount: list.length, chapters: bookChapters });
      await openBook(me.uid, false);
      current = 1; render(current); setHash();
      toast(`${list.length} מתכונים נוספו לספר`);
    } catch (e) {
      btn.disabled = false; btn.textContent = "ההעתקה לא הצליחה. לנסות שוב";
      btn.dataset.confirm = "";
    }
  }

  // clicks inside the stage that belong to accounts and editing; returns true when handled
  async function handleCloudClick(e) {
    const mode = e.target.closest("[data-login-mode]");
    if (mode) { loginMode = mode.dataset.loginMode; render(0); const n = $("auth-name") || $("auth-email"); if (n) n.focus(); return true; }
    const ob = e.target.closest("[data-open-book]");
    if (ob) { openBook(ob.dataset.openBook, false); return true; }
    const ed = e.target.closest("[data-edit]");
    if (ed && isOwn()) { editingId = ed.dataset.edit; openSheet(recipeFormHTML(recipes.find(x => x.id === editingId)), "f-title"); return true; }
    const act = e.target.closest("[data-action]");
    if (!act) return false;
    const a = act.dataset.action;
    if (a === "signout") { try { localStorage.removeItem("foodli-book"); } catch (err) { /* ignore */ } await cloud.signOut(); return true; }
    if (a === "new-recipe" && isOwn()) { editingId = null; openSheet(recipeFormHTML(null), "f-title"); return true; }
    if (a === "book-settings" && isOwn()) { openSheet(bookFormHTML(), "b-title"); return true; }
    if (a === "import" && isOwn()) { importOriginals(act); return true; }
    return false;
  }

  if (CLOUD_CONFIG) {
    stage.addEventListener("submit", async e => {
      if (e.target.id !== "auth-form") return;
      e.preventDefault();
      const f = new FormData(e.target);
      const email = String(f.get("email") || "").trim();
      const password = String(f.get("password") || "");
      const err = $("auth-error");
      const btn = e.target.querySelector('[type="submit"]');
      err.textContent = "";
      if (!email) { err.textContent = "צריך למלא אימייל."; return; }
      btn.disabled = true;
      try {
        if (loginMode === "up") {
          const name = String(f.get("name") || "").trim();
          if (!name) { err.textContent = "איך קוראים לך? זה יהיה השם של הספר."; btn.disabled = false; return; }
          pendingName = name;
          await cloud.signUp(name, email, password);
        } else if (loginMode === "reset") {
          await cloud.resetPassword(email);
          loginMode = "in"; render(0); toast("שלחתי מייל לאיפוס הסיסמה");
        } else {
          await cloud.signIn(email, password);
        }
      } catch (ex) {
        pendingName = "";
        err.textContent = authError(ex);
        btn.disabled = false;
      }
    });

    $("sheet-modal").addEventListener("click", e => {
      if (e.target.id === "sheet-modal") { closeSheet(); return; }
      const b = e.target.closest("[data-sheet]");
      if (!b) return;
      if (b.dataset.sheet === "close") closeSheet();
      else if (b.dataset.sheet === "delete") deleteEditingRecipe(b);
    });
    $("sheet-modal").addEventListener("change", e => {
      if (e.target.id === "f-category") {
        const isNew = e.target.value === "__new";
        $("f-newcat-wrap").hidden = !isNew;
        if (isNew) $("f-newcat").focus();
      }
    });
    $("sheet-modal").addEventListener("submit", e => {
      e.preventDefault();
      if (e.target.id === "recipe-form") saveRecipeForm(e.target);
      else if (e.target.id === "book-form") saveBookForm(e.target);
    });
  }


  // ======================================================
  //  Shelf of books built into the site (no accounts)
  // ======================================================
  function staticShelfHTML() {
    const books = staticBooks.slice().sort((a, b) => (b.id === myBookId) - (a.id === myBookId));
    const card = b => `<button type="button" class="shelf-book ch-${(b.book.color || 0) % 6}" data-open-book="${esc(b.id)}">
        ${b.id === myBookId ? `<span class="own-tag">הספר שלי</span>` : ""}
        <span class="shelf-title">${esc(b.book.title || "")}</span>
        ${b.book.ownerName && b.book.ownerName !== b.book.title ? `<span class="shelf-owner">${esc(b.book.ownerName)}</span>` : ""}
        <span class="shelf-count">${countLabel(b.recipes.length)}</span>
      </button>`;
    const who = b => b.book.ownerName || b.book.title;
    return `<section class="page sheet shelf fade">
      <div class="page-inner">
        <h2 class="display shelf-head">מדף הספרים</h2>
        ${myBookId
          ? `<p class="note-hand">כאן הספר שלך ${staticBooks.filter(b => b.id !== myBookId).map(b => `והספר של ${esc(who(b))}`).join(" ")}. לוחצים על ספר כדי לפתוח אותו</p>`
          : `<div class="who-am-i"><p class="note-hand">רגע לפני שמתחילים: מי את?</p>
              <div class="who-buttons">${staticBooks.map(b => `<button class="sticker-btn primary" type="button" data-pick-me="${esc(b.id)}">${esc(who(b))}</button>`).join("")}</div></div>`}
        <div class="shelf-grid">${books.map(card).join("")}</div>
        ${myBookId ? `<div class="shelf-foot"><span class="me-line">הספר שלך בטלפון הזה: ${esc(who(staticBooks.find(b => b.id === myBookId)))}</span>
          <button class="sticker-btn small" type="button" data-action="change-me">זה לא הספר שלי</button></div>` : ""}
        <div class="shelf-foot"><span class="me-line">${ghToken ? "הטלפון הזה משתף תמונות עם כולן" : "תמונות מהטלפון הזה נשמרות רק בו"}</span>
          <button class="sticker-btn small" type="button" data-action="gh-connect">${ghToken ? "שיתוף תמונות: מחובר" : "שיתוף תמונות עם כולן"}</button></div>
      </div>
    </section>`;
  }

  function openStaticBook(id, fromHash) {
    const b = staticBooks.find(x => x.id === id); if (!b) return;
    openBookId = id;
    setBook(b.book, b.recipes, true);   // local photos are keyed by recipe id, keep them all
    canUpload = !!store;
    try { localStorage.setItem("foodli-book", id); } catch (e) { /* ignore */ }
    view = "book"; query = ""; activeChapter = "";
    current = fromHash ? unitFromHash() : 0;
    render(current); setHash();
    window.scrollTo({ top: 0 });
  }

  function startShelf() {
    let last = null;
    try { last = localStorage.getItem("foodli-book"); } catch (e) { /* ignore */ }
    if (location.hash && myBookId && staticBooks.some(b => b.id === last)) openStaticBook(last, true);
    else showShelf(false);
  }

  function handleShelfClick(e) {
    const pick = e.target.closest("[data-pick-me]");
    if (pick) {
      myBookId = pick.dataset.pickMe;
      try { localStorage.setItem("foodli-me", myBookId); } catch (err) { /* ignore */ }
      render(0); return true;
    }
    const ch = e.target.closest('[data-action="change-me"]');
    if (ch) {
      myBookId = null;
      try { localStorage.removeItem("foodli-me"); } catch (err) { /* ignore */ }
      render(0); return true;
    }
    const ob = e.target.closest("[data-open-book]");
    if (ob) { openStaticBook(ob.dataset.openBook, false); return true; }
    return false;
  }


  // ======================================================
  //  Recipes added or edited from the app (website, on a phone connected with a GitHub key)
  //  added-recipes.json: { bookId: { recipes: { id: recipe }, deleted: [ids] } }
  // ======================================================
  let addedRecipes = {};
  // an earlier version could keep a paid Claude key on the phone: remove it if it is there
  try { localStorage.removeItem("foodli-claude-key"); } catch (e) { /* ignore */ }

  // editing is for a connected phone, in the book that belongs to whoever uses it
  function canEditHere() {
    return !CLOUD_CONFIG && !window.claude && !!ghToken && view === "book" && (!multiBook || openBookId === myBookId);
  }

  // the file is written by people using the app: keep only known fields of the right type
  const str = v => typeof v === "string" && v.trim() ? v.slice(0, 4000) : undefined;
  const strs = v => Array.isArray(v) ? v.filter(x => typeof x === "string" && x.trim()).map(x => x.slice(0, 2000)) : [];
  function cleanRecipe(r) {
    return {
      title: str(r.title) || "מתכון", category: str(r.category) || "", time: str(r.time), servings: str(r.servings),
      intro: str(r.intro), link: str(r.link), linkLabel: str(r.linkLabel), source: str(r.source),
      ingredients: strs(r.ingredients), steps: strs(r.steps), tips: strs(r.tips)
    };
  }

  function mergeBooks() {
    staticBooks.forEach(b => {
      const extra = addedRecipes && addedRecipes[b.id] || {};
      const deleted = new Set(Array.isArray(extra.deleted) ? extra.deleted : []);
      const edits = extra.recipes && typeof extra.recipes === "object" ? extra.recipes : {};
      const list = b.builtin.filter(r => !deleted.has(r.id))
        .map(r => edits[r.id] ? { ...cleanRecipe(edits[r.id]), id: r.id, photo: r.photo } : r);
      Object.entries(edits)
        .filter(([id, r]) => r && typeof r === "object" && !deleted.has(id) && !b.builtin.some(x => x.id === id))
        .sort((a, c) => (a[1].createdAt || 0) - (c[1].createdAt || 0))
        .forEach(([id, r]) => list.push({ ...cleanRecipe(r), id }));
      b.recipes = list;
    });
  }

  // re-merge and redraw, staying on the same recipe
  function refreshBooks() {
    mergeBooks();
    if (view === "book" && openBookId) {
      const u = units[current], keepId = u && u.r ? u.r.id : null, keepToc = u && u.type === "toc";
      const b = staticBooks.find(x => x.id === openBookId);
      setBook(b.book, b.recipes, true);
      const k = keepId ? units.findIndex(x => x.r && x.r.id === keepId) : -1;
      current = k >= 0 ? k : keepToc ? 1 : Math.min(current, units.length - 1);
      render(current); setHash();
    } else if (view === "shelf") render(0);
    applyPhotos();
  }

  async function loadAddedRecipes() {
    try { const map = await readSiteJson("added-recipes.json"); if (map) { addedRecipes = map; refreshBooks(); } }
    catch (e) { /* offline: keep the built-in recipes */ }
  }

  function aiBoxHTML() {
    return `<div class="ai-box">
      <span class="ai-title">יש לך מתכון מוכן?</span>
      <p class="modal-hint">הדביקי אותו כאן, והשדות למטה יתמלאו לבד לפי הכותרות (מצרכים, אופן ההכנה, טיפ) והשורות.</p>
      <textarea id="f-paste" rows="5" placeholder="הדביקי כאן את המתכון…"></textarea>
      <button class="sticker-btn primary" type="button" data-sheet="ai-fill">סידור אוטומטי</button>
      <p class="ai-status" id="ai-status" role="status"></p>
    </div>`;
  }

  // ---- sorting a pasted recipe by headings and lines
  function parseRecipeText(text) {
    const lines = text.split(/\r?\n/).map(l => l.replace(/^[\s•\-–*·●▪️✨❤️]+/u, "").trim()).filter(Boolean);
    const out = { title: "", ingredients: [], steps: [], tips: [] };
    let mode = "start";
    for (const l of lines) {
      if (/^(מצרכים|רכיבים|חומרים|מה צריך)/.test(l)) { mode = "ing"; continue; }
      if (/^(אופן ה?הכנה|הוראות הכנה|הוראות|הכנה|איך מכינים)/.test(l)) { mode = "steps"; continue; }
      if (/^(טיפים|טיפ|הערות|הערה)(?=[\s:–-]|$)/.test(l)) { const t = l.replace(/^(טיפים|טיפ|הערות|הערה)\s*[:\-–]?\s*/, ""); if (t) out.tips.push(t); mode = "tips"; continue; }
      if (mode === "start") {
        if (!out.title) { out.title = l.replace(/[\s:–-]+$/, ""); continue; }
        mode = /^[\d½¼¾⅓]/.test(l) ? "ing" : "steps";
      }
      if (mode === "ing") out.ingredients.push(l.replace(/\s*:\s*$/, ":"));
      else if (mode === "steps") out.steps.push(l.replace(/^\d+\s*[.)]\s*/, ""));
      else out.tips.push(l);
    }
    return out;
  }

  function fillRecipeForm(r) {
    const set = (id, v) => { const el = $(id); if (el && v != null) el.value = Array.isArray(v) ? v.join("\n") : v; };
    if (r.title) set("f-title", r.title);
    set("f-time", r.time || ""); set("f-servings", r.servings || ""); set("f-intro", r.intro || "");
    set("f-ingredients", r.ingredients || []); set("f-steps", r.steps || []); set("f-tips", r.tips || []);
    const cat = String(r.category || "").trim(), sel = $("f-category");
    if (cat && sel) {
      if ([...sel.options].some(o => o.value === cat)) { sel.value = cat; $("f-newcat-wrap").hidden = true; }
      else { sel.value = "__new"; $("f-newcat-wrap").hidden = false; set("f-newcat", cat); }
    }
  }

  function aiFill() {
    const text = ($("f-paste").value || "").trim();
    const st = $("ai-status");
    if (!text) { st.textContent = "הדביקי קודם את המתכון."; return; }
    fillRecipeForm(parseRecipeText(text));
    st.textContent = "סידרתי לפי הכותרות והשורות. עברי על השדות ותקני מה שצריך.";
  }

  // ---- saving and deleting through GitHub
  async function saveStaticRecipe(form) {
    const read = readRecipeForm(form);
    if (!read) return;
    const { recipe, old } = read, err = $("recipe-error");
    const bookId = openBookId || staticBooks[0].id;
    const id = old ? old.id : `${bookId === "main" ? "" : bookId + "-"}r${Date.now().toString(36)}`;
    const prev = ((addedRecipes[bookId] || {}).recipes || {})[id];
    const record = JSON.parse(JSON.stringify({ ...cleanRecipe(recipe), createdAt: (prev && prev.createdAt) || Date.now(), updatedAt: Date.now() }));
    const btn = form.querySelector('[type="submit"]'); btn.disabled = true;
    try {
      addedRecipes = await ghUpdateJsonFile("added-recipes.json", map => {
        const b = map[bookId] = map[bookId] || {};
        b.recipes = b.recipes || {};
        b.deleted = (b.deleted || []).filter(x => x !== id);
        b.recipes[id] = record;
      }, `מתכון: ${recipe.title}`);
      closeSheet();
      refreshBooks();
      current = Math.max(0, units.findIndex(u => u.r && u.r.id === id));
      render(current); setHash(); window.scrollTo({ top: 0 });
      toast("המתכון נשמר. הוא יופיע אצל כולן תוך כדקה.");
    } catch (e) {
      btn.disabled = false;
      err.textContent = e && e.code === "gh_auth" ? "המפתח לשיתוף לא עובד. אפשר לחבר מפתח חדש במדף." : "השמירה לא הצליחה. בדקי את החיבור לאינטרנט ונסי שוב.";
    }
  }

  async function deleteStaticRecipe(btn) {
    if (btn.dataset.confirm !== "1") { btn.dataset.confirm = "1"; btn.textContent = "בטוחה? לחיצה נוספת תמחק"; return; }
    const id = editingId, bookId = openBookId || staticBooks[0].id;
    const b0 = staticBooks.find(x => x.id === bookId), builtin = !!(b0 && b0.builtin.some(r => r.id === id));
    btn.disabled = true;
    try {
      addedRecipes = await ghUpdateJsonFile("added-recipes.json", map => {
        const b = map[bookId] = map[bookId] || {};
        b.recipes = b.recipes || {}; b.deleted = b.deleted || [];
        delete b.recipes[id];
        if (builtin && !b.deleted.includes(id)) b.deleted.push(id);
      }, "מחיקת מתכון");
      closeSheet();
      current = 1; refreshBooks(); render(current); setHash();
      toast("המתכון נמחק");
    } catch (e) {
      btn.disabled = false; $("recipe-error").textContent = "המחיקה לא הצליחה. נסי שוב.";
    }
  }

  function openStaticEditor(id) {
    editingId = id || null;
    openSheet(recipeFormHTML(id ? recipes.find(x => x.id === id) : null), id ? "f-title" : "f-paste");
  }

  // ======================================================
  //  Connecting this phone so photos are shared with everyone (GitHub key)
  // ======================================================
  function ghConnectHTML() {
    if (ghToken) return `<div class="editor">
      <h2 class="display editor-title">שיתוף תמונות</h2>
      <p>הטלפון הזה מחובר. כל תמונה שמעלים ממנו מופיעה אצל כולן תוך כדקה.</p>
      <div class="editor-actions">
        <button class="sticker-btn" type="button" data-sheet="close">סגירה</button>
        <button class="sticker-btn danger" type="button" data-sheet="gh-disconnect">ניתוק הטלפון</button>
      </div>
    </div>`;
    return `<form class="editor" id="gh-form" novalidate>
      <h2 class="display editor-title">שיתוף תמונות עם כולן</h2>
      <p>כדי שתמונה שמעלים מהטלפון תופיע גם אצל אחרות, האפליקציה צריכה מפתח שמרשה לה לשמור תמונות באתר. עושים את זה פעם אחת בכל טלפון:</p>
      <ol class="how-to">
        <li>נכנסים ל־<a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">יצירת מפתח ב־GitHub</a> (מחוברת לחשבון של דקל).</li>
        <li>ב־<b>Token name</b> כותבים FoodLi, וב־<b>Expiration</b> בוחרים את התוקף הכי ארוך.</li>
        <li>ב־<b>Repository access</b> בוחרים <b>Only select repositories</b> ואז <b>FoodLi</b>.</li>
        <li>ב־<b>Permissions</b> מוסיפים את <b>Contents</b> (לפעמים דרך הכפתור <b>Add permissions</b>) ובוחרים <b>Read and write</b>.</li>
        <li>לוחצים <b>Generate token</b>, מעתיקים את המפתח ומדביקים כאן.</li>
      </ol>
      <label class="field"><span>המפתח</span><input id="gh-token" name="token" type="password" dir="ltr" autocomplete="off" placeholder="github_pat_…" required></label>
      <p class="form-error" id="gh-error" role="alert"></p>
      <p class="modal-hint">מי שמחזיקה במפתח יכולה לשנות קבצים באתר, אז שולחים אותו רק לחברות שמעלות תמונות.</p>
      <div class="editor-actions">
        <button class="sticker-btn primary big" type="submit">חיבור</button>
        <button class="sticker-btn" type="button" data-sheet="close">ביטול</button>
      </div>
    </form>`;
  }

  async function connectGitHub(form) {
    const token = String(new FormData(form).get("token") || "").trim();
    const err = $("gh-error"), btn = form.querySelector('[type="submit"]');
    if (!token) { err.textContent = "צריך להדביק את המפתח."; return; }
    btn.disabled = true; err.textContent = "";
    try {
      const res = await ghApi("", {}, token);
      if (!res.ok) { err.textContent = res.status === 401 ? "המפתח לא נכון. בדקי שהעתקת את כולו." : "המפתח לא נותן גישה ל־FoodLi. בדקי שבחרת את המאגר הזה."; btn.disabled = false; return; }
      const repo = await res.json();
      if (repo.permissions && repo.permissions.push === false) { err.textContent = "למפתח אין הרשאה לשמור. ב־Contents צריך לבחור Read and write."; btn.disabled = false; return; }
      ghToken = token;
      try { localStorage.setItem("foodli-gh-token", token); } catch (e) { /* ignore */ }
      setPhotoNote(); closeSheet(); render(current); applyPhotos();
      toast("מעכשיו התמונות שתעלי יופיעו אצל כולן");
    } catch (e) {
      err.textContent = "אין חיבור לאינטרנט. נסי שוב."; btn.disabled = false;
    }
  }

  function handleSiteClick(e) {
    const ed = e.target.closest("[data-edit]");
    if (ed && canEditHere()) { openStaticEditor(ed.dataset.edit); return true; }
    if (e.target.closest('[data-action="new-recipe"]') && canEditHere()) { openStaticEditor(null); return true; }
    if (!e.target.closest('[data-action="gh-connect"]')) return false;
    openSheet(ghConnectHTML(), ghToken ? null : "gh-token");
    return true;
  }

  if (!CLOUD_CONFIG && !window.claude) {
    $("sheet-modal").addEventListener("click", e => {
      if (e.target.id === "sheet-modal") { closeSheet(); return; }
      const b = e.target.closest("[data-sheet]"); if (!b) return;
      if (b.dataset.sheet === "close") closeSheet();
      else if (b.dataset.sheet === "delete") deleteStaticRecipe(b);
      else if (b.dataset.sheet === "ai-fill") aiFill();
      else if (b.dataset.sheet === "gh-disconnect") {
        ghToken = null;
        try { localStorage.removeItem("foodli-gh-token"); } catch (err) { /* ignore */ }
        setPhotoNote(); closeSheet(); render(current); applyPhotos();
        toast("הטלפון נותק משיתוף התמונות");
      }
    });
    $("sheet-modal").addEventListener("submit", e => {
      if (e.target.id === "gh-form") { e.preventDefault(); connectGitHub(e.target); }
      else if (e.target.id === "recipe-form") { e.preventDefault(); saveStaticRecipe(e.target); }
    });
    $("sheet-modal").addEventListener("change", e => {
      if (e.target.id === "f-category") {
        const isNew = e.target.value === "__new";
        $("f-newcat-wrap").hidden = !isNew;
        if (isNew) $("f-newcat").focus();
      }
    });
  }

  // ---------- events ----------
  $("prev").addEventListener("click", () => go(current - 1));
  $("next").addEventListener("click", () => go(current + 1));
  $("go-toc").addEventListener("click", () => go(1));
  $("go-cover").addEventListener("click", () => go(0));
  $("go-cover").textContent = hasShelf ? "FoodLi" : BOOK.title;

  stage.addEventListener("click", async e => {
    if (CLOUD_CONFIG && await handleCloudClick(e)) return;
    if (multiBook && handleShelfClick(e)) return;
    if (!CLOUD_CONFIG && !window.claude && handleSiteClick(e)) return;
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
    if (!$("sheet-modal").hidden) { if (e.key === "Escape") closeSheet(); return; }
    if (e.target.matches && e.target.matches("input, textarea, select")) return;
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

  window.addEventListener("hashchange", () => { if (view !== "book") return; const u = unitFromHash(); if (u !== current) { current = u; render(current); } });
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

  // offline support when running as a regular website (not inside claude.ai)
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost") && !window.claude) {
    // when a new version takes over (e.g. an older home-screen app updating), reload once to show it
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (hadController && !reloaded) { reloaded = true; location.reload(); }
    });
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(r => r.update()).catch(() => {});
  }

  $("go-shelf").addEventListener("click", () => showShelf(true));
  if (CLOUD_CONFIG) startCloud();
  else if (multiBook) startShelf();
  else { current = unitFromHash(); render(current); }
})();
