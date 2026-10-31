// ===========================================================================
// views.js — the three main views (Explore, Library, Create).
//
// Each render function is idempotent: the app calls it after any state change
// and it rebuilds that section from app state. The Create view is the one
// exception — it keeps its form state on `app.create` so a re-render never
// loses the user's pasted text.
// ===========================================================================

import { $, el, icon, toast, openModal, closeModal, formatDuration, formatLongDuration, wordCount } from "./util.js";
import { TAGS, tagBitCount, tagBitsHas, toggleTagBit, ALL_VOICES, FEATURED_VOICE_IDS, LIGHT_VOICE_IDS, PAGE_SIZE, WORDS_PER_MINUTE, resolveVoice } from "./config.js";
import { bookCard, emptyState, chip, skeletonCards, spinnerNode, folderCard } from "./ui.js";
import { ACCEPT, MAX_FILE_BYTES, fileToText } from "./import.js";
import { REFORMAT_PRESETS, presetById, planSegments, condenseDiff, describeResult, mergeContinuations } from "./reformat.js";
import { setSetting } from "./store.js";

// Marks the card whose book is loaded in the player so it renders highlighted
// (and animated while it's actually playing) even before the first state tick.
function playerMark(app, book) {
  const p = app.player;
  const isCurrent = !!(p && p.book && book && book.id != null && String(p.book.id) === String(book.id));
  return { current: isCurrent, playing: isCurrent && !!p.isPlaying };
}

// A single Explore card. Exported so a listing row can be re-rendered in place
// once its display bundle (cover/blurb) finishes loading.
export function exploreCardNode(app, item) {
  return bookCard(item, {
    onOpen: (b) => app.openBook(b),
    onLongPress: (b, pos) => app.bookContextMenu(b, pos),
    ...playerMark(app, item),
  });
}

export function refreshExploreCard(app, item) {
  const host = $("#viewExplore");
  if (!host || item == null) return;
  const old = host.querySelector('.card[data-book-id="' + CSS.escape(String(item.id)) + '"]');
  if (old) old.replaceWith(exploreCardNode(app, item));
}

// ===========================================================================
// Explore
// ===========================================================================
export function renderExplore(app) {
  const host = $("#viewExplore");
  if (!host) return;
  const st = app.explore;
  host.innerHTML = "";

  const controls = el("div", { class: "explore-controls" });
  const toolbar = el("div", { class: "explore-toolbar" });

  const sortSeg = el("div", { class: "sort-seg", role: "group", "aria-label": "Sort" });
  for (const [key, label] of [["top", "Top listened"], ["new", "Newest"], ["trending", "Trending"]]) {
    const b = el("button", { class: "seg-btn" + (st.sort === key ? " active" : ""), text: label });
    b.addEventListener("click", () => { if (st.sort === key) return; st.sort = key; app.loadExplore({ reset: true }); });
    sortSeg.appendChild(b);
  }
  toolbar.appendChild(sortSeg);

  const bitCount = tagBitCount(st.tagBits);
  const pick = el("div", { class: "tag-filter" });
  const tagBtn = el("button", {
    class: "tag-btn" + ((bitCount || st.tagOpen) ? " on" : ""),
    "aria-haspopup": "true",
    "aria-expanded": st.tagOpen ? "true" : "false",
  }, [
    bitCount ? `${bitCount} tag${bitCount === 1 ? "" : "s"}` : "All tags",
    el("span", { html: icon("chevronDown", { size: 15 }) }),
  ]);
  const pop = el("div", { class: "tag-pop" });
  pop.hidden = !st.tagOpen;
  const tagSearch = el("input", { class: "input tag-search", type: "search", placeholder: "Filter tags…", autocomplete: "off" });
  tagSearch.value = st.tagQuery || "";
  const popChips = el("div", { class: "chips tag-cloud" });
  const paintChips = () => {
    const q = tagSearch.value.trim().toLowerCase();
    popChips.innerHTML = "";
    let shown = 0;
    for (const g of TAGS) {
      if (q && !g.toLowerCase().includes(q)) continue;
      shown++;
      popChips.appendChild(chip(g, {
        active: tagBitsHas(st.tagBits, g),
        onClick: () => { st.tagQuery = tagSearch.value; st.tagFocus = true; st.tagBits = toggleTagBit(st.tagBits, g); app.loadExplore({ reset: true }); },
      }));
    }
    if (!shown) popChips.appendChild(el("span", { class: "hint", text: "No matching tags" }));
  };
  tagSearch.addEventListener("input", () => { st.tagQuery = tagSearch.value; paintChips(); });
  paintChips();
  pop.append(tagSearch, popChips);
  if (bitCount) {
    const foot = el("div", { class: "chips", style: { marginTop: "12px" } });
    foot.appendChild(chip("Clear", { onClick: () => { st.tagBits = ""; app.loadExplore({ reset: true }); } }));
    pop.appendChild(foot);
  }
  tagBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    st.tagOpen = !st.tagOpen;
    pop.hidden = !st.tagOpen;
    if (st.tagOpen) {
      if (app._tagOutside) document.removeEventListener("click", app._tagOutside);
      app._tagOutside = (ev) => {
        if (pick.contains(ev.target)) return;
        document.removeEventListener("click", app._tagOutside);
        app._tagOutside = null;
        st.tagOpen = false;
        pop.hidden = true;
      };
      setTimeout(() => document.addEventListener("click", app._tagOutside), 0);
    }
  });
  if (st.tagOpen && st.tagFocus) {
    st.tagFocus = false;
    try { tagSearch.focus(); const n = tagSearch.value.length; tagSearch.setSelectionRange(n, n); } catch (e) {}
  }
  pick.append(tagBtn, pop);
  toolbar.appendChild(pick);
  controls.appendChild(toolbar);

  const showStatusRow = !!st.query || st.total > 0 || st.verifying > 0 || !!st.loading;
  if (showStatusRow) {
    const statusRow = el("div", { class: "row-between" });
    const resultText = st.query
      ? `${st.total} result${st.total === 1 ? "" : "s"} for “${st.query}”`
      : `${st.total} title${st.total === 1 ? "" : "s"}`;
    statusRow.appendChild(el("span", { class: "hint", text: resultText }));
    const verifyNotice = el("span", { class: "hint" });
    if (st.verifying > 0) {
      verifyNotice.appendChild(el("span", { class: "spinner" }));
      verifyNotice.appendChild(document.createTextNode(" Checking content…"));
    }
    statusRow.appendChild(verifyNotice);
    controls.appendChild(statusRow);
  }
  host.appendChild(controls);

  if (st.error && !st.items.length) {
    host.appendChild(emptyState({
      iconName: "globe", title: "Couldn't reach the library",
      text: "The shared library server is unavailable right now. You can still create your own audiobooks and listen to anything you've saved.",
      actionLabel: "Try again", onAction: () => app.loadExplore({ reset: true }),
    }));
    return;
  }

  if (st.loading && !st.items.length) {
    const g = el("div", { class: "grid" });
    for (const s of skeletonCards(12)) g.appendChild(s);
    host.appendChild(g);
    return;
  }

  if (!st.items.length) {
    host.appendChild(emptyState({
      iconName: "globe", title: st.query ? "Nothing found" : "Nothing here yet",
      text: st.query ? "Try a different search, or clear the tag filters." : "Be the first to publish an audiobook to the shared library.",
      actionLabel: "Create one", onAction: () => app.navigate("create"),
    }));
    return;
  }

  const grid = el("div", { class: "grid" });
  for (const item of st.items) {
    grid.appendChild(exploreCardNode(app, item));
  }
  host.appendChild(grid);

  if (st.items.length < st.total) {
    const row = el("div", { class: "load-more" });
    const btn = el("button", { class: "btn btn-ghost" }, st.loading ? [spinnerNode(), "Loading…"] : ["Load more"]);
    btn.disabled = !!st.loading;
    btn.addEventListener("click", () => app.loadExplore({ reset: false }));
    row.appendChild(btn);
    host.appendChild(row);
  } else if (st.total > PAGE_SIZE) {
    host.appendChild(el("div", { class: "load-more" }, [el("span", { class: "hint", text: "That's everything." })]));
  }
}

