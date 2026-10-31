// ===========================================================================
// covers.js — cover art that lives on the device.
//
// A cover the user adds is stored LOCALLY (the `covers` folder in store.js) and
// is only uploaded when they actually share — a share link or a publish to
// Explore. Cards and the mini player need an image URL synchronously, so this
// module keeps a runtime map of object URLs keyed by book id. `coverUrlFor(book)`
// returns the remote URL when the book already has one (e.g. an Explore listing),
// else the local object URL (hydrated once on library load), else "".
//
// Object URLs are per page-load, so they're rebuilt from the stored blob each
// time the app boots; `forget()` releases one when its book goes away.
// ===========================================================================

import * as store from "./store.js";

const objectUrls = new Map();

export function coverUrlFor(book) {
  if (!book) return "";
  if (book.coverUrl) return book.coverUrl;
  return objectUrls.get(book.id) || "";
}

export function hasLocalCover(book) {
  return !!(book && !book.coverUrl && objectUrls.has(book.id));
}

export async function hydrate(book) {
  if (!book || !book.id) return "";
  if (book.coverUrl) return book.coverUrl;
  if (objectUrls.has(book.id)) return objectUrls.get(book.id);
  if (!book.coverLocal) return "";
  const blob = await store.getCover(book.id);
  if (!blob) return "";
  const url = URL.createObjectURL(blob);
  objectUrls.set(book.id, url);
  return url;
}

export async function hydrateAll(books) {
  await Promise.all((books || []).map((b) => hydrate(b).catch(() => {})));
}

export function set(bookId, blob) {
  forget(bookId);
  const url = URL.createObjectURL(blob);
  objectUrls.set(bookId, url);
  return url;
}

export function forget(bookId) {
  const url = objectUrls.get(bookId);
  if (url) {
    try { URL.revokeObjectURL(url); } catch (e) {}
    objectUrls.delete(bookId);
  }
}
