// ===========================================================================
// port-shim.js — self-hosted replacement for Perchance's `root.*` plugin
// globals (see main.pjs in the original Perchance generator).
//
// This is a plain (non-module) script, loaded BEFORE the app's module script,
// so `window.root` exists by the time src/*.js reference the bare `root`
// global. Only the features that work without the Perchance backend are
// provided; everything server/AI-backed degrades to a clear error the app
// already knows how to surface (see PORT_NOTES.md).
// ===========================================================================
(function () {
  "use strict";

  // --- kv: IndexedDB-backed folder factory ----------------------------------
  // root.kv[name] -> { get, set, delete, keys, entries, clear }, all async,
  // never throwing. One IDB database ("audionook-kv"), one object store per
  // folder name. Values are stored as-is via structured clone.
  var DB_NAME = "audionook-kv";
  var _dbPromise = null;

  function db() {
    if (!_dbPromise) {
      _dbPromise = new Promise(function (resolve, reject) {
        var req;
        try {
          req = indexedDB.open(DB_NAME, 1);
        } catch (e) {
          reject(e);
          return;
        }
        req.onupgradeneeded = function () {
          // Stores are created lazily per folder (see folder() below), but
          // creating none here is fine — version upgrades are handled there.
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error || new Error("idb open failed")); };
      });
    }
    return _dbPromise;
  }

  function ensureStore(d, name) {
    if (d.objectStoreNames.contains(name)) return Promise.resolve(d);
    return new Promise(function (resolve, reject) {
      var version = d.version + 1;
      d.close();
      _dbPromise = null;
      var req = indexedDB.open(DB_NAME, version);
      req.onupgradeneeded = function () {
        var db2 = req.result;
        if (!db2.objectStoreNames.contains(name)) db2.createObjectStore(name);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error("idb upgrade failed")); };
      req.onblocked = function () { reject(new Error("idb upgrade blocked")); };
    });
  }

  function run(name, mode, fn) {
    return db()
      .then(function (d) { return ensureStore(d, name); })
      .then(function (d) {
        return new Promise(function (resolve, reject) {
          var tx, store, req;
          try {
            tx = d.transaction(name, mode);
            store = tx.objectStore(name);
            req = fn(store);
          } catch (e) {
            reject(e);
            return;
          }
          req.onsuccess = function () { resolve(req.result); };
          req.onerror = function () { reject(req.error || new Error("idb request failed")); };
        });
      });
  }

  function kvFolder(name) {
    return {
      get: function (key) {
        return run(name, "readonly", function (s) { return s.get(key); }).catch(function () { return undefined; });
      },
      set: function (key, value) {
        return run(name, "readwrite", function (s) { return s.put(value, key); })
          .then(function () { return undefined; })
          .catch(function () { return undefined; });
      },
      delete: function (key) {
        return run(name, "readwrite", function (s) { return s.delete(key); })
          .then(function () { return undefined; })
          .catch(function () { return undefined; });
      },
      keys: function () {
        return run(name, "readonly", function (s) { return s.getAllKeys(); })
          .catch(function () { return []; });
      },
      entries: function () {
        // getAllKeys + getAll in one transaction each; keys() is the primary
        // primitive the app actually uses (see storage.js kvFolder).
        return run(name, "readonly", function (s) { return s.getAllKeys(); })
          .then(function (keys) {
            return Promise.all(
              keys.map(function (k) {
                return run(name, "readonly", function (s2) { return s2.get(k); })
                  .then(function (v) { return [k, v]; })
                  .catch(function () { return [k, undefined]; });
              })
            );
          })
          .catch(function () { return []; });
      },
      clear: function () {
        return run(name, "readwrite", function (s) { return s.clear(); })
          .then(function () { return undefined; })
          .catch(function () { return undefined; });
      },
    };
  }

  var kvCache = Object.create(null);
  var kvProxy = new Proxy(
    {},
    {
      get: function (_, name) {
        if (typeof name !== "string") return undefined;
        if (!kvCache[name]) kvCache[name] = kvFolder(name);
        return kvCache[name];
      },
      // Enumerating plugin folders isn't part of the app's contract; keep the
      // proxy minimal.
      has: function () { return true; },
    }
  );

  // --- plugin stubs ----------------------------------------------------------
  function noServerError(what) {
    var e = new Error(what + " needs the Perchance backend \u2014 unavailable in this standalone build.");
    e.code = "NO_PERCHANCE_SERVER";
    return e;
  }

  var root = {
    // Plain fetch fallback for the URL text-import path (views.js already
    // falls back to fetch itself; the shim just makes root.superFetch work).
    superFetch: function (url, opts) {
      return fetch(url, opts);
    },

    kv: kvProxy,

    // Upload-based features (share links, publish bundles, device-sync relay).
    // Call sites in share.js check `res.error` and throw a clear message.
    uploadPlugin: async function () {
      return { error: "Sharing needs the Perchance backend \u2014 unavailable in this standalone build." };
    },

    // AI features (title inference, catalogue metadata, reformat-text,
    // listing moderation). MUST return an object and never throw: call sites
    // read `result.text` and treat empty/missing as failure (moderation fails
    // open by design; title inference keeps the provisional title).
    generateText: async function () {
      return { error: "AI features need the Perchance backend \u2014 unavailable in this standalone build." };
    },

    // Cover-art generation. Call sites are disabled in the UI; if one is ever
    // reached, the returned error object makes it fail with a clear message.
    generateImage: async function () {
      return { error: "Cover generation needs the Perchance backend \u2014 unavailable in this standalone build." };
    },

    // Server-backed features (Explore listing, device-sync coordination).
    // Throws a coded error so net.js can reuse its existing permanent
    // "blocked" path (the same one used for websocket close code 4403 when
    // the generator is embedded off perchance.org): no retry loop, ever.
    createServerSocket: function () {
      throw noServerError("Server features");
    },
  };

  window.root = root;
})();