// ===========================================================================
// Library
// ===========================================================================
// A book counts as read once it's flagged finished or the listener got within
// 2% of the end (skipping the credits still counts).
function isBookRead(app, b) {
  if (b.finished) return true;
  const pos = app.positions && app.positions[b.id];
  return !!(pos && pos.progress >= 0.98);
}

export function renderLibrary(app) {
  const host = $("#viewLibrary");
  if (!host) return;
  host.innerHTML = "";

  const all = app.library || [];
  const folders = app.collections || [];
  const byId = new Map(folders.map((f) => [f.id, f]));
  const view = app.libraryView;
  const q = (app.searchQuery || "").trim().toLowerCase();

  // Breadcrumb trail down to the open folder.
  const path = [];
  let cur = view.collectionId;
  let guard = 0;
  while (cur != null && byId.has(cur) && guard++ < 64) { path.unshift(byId.get(cur)); cur = byId.get(cur).parentId ?? null; }

  const readFilter = view.readFilter || "all";
  const tagFilter = view.tagFilter || [];
  const pool = all
    .filter((b) => (view.showArchived ? !!b.archived : !b.archived))
    .filter((b) => readFilter === "all" || (readFilter === "read" ? isBookRead(app, b) : !isBookRead(app, b)))
    .filter((b) => !tagFilter.length || tagFilter.some((t) => (b.tags || []).includes(t)));
  let folderList, books;
  if (view.showArchived) {
    // Archived is a flat "tucked away" place of its own, independent of folders.
    folderList = [];
    books = q ? pool.filter((b) => matchesQuery(b, q)) : pool;
  } else if (q) {
    folderList = [];
    books = pool.filter((b) => matchesQuery(b, q));
  } else {
    folderList = folders.filter((f) => (f.parentId ?? null) === view.collectionId);
    books = app.sortByOrder ? app.sortByOrder(pool.filter((b) => (b.collectionId ?? null) === view.collectionId))
      : pool.filter((b) => (b.collectionId ?? null) === view.collectionId);
  }

  // --- toolbar --------------------------------------------------------------
  const bar = el("div", { class: "lib-bar" });
  // Breadcrumbs only appear when they actually tell you something — i.e. when
  // you've navigated into a folder or a special shelf. At the root there's
  // nothing to disambiguate, so no redundant "My Library" heading.
  const showCrumbs = view.showArchived || view.bookmarks || q || view.collectionId != null;
  if (showCrumbs) {
    const crumbs = el("div", { class: "crumbs" });
    if (view.showArchived) {
      const back = el("button", { class: "crumb" }, ["My Library"]);
      back.addEventListener("click", () => app.setLibraryArchived(false));
      crumbs.appendChild(back);
      crumbs.appendChild(el("span", { class: "crumb current", text: "Archived" }));
    } else if (view.bookmarks) {
      const back = el("button", { class: "crumb" }, ["My Library"]);
      back.addEventListener("click", () => app.setLibraryBookmarks(false));
      crumbs.appendChild(back);
      crumbs.appendChild(el("span", { class: "crumb current", text: "Bookmarks" }));
    } else {
      crumbs.appendChild(crumb(app, "My Library", null, view.collectionId == null));
      for (const f of path) crumbs.appendChild(crumb(app, f.name || "Folder", f.id, f.id === view.collectionId));
    }
    if (q) crumbs.appendChild(el("span", { class: "crumb-search", text: `Searching all of your library` }));
    bar.appendChild(crumbs);
  }

  const actions = el("div", { class: "lib-actions" });
  if (view.collectionId != null && !view.showArchived && !q) {
    const playBtn = el("button", { class: "chip " + (books.length ? "play-col" : ""), title: "Play this collection as a queue", disabled: !books.length }, [icon("headphones", { size: 15 }), "Play all"]);
    playBtn.addEventListener("click", () => app.playCollection(view.collectionId));
    actions.appendChild(playBtn);
  }
  const archivedCount = all.filter((b) => b.archived).length;
  const bmCount = (app.bookmarks || []).length;
  const bookmarksBtn = el("button", { class: "chip" + (view.bookmarks ? " active" : ""), title: "Saved spots, notes and tags" }, [
    icon(view.bookmarks ? "bookmarkFill" : "bookmark", { size: 15 }),
    bmCount ? "Bookmarks (" + bmCount + ")" : "Bookmarks",
  ]);
  bookmarksBtn.addEventListener("click", () => app.setLibraryBookmarks(!view.bookmarks));
  actions.appendChild(bookmarksBtn);

  const archBtn = el("button", { class: "chip" + (view.showArchived ? " active" : ""), title: "Archived audiobooks" }, [
    icon(view.showArchived ? "unarchive" : "archive", { size: 15 }),
    archivedCount ? "Archived (" + archivedCount + ")" : "Archived",
  ]);
  archBtn.addEventListener("click", () => app.setLibraryArchived(!view.showArchived));
  actions.appendChild(archBtn);

  // --- filter (read status + tags) -----------------------------------------
  const activeFilterCount = (readFilter !== "all" ? 1 : 0) + (tagFilter.length ? 1 : 0);
  if (!view.bookmarks) {
    const pick = el("div", { class: "tag-filter" });
    const fBtn = el("button", {
      class: "tag-btn" + ((activeFilterCount || view.filterOpen) ? " on" : ""),
      "aria-haspopup": "true",
      "aria-expanded": view.filterOpen ? "true" : "false",
      title: "Filter by read status and tags",
    }, [
      icon("filter", { size: 15 }),
      activeFilterCount ? `Filter (${activeFilterCount})` : "Filter",
      el("span", { html: icon("chevronDown", { size: 15 }) }),
    ]);
    const fpop = el("div", { class: "tag-pop lib-filter-pop" });
    fpop.hidden = !view.filterOpen;
    fpop.appendChild(el("div", { class: "fp-label", text: "Read status" }));
    const readChips = el("div", { class: "chips" });
    for (const [key, labelTxt] of [["all", "All"], ["unread", "Unread"], ["read", "Read"]]) {
      readChips.appendChild(chip(labelTxt, { active: readFilter === key, onClick: () => app.setLibraryFilter({ readFilter: key }) }));
    }
    fpop.appendChild(readChips);
    const allTags = [];
    for (const b of all) for (const g of (b.tags || [])) if (!allTags.includes(g)) allTags.push(g);
    allTags.sort((a, b) => a.localeCompare(b));
    if (allTags.length) {
      fpop.appendChild(el("div", { class: "fp-label", text: "Tags" }));
      const tagChips = el("div", { class: "chips" });
      for (const t of allTags) tagChips.appendChild(chip(t, { active: tagFilter.includes(t), onClick: () => app.toggleLibraryTag(t) }));
      fpop.appendChild(tagChips);
    }
    if (activeFilterCount) {
      const foot = el("div", { class: "chips", style: { marginTop: "12px" } });
      foot.appendChild(chip("Clear filters", { onClick: () => app.clearLibraryFilters() }));
      fpop.appendChild(foot);
    }
    fBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      view.filterOpen = !view.filterOpen;
      fpop.hidden = !view.filterOpen;
      if (view.filterOpen) {
        // Keep the popover inside the viewport: clamp its left edge to the chip.
        const r = pick.getBoundingClientRect();
        const w = Math.min(300, window.innerWidth - 24);
        const left = Math.max(12, Math.min(r.left, window.innerWidth - w - 12));
        fpop.style.width = w + "px";
        fpop.style.left = (left - r.left) + "px";
        fpop.style.right = "auto";
        if (app._filterOutside) document.removeEventListener("click", app._filterOutside);
        app._filterOutside = (ev) => {
          if (pick.contains(ev.target)) return;
          document.removeEventListener("click", app._filterOutside);
          app._filterOutside = null;
          view.filterOpen = false;
          fpop.hidden = true;
        };
        setTimeout(() => document.addEventListener("click", app._filterOutside), 0);
      }
    });
    pick.append(fBtn, fpop);
    actions.appendChild(pick);
  }

  const newBtn = el("button", { class: "chip", title: "New collection" }, [icon("folderPlus", { size: 15 }), "New collection"]);
  newBtn.addEventListener("click", () => app.newFolder(view.collectionId));
  actions.appendChild(newBtn);

  const backupBtn = el("button", { class: "chip", title: "Back up or export your library" }, [icon("database", { size: 15 }), "Backup"]);
  backupBtn.addEventListener("click", () => app.openBackupModal());
  actions.appendChild(backupBtn);

  const importBtn = el("button", { class: "chip", title: "Import a library backup" }, [icon("upload", { size: 15 }), "Import"]);
  importBtn.addEventListener("click", () => app.pickImportFile());
  actions.appendChild(importBtn);

  // PORT: device sync needs the Perchance coordination server, so the chip is
  // disabled with an explanatory tooltip instead of opening the sync modal.
  const syncBtn = el("button", { class: "chip", id: "syncBtnEl", title: "Device sync needs the Perchance server — unavailable in this standalone build", disabled: true }, [
    icon("sync", { size: 15 }), "Device sync",
  ]);
  actions.appendChild(syncBtn);
  bar.appendChild(actions);
  host.appendChild(bar);

  if (view.bookmarks) { renderBookmarksView(app, host, q); return; }

  if (!all.length && !folders.length) {
    host.appendChild(emptyState({
      iconName: "library", title: "Your library is empty",
      text: "Create an audiobook from any text. Your books live on this device and play instantly.",
      actionLabel: "Create an audiobook", onAction: () => app.navigate("create"),
    }));
    return;
  }

  if (!folderList.length && !books.length) {
    if (q) {
      host.appendChild(emptyState({ iconName: "search", title: "No matches", text: `Nothing in your library matches “${app.searchQuery}”.` }));
    } else if (activeFilterCount) {
      host.appendChild(emptyState({ iconName: "filter", title: "Nothing matches", text: "No audiobooks match the current filters. Try clearing them." }));
    } else if (view.showArchived) {
      host.appendChild(emptyState({ iconName: "archive", title: "Nothing archived", text: "Archive an audiobook from its options menu to tuck it away here without deleting it." }));
    } else if (view.collectionId != null) {
      host.appendChild(emptyState({ iconName: "folder", title: "This collection is empty", text: "Drag audiobooks onto it, or use “Add to collection” from an audiobook's options." }));
    } else {
      host.appendChild(emptyState({ iconName: "library", title: "Nothing here yet", text: "Create an audiobook from any text to fill your library." }));
    }
    return;
  }

  // Folders are their own segment above the shelf of books, in a shorter tile.
  if (folderList.length) {
    const fgrid = el("div", { class: "grid folder-grid" });
    for (const f of folderList) {
      const count = pool.filter((b) => (b.collectionId ?? null) === f.id).length;
      const fc = folderCard(f, {
        count,
        onOpen: () => app.setCollection(f.id),
        onMenu: () => app.folderMenu(f),
        onContext: (col, pos) => app.folderContextMenu(col, pos),
      });
      wireFolderDrag(app, fc, f);
      fgrid.appendChild(fc);
    }
    host.appendChild(fgrid);
  }
  if (books.length) {
    const grid = el("div", { class: "grid lib-grid" + (folderList.length ? " below-folders" : "") });
    for (const b of books) {
      const pos = (app.positions && app.positions[b.id]) || null;
      const mark = playerMark(app, b);
      const progress = mark.current ? app.player.getState().progress : (pos ? pos.progress : 0);
      const card = bookCard(b, {
        onOpen: (bk) => app.openBook(bk),
        progress,
        onLongPress: (bk, pt) => app.bookContextMenu(bk, pt),
        ...mark,
      });
      if (b.archived) card.classList.add("archived");
      wireBookDrag(app, card, b);
      wireBookReorder(app, card, b);
      const menu = el("button", { class: "card-menu", title: "Options", html: "⋯" });
      menu.addEventListener("click", (e) => { e.stopPropagation(); app.openBookMenu(b); });
      card.appendChild(menu);
      grid.appendChild(card);
    }
    host.appendChild(grid);
  }

  if (q) {
    host.appendChild(el("div", { class: "hint", style: { marginTop: "18px", textAlign: "center" }, text: books.length + (books.length === 1 ? " match" : " matches") + " across your library" }));
  }
}

