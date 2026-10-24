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
  // every chapter gets its own color (6 colors, cycling)
  const chClass = c => "ch-" + (Math.max(0, chapterOrder.indexOf(c)) % 6);

  // ---------- helpers ----------
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const $ = id => document.getElementById(id);
  const wideMQ = window.matchMedia("(min-width: 900px) and (min-height: 560px)");
  const reduceMQ = window.matchMedia("(prefers-reduced-motion: reduce)");
  const stage = $("stage");

  let current = 0;
  let query = "";
  let activeChapter = "";
  let busy = false;

  const countIngredients = r => (r.ingredients || []).filter(l => !String(l).trim().endsWith(":")).length;

  // ---------- page content ----------
  function coverHTML() {
    const dots = chapters.map(c => `<span class="dot ${chClass(c)}" title="${esc(c)}"></span>`).join("");
    return `<section class="page cover">
      <div class="blobs" aria-hidden="true"><span class="blob ch-0"></span><span class="blob ch-1"></span><span class="blob ch-2"></span><span class="blob ch-3"></span><span class="blob ch-4"></span><span class="blob ch-5"></span></div>
      <div class="cover-body">
        <span class="eyebrow">${esc(BOOK.subtitle || "")}</span>
        <h1>${esc(BOOK.title)}</h1>
        <div class="cover-dots" aria-hidden="true">${dots}</div>
        <p class="cover-count">${recipes.length} מתכונים ב־${chapters.length} פרקים</p>
        <button class="btn-primary" type="button" data-go="1">לפתוח את הספר</button>
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
      parts.push(`<section class="toc-group ${chClass(ch)}"><h3>${esc(ch)}</h3><div class="tiles">${items.map(x => {
        const n = countIngredients(x.r);
        const sub = x.r.time || (n ? n + " מצרכים" : (x.r.link ? "בסרטון" : ""));
        return `<button class="tile" type="button" data-go="${x.unit}"><span class="tile-title">${esc(x.r.title)}</span>${sub ? `<span class="tile-sub">${esc(sub)}</span>` : ""}</button>`;
      }).join("")}</div></section>`);
    });
    return parts.length ? parts.join("") : `<p class="empty">לא מצאתי מתכון כזה. אפשר לנסות מילה אחרת.</p>`;
  }

  function tocParts() {
    const a = `<div class="page-inner toc-head">
      <h2>מה מבשלים היום?</h2>
      <div class="search-wrap">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <input class="search" id="search" type="search" aria-label="חיפוש מתכון" placeholder="חיפוש לפי מתכון או מצרך" value="${esc(query)}" autocomplete="off">
      </div>
      <div class="chapters" role="group" aria-label="פרקים">
        <button class="chapter-chip" type="button" data-chapter="" aria-pressed="${!activeChapter}">הכול</button>
        ${chapters.map(c => `<button class="chapter-chip ${chClass(c)}" type="button" data-chapter="${esc(c)}" aria-pressed="${activeChapter === c}">${esc(c)}</button>`).join("")}
      </div>
      <p class="hint">בתוך מתכון: לחיצה על מצרך או על שלב מסמנת אותו.</p>
    </div>`;
    const b = `<div class="page-inner"><div class="toc-list" id="toc-list">${tocListHTML()}</div></div>`;
    return [a, b];
  }

  function recipeParts(r) {
    const meta = [r.time, r.servings].filter(Boolean);
    const ings = (r.ingredients || []).map((line, i) => {
      const s = String(line).trim();
      if (s.endsWith(":")) return `<li class="sub">${esc(s.slice(0, -1))}</li>`;
      return `<li><label><input type="checkbox" id="ing-${esc(r.id)}-${i}"><span>${esc(s)}</span></label></li>`;
    }).join("");
    const tips = Array.isArray(r.tips) ? r.tips : (r.tips ? [r.tips] : []);
    const hasLink = /^https:\/\//.test(r.link || "");
    const a = `<div class="page-inner">
      <div class="recipe-head">
        <span class="tag">${esc(r.category || "")}</span>
        <h2 class="recipe-title">${esc(r.title)}</h2>
        ${meta.length ? `<div class="meta">${meta.map(m => `<span>${esc(m)}</span>`).join("")}</div>` : ""}
        ${r.intro ? `<p class="intro">${esc(r.intro)}</p>` : ""}
      </div>
      ${ings ? `<div class="ing-card"><h3 class="section-title">מצרכים</h3><ul class="ingredients">${ings}</ul></div>` : ""}
    </div>`;
    const b = `<div class="page-inner">
      ${(r.steps || []).length || !hasLink ? `<h3 class="section-title">אופן ההכנה</h3>` : ""}
      ${(r.steps || []).length
        ? `<ol class="steps">${r.steps.map((s, i) => `<li tabindex="0"><b aria-hidden="true">${i + 1}</b><span>${esc(s)}</span></li>`).join("")}</ol>`
        : (hasLink ? "" : `<p class="empty">אופן ההכנה עוד לא נכתב.</p>`)}
      ${hasLink ? `<a class="btn-primary video-link" href="${esc(r.link)}" target="_blank" rel="noopener">${esc(r.linkLabel || "למתכון המלא בסרטון")}</a>` : ""}
      ${tips.length ? `<div class="tips"><span class="tips-label">טיפ</span>${tips.map(t => `<p>${esc(t)}</p>`).join("")}</div>` : ""}
      ${r.source ? `<p class="source">מקור: ${esc(r.source)}</p>` : ""}
    </div>`;
    return [a, b];
  }

  function partsFor(idx) {
    const u = units[idx];
    if (u.type === "toc") return tocParts();
    return recipeParts(u.r);
  }
  const unitClass = idx => units[idx].type === "recipe" ? chClass(units[idx].r.category) : "";

  // ---------- rendering ----------
  function buildWide(idx) {
    if (units[idx].type === "cover") return `<div class="book closed">${coverHTML()}</div>`;
    const [a, b] = partsFor(idx);
    return `<div class="book ${unitClass(idx)}">
      <section class="page right">${a}</section>
      <section class="page left">${b}</section>
    </div>`;
  }

  function buildNarrow(idx) {
    if (units[idx].type === "cover") return coverHTML().replace('class="page cover"', 'class="page cover sheet fade"');
    const [a, b] = partsFor(idx);
    return `<section class="page sheet fade ${unitClass(idx)}">${a}${b}</section>`;
  }

  function render(idx) {
    stage.innerHTML = wideMQ.matches ? buildWide(idx) : buildNarrow(idx);
    updateControls();
  }

  function updateControls() {
    $("prev").disabled = current === 0;
    $("next").disabled = current === units.length - 1;
    const u = units[current];
    $("folio").textContent = u.type === "cover" ? ""
      : u.type === "toc" ? "תוכן העניינים"
      : `מתכון ${current - 1} מתוך ${recipes.length}`;
    $("go-toc").hidden = u.type === "toc";
    $("wake").hidden = !("wakeLock" in navigator) || u.type !== "recipe";
    document.body.className = unitClass(current);
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
    c.removeAttribute("id");
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
    const turning = forward ? oldL : oldR;
    const staying = forward ? oldR : oldL;
    const l1 = leaf(turning, forward ? "left" : "right");
    const st = leaf(staying, forward ? "right" : "left", "static");

    current = idx;
    render(current);
    const book = stage.querySelector(".book");
    book.append(st, l1);
    await animate(l1, "rotateY(0deg)", forward ? "rotateY(90deg)" : "rotateY(-90deg)", 260);
    l1.remove();
    const incoming = book.querySelector(forward ? ".page.right" : ".page.left");
    const l2 = leaf(incoming, forward ? "right" : "left");
    l2.style.zIndex = 4;
    book.append(l2);
    await animate(l2, forward ? "rotateY(-90deg)" : "rotateY(90deg)", "rotateY(0deg)", 260);
    l2.remove(); st.remove();
    setHash();
    busy = false;
  }

  // ---------- events ----------
  $("prev").addEventListener("click", () => go(current - 1));
  $("next").addEventListener("click", () => go(current + 1));
  $("go-toc").addEventListener("click", () => go(1));
  $("go-cover").addEventListener("click", () => go(0));
  $("go-cover").textContent = BOOK.title;

  stage.addEventListener("click", e => {
    const g = e.target.closest("[data-go]");
    if (g) { go(+g.dataset.go); return; }
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