function crumb(app, label, id, isCurrent) {
  const b = el("button", { class: "crumb" + (isCurrent ? " current" : "") }, [label]);
  if (!isCurrent) b.addEventListener("click", () => app.setCollection(id));
  // Breadcrumbs double as drop targets so a book can be dragged back out.
  b.addEventListener("dragover", (e) => { if (isCurrent) return; if (!app.libraryView.drag) return; e.preventDefault(); b.classList.add("drop-hot"); });
  b.addEventListener("dragleave", () => b.classList.remove("drop-hot"));
  b.addEventListener("drop", (e) => {
    e.preventDefault();
    b.classList.remove("drop-hot");
    app.handleDrop(id);
  });
  return b;
}

function isDescendant(folders, ancestorId, maybeChildId) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  let cur = maybeChildId;
  let guard = 0;
  while (cur != null && byId.has(cur) && guard++ < 64) {
    if (cur === ancestorId) return true;
    cur = byId.get(cur).parentId ?? null;
  }
  return false;
}

function wireBookDrag(app, card, book) {
  card.draggable = true;
  card.addEventListener("dragstart", (e) => {
    app.libraryView.drag = { type: "book", id: book.id };
    card.classList.add("dragging");
    try { e.dataTransfer.setData("text/plain", book.id); e.dataTransfer.effectAllowed = "move"; } catch (err) {}
  });
  card.addEventListener("dragend", () => { app.libraryView.drag = null; card.classList.remove("dragging"); });
}

// Dropping a book onto another book in the SAME collection reorders the queue
// (an insertion line shows where it will land). Dropping onto a folder or
// breadcrumb still moves it between collections, handled elsewhere.
function wireBookReorder(app, card, book) {
  const sameCollection = () => {
    const drag = app.libraryView.drag;
    if (!drag || drag.type !== "book" || drag.id === book.id) return null;
    const dragged = (app.library || []).find((b) => b.id === drag.id);
    if (!dragged) return null;
    if ((dragged.collectionId ?? null) !== (book.collectionId ?? null)) return null;
    return dragged;
  };
  card.addEventListener("dragover", (e) => {
    if (!sameCollection()) return;
    e.preventDefault();
    e.stopPropagation();
    const r = card.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    card.classList.toggle("drop-before", before);
    card.classList.toggle("drop-after", !before);
  });
  const clear = () => card.classList.remove("drop-before", "drop-after");
  card.addEventListener("dragleave", clear);
  card.addEventListener("drop", (e) => {
    const dragged = sameCollection();
    clear();
    if (!dragged) return;
    e.preventDefault();
    e.stopPropagation();
    app.libraryView.drag = null;
    const r = card.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    const list = app.sortByOrder((app.library || []).filter((b) => (b.collectionId ?? null) === (book.collectionId ?? null)));
    const targetIdx = list.findIndex((b) => b.id === book.id);
    const fromIdx = list.findIndex((b) => b.id === dragged.id);
    let newIndex = before ? targetIdx : targetIdx + 1;
    if (fromIdx < newIndex) newIndex--;
    app.movePosition(dragged.id, newIndex);
  });
}

function wireFolderDrag(app, node, folder) {
  node.draggable = true;
  node.addEventListener("dragstart", (e) => {
    app.libraryView.drag = { type: "folder", id: folder.id };
    node.classList.add("dragging");
    try { e.dataTransfer.setData("text/plain", folder.id); e.dataTransfer.effectAllowed = "move"; } catch (err) {}
  });
  node.addEventListener("dragend", () => { app.libraryView.drag = null; node.classList.remove("dragging"); });
  const canDrop = () => {
    const drag = app.libraryView.drag;
    if (!drag) return false;
    if (drag.type === "folder") return drag.id !== folder.id && !isDescendant(app.collections || [], drag.id, folder.id);
    return true;
  };
  node.addEventListener("dragover", (e) => {
    if (!canDrop()) return;
    e.preventDefault();
    node.classList.add("drop-hot");
  });
  node.addEventListener("dragleave", () => node.classList.remove("drop-hot"));
  node.addEventListener("drop", (e) => {
    e.preventDefault();
    node.classList.remove("drop-hot");
    if (!canDrop()) return;
    app.handleDrop(folder.id);
  });
}

function matchesQuery(b, q) {
  return (
    (b.title || "").toLowerCase().includes(q) ||
    (b.author || "").toLowerCase().includes(q) ||
    (b.tags || []).some((g) => String(g).toLowerCase().includes(q))
  );
}

// ===========================================================================
// Library: the Bookmarks shelf
// ===========================================================================
function bookmarkMatches(bm, q) {
  return (
    (bm.bookTitle || "").toLowerCase().includes(q) ||
    (bm.note || "").toLowerCase().includes(q) ||
    (bm.snippet || "").toLowerCase().includes(q) ||
    (bm.tags || []).some((t) => String(t).toLowerCase().includes(q))
  );
}

function renderBookmarksView(app, host, q) {
  const all = (app.bookmarks || []).slice();
  const tag = app.libraryView.bookmarkTag || null;

  const counts = new Map();
  for (const bm of all) for (const t of bm.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  const tags = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  let list = all;
  if (tag) list = list.filter((bm) => (bm.tags || []).includes(tag));
  if (q) list = list.filter((bm) => bookmarkMatches(bm, q));

  if (!all.length) {
    host.appendChild(emptyState({
      iconName: "bookmark", title: "No bookmarks yet",
      text: "While listening, tap the bookmark button to save a spot. Add a note or a tag to find it again later — then play a whole set back to back.",
    }));
    return;
  }

  const filter = el("div", { class: "chips bm-filter" });
  filter.appendChild(el("button", { class: "chip" + (tag ? "" : " active"), onclick: () => app.setBookmarkTag(null) }, ["All (" + all.length + ")"]));
  for (const [t, n] of tags) {
    filter.appendChild(el("button", { class: "chip" + (t === tag ? " active" : ""), onclick: () => app.setBookmarkTag(t) }, [t + " (" + n + ")"]));
  }
  if (tags.length) {
    const manage = el("button", { class: "chip ghost bm-manage", title: "Rename or delete tags" }, [icon("tag", { size: 14 }), "Manage"]);
    manage.addEventListener("click", () => app.openTagManager());
    filter.appendChild(manage);
  }
  host.appendChild(filter);

  if (!list.length) {
    host.appendChild(emptyState({
      iconName: "search", title: "Nothing here",
      text: tag ? `No bookmarks are tagged “${tag}”.` : `Nothing matches “${app.searchQuery}”.`,
    }));
    return;
  }

  const head = el("div", { class: "bm-playall" });
  const playBtn = el("button", { class: "btn btn-primary" }, [icon("playAll", { size: 17 }), tag ? `Play “${tag}” (${list.length})` : `Play all (${list.length})`]);
  playBtn.addEventListener("click", () => app.playBookmarkQueue(list.map((b) => b.id), { label: tag ? "#" + tag : null }));
  head.append(playBtn, el("span", { class: "hint", text: "Plays these bookmarks back to back." }));
  host.appendChild(head);

  const rows = el("div", { class: "bm-list" });
  for (const bm of list) rows.appendChild(bookmarkRow(app, bm));
  host.appendChild(rows);
}

function bookmarkRow(app, bm) {
  const row = el("div", { class: "bm-row", role: "button", tabindex: "0" });
  const jump = el("button", { class: "bm-jump", title: "Play from here", "aria-label": "Play from here", html: icon("play", { size: 18 }) });
  jump.addEventListener("click", (e) => { e.stopPropagation(); app.openBookmarkSpot(bm); });
  const body = el("div", { class: "bm-body" });
  body.appendChild(el("div", { class: "bm-top" }, [
    el("span", { class: "bm-title", text: bm.bookTitle || "Untitled" }),
    el("span", { class: "bm-time", text: formatDuration(bm.sec) + (bm.totalSec ? " / " + formatDuration(bm.totalSec) : "") }),
  ]));
  if (bm.snippet) body.appendChild(el("p", { class: "bm-quote", text: "“" + bm.snippet + "”" }));
  if (bm.note) body.appendChild(el("p", { class: "bm-note", text: bm.note }));
  if ((bm.tags || []).length) {
    const meta = el("div", { class: "bm-meta" });
    for (const t of bm.tags) {
      const c = el("button", { class: "chip bm-tag" }, [t]);
      c.addEventListener("click", (e) => { e.stopPropagation(); app.setBookmarkTag(t); });
      meta.appendChild(c);
    }
    body.appendChild(meta);
  }
  row.append(jump, body);
  const more = el("button", { class: "bm-more", title: "Bookmark options", "aria-label": "Bookmark options", html: "⋯" });
  more.addEventListener("click", (e) => { e.stopPropagation(); app.openBookmarkMenu(bm); });
  row.appendChild(more);
  const open = () => app.openBookmarkSpot(bm);
  row.addEventListener("click", open);
  row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  return row;
}

// ===========================================================================
// Create
// ===========================================================================
export function renderCreate(app) {
  const host = $("#viewCreate");
  if (!host) return;
  if (app.reformat.run) app.stopReformat();
  host.innerHTML = "";
  const c = app.create;
  if (!c.voice) c.voice = app.settings.voice;
  // A draft saved before a voice was retired resolves forward (see resolveVoice).
  c.voice = resolveVoice(c.voice) || app.settings.voice;

  const wrap = el("div", { class: "create-wrap" });

  const textBlock = el("div", { class: "create-text" });

  const dz = el("div", { class: "dropzone" });
  const ta = el("textarea", { class: "textarea", placeholder: "Paste your text here, or drop a document…", spellcheck: "false", "aria-label": "Text to narrate" });
  ta.value = c.text || "";
  ta.addEventListener("input", () => { c.text = ta.value; updateStats(); app.saveCreateDraft(); });
  dz.appendChild(ta);

  const status = el("div", { class: "hint create-status" });

  textBlock.appendChild(dz);

  const actions = el("div", { class: "chips create-actions" });
  const urlBtn = el("button", { class: "chip" }, [icon("link", { size: 15 }), "From a URL…"]);
  urlBtn.addEventListener("click", () => openUrlImportModal(app, ta, status, c, updateStats));
  const fileBtn = el("button", { class: "chip" }, [icon("fileText", { size: 15 }), "Open a file…"]);
  const fileInput = el("input", { type: "file", accept: ACCEPT, style: { display: "none" } });
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) loadFile(app, fileInput.files[0], ta, status, c, updateStats);
    fileInput.value = "";
  });
  fileBtn.addEventListener("click", () => fileInput.click());

  // --- Reformat text (AI cleanup, off until the toggle is switched on) ------
  const rfPresetSel = el("select", { class: "select rf-preset", "aria-label": "Reformat task" });
  for (const p of REFORMAT_PRESETS) rfPresetSel.appendChild(el("option", { value: p.id, text: p.label }));
  rfPresetSel.value = c.reformatPreset || "audiobook";
  const rfCustom = el("input", { class: "input rf-custom", type: "text", placeholder: "e.g. convert to english", spellcheck: "false", autocapitalize: "off" });
  rfCustom.value = c.reformatCustom || "";
  const rfRunBtn = el("button", { class: "btn btn-primary rf-run" }, [icon("sparkle", { size: 16 }), "Reformat"]);
  const rfHint = el("div", { class: "hint rf-hint" });
  const rfBar = el("div", { class: "panel rf-bar", hidden: !c.reformatOn }, [
    el("div", { class: "rf-bar-row" }, [rfPresetSel, rfCustom]),
    el("div", { class: "rf-bar-foot" }, [rfHint, rfRunBtn]),
  ]);
  // PORT: reformatting needs the Perchance AI backend, so the toggle is disabled
  // with an explanatory tooltip instead of opening the AI cleanup panel.
  const reformatBtn = el("button", {
    class: "chip rf-toggle",
    title: "Reformat text needs the Perchance backend — unavailable in this standalone build",
    disabled: true,
  }, [icon("sparkle", { size: 15 }), "Reformat text"]);

  const clearBtn = el("button", { class: "chip ghost", style: { marginLeft: "auto" }, title: "Clear text" }, ["Clear"]);
  clearBtn.addEventListener("click", () => { ta.value = ""; c.text = ""; status.textContent = ""; updateStats(); app.saveCreateDraft(); });
  actions.append(urlBtn, fileBtn, reformatBtn, clearBtn, fileInput);
  textBlock.appendChild(actions);
  textBlock.appendChild(rfBar);

  const statsHint = el("div", { class: "hint create-stats" });
  textBlock.appendChild(el("div", { class: "create-foot" }, [status, statsHint]));

  wrap.appendChild(textBlock);

  // ---- narrator + create, in one compact panel -----------------------------
  const setup = el("div", { class: "panel create-setup" });

  const voiceSelect = el("select", { class: "select", "aria-label": "Narrator voice" });
  const light = ALL_VOICES.filter((v) => LIGHT_VOICE_IDS.includes(v.id));
  const featured = ALL_VOICES.filter((v) => FEATURED_VOICE_IDS.includes(v.id));
  const others = ALL_VOICES.filter((v) => !FEATURED_VOICE_IDS.includes(v.id) && !LIGHT_VOICE_IDS.includes(v.id));
  const og0 = el("optgroup", { label: "Light & fast" });
  for (const v of light) og0.appendChild(el("option", { value: v.id, text: `${v.name} · ${v.gender} · ${v.tag || "tiny download"}` }));
  const og1 = el("optgroup", { label: "Recommended" });
  for (const v of featured) og1.appendChild(el("option", { value: v.id, text: `${v.name} · ${v.gender}` }));
  const og2 = el("optgroup", { label: "More voices" });
  for (const v of others) og2.appendChild(el("option", { value: v.id, text: `${v.name} · ${v.gender} · ${v.lang === "en-gb" ? "UK" : "US"}` }));
  voiceSelect.append(og0, og1, og2);
  voiceSelect.value = c.voice;
  voiceSelect.addEventListener("change", () => { c.voice = voiceSelect.value; app.saveCreateDraft(); });
  const prevBtn = el("button", { class: "icon-btn voice-prev", title: "Preview voice", "aria-label": "Preview voice", html: icon("play", { size: 18 }) });
  prevBtn.addEventListener("click", () => app.previewVoice(c.voice, prevBtn));

  const goBtn = el("button", { class: "btn btn-primary create-go-btn", disabled: true }, [icon("headphones", { size: 18 }), "Create audiobook"]);
  goBtn.addEventListener("click", () => app.createBook());

  setup.appendChild(el("div", { class: "voice-pick" }, [voiceSelect, prevBtn]));
  setup.appendChild(goBtn);
  wrap.appendChild(setup);

  const privacy = el("div", { class: "privacy-note" }, [
    el("span", { class: "privacy-ic", html: icon("lock", { size: 15 }) }),
    el("span", { text: "Your audio stays on your own device, completely private, unless you choose to share it." }),
  ]);
  wrap.appendChild(privacy);

  const stage = createReformatStage(app, {
    hideNodes: [textBlock, setup, privacy],
    onApply: (text) => {
      ta.value = text;
      c.text = text;
      updateStats();
      app.saveCreateDraft();
      toast("Reformatted text applied");
    },
  });
  wrap.appendChild(stage.node);

  host.appendChild(wrap);

  // --- reformat wiring ------------------------------------------------------
  function reformatTask() {
    const p = presetById(rfPresetSel.value);
    return p.id === "custom" ? rfCustom.value.trim() : p.task;
  }
  function syncPreset() {
    const p = presetById(rfPresetSel.value);
    rfCustom.hidden = p.id !== "custom";
    rfHint.textContent = p.id === "custom"
      ? "Describe the change you want, e.g. \u201cconvert to english\u201d."
      : p.hint;
    updateStats();
  }
  rfPresetSel.addEventListener("change", () => {
    c.reformatPreset = rfPresetSel.value;
    app.saveCreateDraft({ reformatPreset: rfPresetSel.value });
    syncPreset();
  });
  rfCustom.addEventListener("input", () => {
    c.reformatCustom = rfCustom.value;
    app.saveCreateDraft({ reformatCustom: rfCustom.value });
  });
  rfRunBtn.addEventListener("click", () => {
    const text = (c.text || "").trim();
    if (wordCount(text) < 3) { toast("Add or open some text first", { type: "error" }); return; }
    const task = reformatTask();
    if (!task) { toast("Describe what to do to the text", { type: "error" }); rfCustom.focus(); return; }
    const p = presetById(rfPresetSel.value);
    stage.start({ text: c.text, task, label: p.id === "custom" ? `Custom \u2014 ${rfCustom.value.trim()}` : p.label });
  });
  syncPreset();

  c.refs = { ta, goBtn, voiceSelect, status, dz, acceptFile: (f) => loadFile(app, f, ta, status, c, updateStats) };

  function updateStats() {
    const text = c.text || "";
    const words = wordCount(text);
    const chunks = app.countChunks(text);
    statsHint.textContent = words > 0
      ? `${words.toLocaleString()} words · ${chunks.toLocaleString()} segments · ~${formatLongDuration((words / WORDS_PER_MINUTE) * 60)}`
      : "";
    goBtn.disabled = words < 3;
    clearBtn.hidden = words === 0;
    rfRunBtn.disabled = words < 3;
  }
  updateStats();

  if (app.focusCreateText) {
    app.focusCreateText = false;
    setTimeout(() => ta.focus(), 120);
  }
}

// ===========================================================================
// Reformat stage — the live view shown while a document is being rewritten.
// One card per segment: the original text on demand, the model's reply as it
// streams, then a highlighted before/after diff once the segment is done.
// ===========================================================================
function createReformatStage(app, { onApply, hideNodes = [] }) {
  const state = { plan: null, results: [], task: "", label: "", running: false, follow: true, startedAt: 0, done: 0, failed: 0, changed: 0 };
  const cards = [];

  const spinner = el("span", { class: "spinner rf-spin" });
  const titleText = el("span", { text: "Reformatting text" });
  const taskEl = el("div", { class: "rf-task hint" });
  const bar = el("i");
  const countEl = el("div", { class: "rf-count hint" });
  const etaEl = el("div", { class: "rf-eta hint" });
  const stream = el("div", { class: "rf-stream" });
  const summaryEl = el("div", { class: "rf-summary hint" });
  const stopBtn = el("button", { class: "btn rf-stop" }, ["Stop"]);
  const useBtn = el("button", { class: "btn btn-primary rf-use", hidden: true }, [icon("check", { size: 16 }), "Use this text"]);
  const discardBtn = el("button", { class: "btn rf-discard", hidden: true }, ["Discard"]);

  const node = el("div", { class: "rf-stage", hidden: true }, [
    el("div", { class: "rf-head" }, [
      el("div", { class: "rf-head-main" }, [el("div", { class: "rf-title" }, [spinner, titleText]), taskEl]),
      el("div", { class: "rf-head-actions" }, [stopBtn, discardBtn, useBtn]),
    ]),
    el("div", { class: "rf-progress" }, [bar]),
    el("div", { class: "rf-meta" }, [countEl, etaEl]),
    stream,
    summaryEl,
  ]);

  stream.addEventListener("scroll", () => {
    state.follow = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 90;
  });

  function scrollTo(card) {
    if (!state.follow) return;
    stream.scrollTop = Math.max(0, card.offsetTop - stream.clientHeight * 0.3);
  }

  function previewLine(segLines) {
    const l = segLines.find((x) => x.trim()) || segLines[0] || "";
    return l.length > 140 ? l.slice(0, 140) + "…" : l;
  }

  function buildCards() {
    stream.innerHTML = "";
    cards.length = 0;
    state.plan.segments.forEach((seg, i) => {
      const segLines = state.plan.lines.slice(seg.a, seg.b + 1);
      const badge = el("span", { class: "rf-seg-badge" });
      const head = el("div", { class: "rf-seg-head" }, [
        el("span", { class: "rf-seg-n", text: `Segment ${i + 1}` }),
        badge,
      ]);
      const body = el("div", { class: "rf-seg-body" }, [
        el("div", { class: "rf-line rf-ctx rf-pending", text: previewLine(segLines) }),
      ]);
      const card = el("div", { class: "rf-seg", "data-state": "pending" }, [head, body]);
      cards.push({ card, badge, body, segLines, live: null });
      stream.appendChild(card);
    });
  }

  function recount() {
    let done = 0, failed = 0, changed = 0;
    for (const r of state.results) {
      if (!r) continue;
      done++;
      if (r.failed || r.parsed.mode === "unparsed") failed++;
      if (r.changed) changed++;
    }
    state.done = done; state.failed = failed; state.changed = changed;
  }

  function updateProgress() {
    const total = state.plan ? state.plan.segments.length : 0;
    bar.style.width = (total ? (state.done / total) * 100 : 0).toFixed(1) + "%";
    countEl.textContent = `${state.done} / ${total} segments${state.changed ? ` · ${state.changed} changed` : ""}${state.failed ? ` · ${state.failed} failed` : ""}`;
    if (state.running && state.done > 0) {
      const per = (Date.now() - state.startedAt) / state.done;
      etaEl.textContent = `~${formatLongDuration(Math.max(0, (total - state.done) * per) / 1000)} left`;
    } else if (!state.running) {
      etaEl.textContent = "";
    }
  }

  function renderDiff(box, diff) {
    for (const d of condenseDiff(diff, 2)) {
      if (d.t === "gap") {
        box.appendChild(el("div", { class: "rf-line rf-gap", text: `⋯ ${d.n} unchanged line${d.n > 1 ? "s" : ""}` }));
      } else {
        const mark = d.t === "del" ? "\u2212 " : d.t === "add" ? "+ " : "  ";
        box.appendChild(el("div", { class: "rf-line rf-" + d.t, text: mark + (d.text || "") }));
      }
    }
  }

  function finishCard(res) {
    const c = cards[res.index];
    if (!c) return;
    c.live = null;
    state.results[res.index] = res;
    recount();
    const desc = describeResult(res);
    c.badge.textContent = desc.label;
    c.badge.className = "rf-seg-badge rf-b-" + desc.kind;
    const bad = res.failed || res.parsed.mode === "unparsed";
    c.card.dataset.state = bad ? "failed" : "done";
    c.body.innerHTML = "";
    if (res.changed) {
      const box = el("div", { class: "rf-diff" });
      renderDiff(box, res.diff);
      c.body.appendChild(box);
    } else {
      c.body.appendChild(el("div", { class: "rf-line rf-ctx rf-pending", text: bad ? "No usable reply" : "No changes" }));
    }
    if (bad) {
      const retry = el("button", { class: "chip rf-retry" }, ["Retry this segment"]);
      retry.addEventListener("click", () => retrySegment(res.index));
      c.body.appendChild(retry);
      if (res.raw) c.body.appendChild(el("details", { class: "rf-raw" }, [
        el("summary", { text: "Model reply" }),
        el("pre", { class: "rf-live", text: res.raw }),
      ]));
    }
    updateProgress();
    scrollTo(c.card);
  }

  async function retrySegment(i) {
    const c = cards[i];
    if (!c || c.retrying || !state.plan) return;
    c.retrying = true;
    c.card.dataset.state = "active";
    c.badge.textContent = "retrying…";
    c.badge.className = "rf-seg-badge";
    c.body.innerHTML = "";
    const live = el("pre", { class: "rf-live rf-live-wait", text: "Retrying…" });
    c.body.appendChild(live);
    c.live = live;
    scrollTo(c.card);
    try {
      const res = await app.runReformatSegment({
        segLines: c.segLines, task: state.task, index: i, total: state.plan.segments.length,
        hooks: { onSegmentDelta: (idx, chunk, raw) => { live.textContent = raw.length > 4000 ? "…" + raw.slice(-4000) : raw; } },
      });
      res.index = i;
      c.retrying = false;
      finishCard(res);
    } catch (e) {
      c.retrying = false;
      finishCard({ index: i, before: c.segLines, after: c.segLines, parsed: { mode: "unparsed", ops: [], warnings: [] }, diff: [], changed: false, failed: true, raw: "" });
    }
  }

  function currentText() {
    if (!state.plan) return "";
    const out = [];
    state.plan.segments.forEach((s, i) => {
      const r = state.results[i];
      if (r && r.after) out.push(...r.after);
      else out.push(...state.plan.lines.slice(s.a, s.b + 1));
    });
    return mergeContinuations(out).join("\n");
  }

  function closeStage() {
    node.hidden = true;
    for (const n of hideNodes) n.hidden = false;
    app.reformat.stage = null;
  }

  stopBtn.addEventListener("click", () => {
    stopBtn.disabled = true;
    stopBtn.textContent = "Stopping…";
    app.stopReformat();
  });
  useBtn.addEventListener("click", () => { onApply(currentText()); closeStage(); });
  discardBtn.addEventListener("click", closeStage);

  function start({ text, task, label }) {
    state.plan = planSegments(text, { maxWords: 360 });
    state.results = new Array(state.plan.segments.length);
    state.task = task;
    state.label = label;
    state.running = true;
    state.follow = true;
    state.startedAt = Date.now();
    state.done = 0; state.failed = 0; state.changed = 0;
    titleText.textContent = "Reformatting text";
    spinner.hidden = false;
    stopBtn.hidden = false; stopBtn.disabled = false; stopBtn.textContent = "Stop";
    useBtn.hidden = true; discardBtn.hidden = true;
    summaryEl.textContent = "";
    taskEl.textContent = label;
    buildCards();
    updateProgress();
    node.hidden = false;
    for (const n of hideNodes) n.hidden = true;
    app.reformat.stage = api;
    window.scrollTo({ top: 0, behavior: "smooth" });
    app.runReformat({
      text, task, maxWords: 360,
      hooks: {
        onSegmentStart: (i, total, segLines) => {
          const c = cards[i];
          if (!c) return;
          c.card.dataset.state = "active";
          c.body.innerHTML = "";
          const origLines = el("div", { class: "rf-orig-lines" });
          for (const l of segLines) origLines.appendChild(el("div", { class: "rf-line rf-ctx", text: l || " " }));
          const live = el("pre", { class: "rf-live rf-live-wait", text: "Reading segment…" });
          c.body.append(
            el("details", { class: "rf-orig" }, [
              el("summary", { text: `Original · ${segLines.length} line${segLines.length > 1 ? "s" : ""}` }),
              origLines,
            ]),
            live,
          );
          c.live = live;
          countEl.textContent = `${i} / ${total} segments${state.changed ? ` · ${state.changed} changed` : ""}`;
          scrollTo(c.card);
        },
        onSegmentDelta: (i, chunk, raw) => {
          const c = cards[i];
          if (!c || !c.live) return;
          c.live.textContent = raw.length > 4000 ? "…" + raw.slice(-4000) : raw;
          if (state.follow) stream.scrollTop = stream.scrollHeight;
        },
        onSegmentEnd: (res) => finishCard(res),
        onFinish: (summary) => {
          state.running = false;
          spinner.hidden = true;
          titleText.textContent = summary.stopped ? "Reformat stopped" : "Reformat complete";
          stopBtn.hidden = true;
          useBtn.hidden = false;
          discardBtn.hidden = false;
          recount();
          updateProgress();
          countEl.textContent = "";
          const mins = Math.round((Date.now() - state.startedAt) / 60000);
          summaryEl.textContent =
            `${state.done} of ${state.plan.segments.length} segments processed · ${state.changed} changed` +
            (summary.joinedSeams ? ` · mended ${summary.joinedSeams} split line${summary.joinedSeams > 1 ? "s" : ""}` : "") +
            (state.failed ? ` · ${state.failed} need attention` : "") +
            (mins >= 1 ? ` · ${mins} min` : "");
        },
        onError: () => {
          state.running = false;
          spinner.hidden = true;
          titleText.textContent = "Reformat failed";
          stopBtn.hidden = true;
          useBtn.hidden = false;
          discardBtn.hidden = false;
          countEl.textContent = "";
          summaryEl.textContent = "Something went wrong, but you can keep the segments that finished.";
        },
      },
    });
  }

  const api = { node, start, isRunning: () => state.running };
  return api;
}

async function loadFile(app, file, ta, status, c, updateStats) {
  if (file.size > MAX_FILE_BYTES) { toast("That file is too large (48 MB max)", { type: "error" }); return; }
  status.textContent = "Reading " + file.name + "…";
  try {
    const { text } = await fileToText(file, { onProgress: (s) => { status.textContent = s; } });
    if (!text || wordCount(text) < 3) throw new Error("no readable text");
    ta.value = text;
    c.text = text;
    updateStats();
    app.saveCreateDraft();
    status.textContent = "";
    toast("Loaded " + file.name + " · " + wordCount(text).toLocaleString() + " words");
  } catch (e) {
    status.textContent = "";
    toast("Couldn't read that file" + (e && e.message ? " — " + e.message : ""), { type: "error", timeout: 6000 });
  }
}

async function fetchReadableText(url) {
  let html = "";
  try {
    html = await root.superFetch(url).then((r) => r.text());
  } catch (e) {
    html = await fetch(url).then((r) => r.text());
  }
  try {
    const { Readability } = await import("https://esm.sh/@mozilla/readability@0.5.0");
    const doc = new DOMParser().parseFromString(html, "text/html");
    const article = new Readability(doc).parse();
    if (article && article.textContent && wordCount(article.textContent) >= 20) {
      const title = (article.title || "").trim();
      const body = article.textContent.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      return title ? title + "\n\n" + body : body;
    }
  } catch (e) {
    console.warn("readability failed, falling back:", e);
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style, nav, header, footer, aside, noscript, form, iframe, svg").forEach((n) => n.remove());
  const raw = doc.body ? doc.body.textContent || "" : "";
  return raw.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").replace(/[ \t]*\n[ \t]*/g, "\n").trim();
}

function openUrlImportModal(app, ta, status, c, updateStats) {
  const body = el("div");
  body.appendChild(el("p", { class: "hint", text: "Paste a link to an article or story and we'll pull the main text out of the page." }));
  const input = el("input", { class: "input", type: "url", placeholder: "https://example.com/article", autocapitalize: "off", spellcheck: "false" });
  body.appendChild(input);
  const statusEl = el("div", { class: "hint", style: { marginTop: "6px", minHeight: "18px" } });
  body.appendChild(statusEl);
  const fetchBtn = el("button", { class: "btn btn-primary" }, ["Fetch text"]);
  const setBusy = (busy) => {
    fetchBtn.disabled = busy;
    fetchBtn.innerHTML = "";
    if (busy) fetchBtn.appendChild(spinnerNode(16));
    fetchBtn.appendChild(document.createTextNode(busy ? " Fetching…" : "Fetch text"));
  };
  const doFetch = async () => {
    const url = input.value.trim();
    if (!/^https?:\/\//i.test(url)) { toast("Enter a full http(s) link", { type: "error" }); return; }
    setBusy(true);
    statusEl.textContent = "Downloading and extracting…";
    try {
      const text = await fetchReadableText(url);
      if (!text || wordCount(text) < 20) throw new Error("no readable text found");
      ta.value = text;
      c.text = text;
      updateStats();
      app.saveCreateDraft();
      closeModal();
      toast("Imported " + wordCount(text).toLocaleString() + " words");
    } catch (e) {
      statusEl.textContent = "";
      toast("Couldn't read that page (" + (e.message || "error") + ")", { type: "error" });
    } finally {
      setBusy(false);
    }
  };
  fetchBtn.addEventListener("click", doFetch);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doFetch(); } });
  body.appendChild(el("div", { class: "chips", style: { marginTop: "0", justifyContent: "flex-end" } }, [fetchBtn]));
  openModal({ title: "Import from a URL", body });
  setTimeout(() => input.focus(), 80);
}
