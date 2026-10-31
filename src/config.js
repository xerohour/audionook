// ===========================================================================
// config.js — app-wide configuration and shared constants.
//
// The constants in the "SERVER STATE CONTRACT" section below are mirrored
// byte-for-byte in the untrusted-but-authoritative server script at the top of
// index.html. If you change them, change BOTH (and bump STATE_VERSION, writing
// a migration if production already has data).
// ===========================================================================

export const STATE_VERSION = 3;

// --- Tags ------------------------------------------------------------------
// A tag is identified by its INDEX in this array, which is the bit position
// stored in the server's 32-byte (256-bit) tag field. Do NOT reorder without a
// server-side migration. Add new tags at the end.
export const TAGS = [
  "Fiction", "Non-fiction", "Literary Fiction", "Classics", "Contemporary",
  "Historical Fiction", "Satire", "Magical Realism", "Short Stories", "Anthology",
  "Essays", "Novella", "Poetry", "Drama", "Epistolary", "Experimental",
  "Fantasy", "Epic Fantasy", "High Fantasy", "Dark Fantasy", "Urban Fantasy",
  "Historical Fantasy", "Cozy Fantasy", "Gaslamp Fantasy", "Sword and Sorcery", "Grimdark",
  "Portal Fantasy", "Fairy Tale", "Mythology", "Folklore", "Legend", "Fable",
  "Sci-Fi", "Hard Sci-Fi", "Space Opera", "Cyberpunk", "Steampunk", "Biopunk",
  "Dystopia", "Post-Apocalyptic", "Apocalyptic", "Time Travel", "Alien Invasion", "First Contact",
  "Generation Ship", "Military Sci-Fi", "Climate Fiction", "Transhumanism",
  "Mystery", "Cozy Mystery", "Detective", "Noir", "Hardboiled", "Crime",
  "Thriller", "Psychological Thriller", "Legal Thriller", "Espionage", "Spy", "Heist",
  "Police Procedural", "Whodunit", "Conspiracy",
  "Horror", "Gothic", "Cosmic Horror", "Psychological Horror", "Supernatural", "Paranormal",
  "Ghost Story", "Vampire", "Werewolf", "Zombie", "Monster", "Body Horror", "Folk Horror", "Occult", "Haunting",
  "Romance", "Contemporary Romance", "Historical Romance", "Paranormal Romance", "Fantasy Romance", "Sci-Fi Romance",
  "Rom-Com", "Erotica", "Dark Romance", "LGBTQ+ Romance", "Second Chance", "Enemies to Lovers", "Forbidden Love",
  "Adventure", "Action", "Survival", "Exploration", "Disaster", "Western", "Pirate", "Sea Adventure",
  "Travel", "Expedition", "Wilderness",
  "History", "Historical", "Ancient History", "Ancient Rome", "Ancient Greece", "Ancient Egypt", "Ancient China", "Ancient Japan",
  "Medieval", "Renaissance", "Victorian", "Edwardian", "World War I", "World War II", "Cold War",
  "American Revolution", "Civil War", "Colonial", "Prehistoric", "Viking",
  "Science", "Popular Science", "Physics", "Astronomy", "Space", "Biology", "Evolution", "Chemistry", "Mathematics",
  "Technology", "Engineering", "Medicine", "Neuroscience", "Psychology",
  "Environment", "Nature", "Animals", "Plants", "Ecology", "Climate", "Earth Science",
  "Philosophy", "Ethics", "Religion", "Spirituality", "Politics", "Political Science",
  "Economics", "Business", "Finance", "Sociology", "Anthropology", "Archaeology", "Linguistics",
  "Education", "Law", "Military", "War", "True Crime", "Journalism", "Media Studies",
  "Cultural Studies", "Gender Studies", "Feminism", "Race", "Social Justice",
  "Biography", "Autobiography", "Memoir", "Diaries", "Letters",
  "Self-help", "Personal Development", "Motivation", "Health", "Fitness", "Nutrition", "Mindfulness",
  "Relationships", "Parenting", "Family", "Cooking", "Food", "Crafts", "Hobbies",
  "Art", "Art History", "Music", "Photography", "Film", "Architecture", "Design", "Fashion",
  "Sports", "Games", "Humor", "Comedy",
  "Children", "Middle Grade", "Young Adult", "New Adult", "Coming of Age", "Bildungsroman",
  "Family Saga", "Slice of Life", "Urban", "Rural", "Small Town", "Magical School",
  "Superhero", "Pulp", "Isekai", "LitRPG", "Cultivation", "Wuxia", "Xianxia",
  "Progression Fantasy", "Absurdist", "Bizarre", "Other",
  "Villainess", "Otome", "Reverse Harem", "Harem", "Shoujo", "Shounen", "Seinen", "Josei",
  "Light Novel", "Webnovel", "Webtoon", "Manhwa", "Manga", "Anime",
  "Transmigration", "Regression", "Reincarnation", "System", "Dungeon Core",
  "Monster Girl", "Academy", "Tournament", "Idol", "Mecha", "Magical Girl",
  "Romantasy", "Dark Academia", "Hopepunk", "Solarpunk", "Dieselpunk",
  "Splatterpunk", "Extreme Horror", "Weird West", "Afrofuturism",
];

// The tag field is a fixed 32-byte (256-bit) bitmask, so the tag list can grow
// to 256 entries without touching the server wire format.
export const TAG_BITS_BYTES = 32;
export const MAX_TAG_BITS = TAG_BITS_BYTES * 8; // 256
// How many tags a single book may carry.
export const MAX_TAGS_PER_BOOK = 8;

// A tag set is represented everywhere (book metadata, wire protocol, server
// rows) as a lowercase hex string of `TAG_BITS_BYTES * 2` characters.
const TAG_BITS_HEX = TAG_BITS_BYTES * 2;
const TAG_INDEX = new Map(TAGS.map((g, i) => [g.toLowerCase(), i]));

export function tagIndex(name) {
  const i = TAG_INDEX.get(String(name).toLowerCase());
  return i == null ? -1 : i;
}
function hexVal(code) {
  if (code >= 48 && code <= 57) return code - 48;   // 0-9
  if (code >= 97 && code <= 102) return code - 87;  // a-f
  if (code >= 65 && code <= 70) return code - 55;   // A-F
  return -1;
}
export function hexToTagBytes(hex) {
  const out = new Uint8Array(TAG_BITS_BYTES);
  const s = String(hex || "");
  for (let i = 0; i < TAG_BITS_BYTES; i++) {
    const hi = hexVal(s.charCodeAt(2 * i));
    const lo = hexVal(s.charCodeAt(2 * i + 1));
    out[i] = ((hi < 0 ? 0 : hi) << 4) | (lo < 0 ? 0 : lo);
  }
  return out;
}
export function tagBytesToHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] >> 4).toString(16) + (bytes[i] & 15).toString(16);
  return s;
}
export function emptyTagBits() { return "0".repeat(TAG_BITS_HEX); }

export function tagBitsFromNames(names) {
  const bytes = new Uint8Array(TAG_BITS_BYTES);
  for (const n of names || []) {
    const i = tagIndex(n);
    if (i >= 0) bytes[i >> 3] |= 1 << (i & 7);
  }
  return tagBytesToHex(bytes);
}
export function tagNamesFromBits(hex) {
  const bytes = hexToTagBytes(hex);
  const out = [];
  for (let i = 0; i < TAGS.length; i++) if (bytes[i >> 3] & (1 << (i & 7))) out.push(TAGS[i]);
  return out;
}
export function tagBitsHas(hex, name) {
  const i = tagIndex(name);
  if (i < 0) return false;
  return !!(hexToTagBytes(hex)[i >> 3] & (1 << (i & 7)));
}
export function toggleTagBit(hex, name) {
  const i = tagIndex(name);
  if (i < 0) return hex;
  const bytes = hexToTagBytes(hex);
  bytes[i >> 3] ^= 1 << (i & 7);
  return tagBytesToHex(bytes);
}
export function tagBitCount(hex) {
  const bytes = hexToTagBytes(hex);
  let n = 0;
  for (let i = 0; i < TAG_BITS_BYTES; i++) {
    let b = bytes[i];
    while (b) { n += b & 1; b >>= 1; }
  }
  return n;
}
export function tagBitsHasAny(hexA, hexB) {
  const a = hexToTagBytes(hexA), b = hexToTagBytes(hexB);
  for (let i = 0; i < TAG_BITS_BYTES; i++) if (a[i] & b[i]) return true;
  return false;
}

// Base hue per tag index so that a procedurally drawn cover looks
// tag-appropriate and, importantly, distinct book-to-book. The golden-angle
// step spreads consecutive tags around the colour wheel.
export function tagHue(index) {
  if (index == null || index < 0) return null;
  return Math.round((index * 137.508) % 360);
}
export function bookHue(book) {
  const g = (book && book.tags && book.tags[0]) || "";
  return tagHue(tagIndex(g));
}

import { PARADEE_VOICE_ID, TITL_HEART_VOICE_ID, PARADEE11_VOICE_ID } from "./paradee.js";

// --- Voices ----------------------------------------------------------------
// `paradee11_heart` is the Light voice: Paradee v1.1, an 8M-parameter model
// distilled from Kokoro-82M that speaks af_heart from an 8.5 MB file at
// ~50-100x realtime. It is listed first so pickers surface it in
// a "Light & fast" group; engineForVoice() in paradee.js routes it to its own
// worker pool instead of the Kokoro pool.
//
// NOTE: `paradee_heart` (the original Paradee voice) and `titl_heart`
// (Teacher-in-the-Loop) were removed from the pickers after losing the
// side-by-side comparison. Their ids are deliberately kept working in the
// engine, and LEGACY_VOICE_MAP below folds stored references forward to the
// v1.1 voice: existing books, per-book narrator overrides and shared links
// that reference them keep playing. Do not reuse the ids.
export { PARADEE_VOICE_ID, TITL_HEART_VOICE_ID, PARADEE11_VOICE_ID };
export const LIGHT_VOICE_IDS = [TITL_HEART_VOICE_ID, PARADEE11_VOICE_ID];

export const ALL_VOICES = [
  // `tag` is the trailing badge shown in the "Light & fast" picker group,
  // measured end-to-end on a many-core desktop against the full Kokoro pool
  // (see README "The Light voices"). Re-measure before changing it.
  { id: PARADEE11_VOICE_ID, name: "Heart", gender: "Female", lang: "en-us", tag: "(8x Faster)" },
  { id: "af_heart", name: "Heart", gender: "Female", lang: "en-us" },
  { id: "af_bella", name: "Bella", gender: "Female", lang: "en-us" },
  { id: "af_nicole", name: "Nicole", gender: "Female", lang: "en-us" },
  { id: "af_sarah", name: "Sarah", gender: "Female", lang: "en-us" },
  { id: "af_sky", name: "Sky", gender: "Female", lang: "en-us" },
  { id: "af_alloy", name: "Alloy", gender: "Female", lang: "en-us" },
  { id: "af_aoede", name: "Aoede", gender: "Female", lang: "en-us" },
  { id: "af_jessica", name: "Jessica", gender: "Female", lang: "en-us" },
  { id: "af_kore", name: "Kore", gender: "Female", lang: "en-us" },
  { id: "af_nova", name: "Nova", gender: "Female", lang: "en-us" },
  { id: "af_river", name: "River", gender: "Female", lang: "en-us" },
  { id: "am_michael", name: "Michael", gender: "Male", lang: "en-us" },
  { id: "am_adam", name: "Adam", gender: "Male", lang: "en-us" },
  { id: "am_echo", name: "Echo", gender: "Male", lang: "en-us" },
  { id: "am_eric", name: "Eric", gender: "Male", lang: "en-us" },
  { id: "am_fenrir", name: "Fenrir", gender: "Male", lang: "en-us" },
  { id: "am_liam", name: "Liam", gender: "Male", lang: "en-us" },
  { id: "am_onyx", name: "Onyx", gender: "Male", lang: "en-us" },
  { id: "am_puck", name: "Puck", gender: "Male", lang: "en-us" },
  { id: "am_santa", name: "Santa", gender: "Male", lang: "en-us" },
  { id: "bf_emma", name: "Emma", gender: "Female", lang: "en-gb" },
  { id: "bf_isabella", name: "Isabella", gender: "Female", lang: "en-gb" },
  { id: "bf_alice", name: "Alice", gender: "Female", lang: "en-gb" },
  { id: "bf_lily", name: "Lily", gender: "Female", lang: "en-gb" },
  { id: "bm_george", name: "George", gender: "Male", lang: "en-gb" },
  { id: "bm_lewis", name: "Lewis", gender: "Male", lang: "en-gb" },
  { id: "bm_daniel", name: "Daniel", gender: "Male", lang: "en-gb" },
  { id: "bm_fable", name: "Fable", gender: "Male", lang: "en-gb" },
];

// Shown first in the picker (the nicest-sounding, best-tested narrators).
export const FEATURED_VOICE_IDS = [
  "af_heart", "af_bella", "af_nicole", "am_michael", "am_adam",
  "bf_emma", "bm_george", "af_sarah",
];

export const DEFAULT_VOICE = "af_heart";

// Retired voice ids and what they map to. `paradee_heart` (v1.0) lost to
// `titl_heart`, which then lost to `paradee11_heart` (v1.1) — both fold
// forward to the v1.1 voice, so stored references (settings, drafts,
// per-book narrators, shared bundles) resolve to something the pickers carry
// and a <select> never goes blank. Cache keys already include the voice, so a
// legacy id's cached audio is simply orphaned (expires via the normal TTL)
// rather than served under the new name.
const LEGACY_VOICE_MAP = {
  [PARADEE_VOICE_ID]: PARADEE11_VOICE_ID,
  [TITL_HEART_VOICE_ID]: PARADEE11_VOICE_ID,
};

// Normalise a stored voice id to something the pickers and the engine accept.
// ""/null (per-book "follow the default") pass through untouched; unknown ids
// fall back to the default narrator. The legacy map is followed transitively
// so chains (v1.0 -> titl -> v1.1) always land on a listed voice.
export function resolveVoice(id) {
  if (id == null || id === "") return id;
  if (typeof id !== "string") return DEFAULT_VOICE;
  if (ALL_VOICES.some((v) => v.id === id)) return id;
  let next = LEGACY_VOICE_MAP[id];
  const seen = new Set([id]);
  while (next && !seen.has(next)) {
    if (ALL_VOICES.some((v) => v.id === next)) return next;
    seen.add(next);
    next = LEGACY_VOICE_MAP[next];
  }
  return DEFAULT_VOICE;
}

export function voiceLabel(id) {
  const v = ALL_VOICES.find((x) => x.id === id);
  if (!v) return id || "Unknown voice";
  return v.name;
}

// --- Server state contract (mirror of the layout in index.html's server) -----
// A slot holds ONLY the small, numeric, server-side-searchable metadata plus the
// title/author (needed for text search). Everything bulky that the feed needs to
// *display* or *play* — blurb, textUrl, coverUrl, voice — is bundled into a small
// uploaded `.json` file, and the slot keeps just that upload's 32-hex id.
export const STATE = {
  HEADER_SIZE: 32,
  RING_ENTRIES: 512,          // durable submission-rate ring buffer
  RING_ENTRY_SIZE: 8,         // {u32 netHash, u32 timeSec}
  SLOT_SIZE: 272,             // fixed record size
  // field byte offsets within a slot
  F_SEQ: 0,            // u32  0 = empty slot; otherwise the public book id
  F_LISTEN_SEC: 4,     // u32  accumulated listen seconds
  F_PLAYS: 8,          // u32
  F_WORD_COUNT: 12,    // u32
  F_CREATED: 16,       // u32  unix seconds
  F_HASH_A: 20,        // u32  text content hash (dedupe)
  F_HASH_B: 24,        // u32
  F_FLAGS: 28,         // u32
  F_TAG_BITS: 32,      // 32 bytes (256-bit tag mask)
  F_TITLE_LEN: 64,     // u8
  F_AUTHOR_LEN: 65,    // u8
  F_BUNDLE_LEN: 66,    // u8   byte length of the bundle-id
  F_LAST_LISTEN: 68,   // u32  unix seconds of most recent listen report
  F_BUNDLE_ID: 72,     // 44 bytes, ascii  (the uploaded bundle's 32-hex id)
  F_TITLE: 116,        // 112 bytes
  F_AUTHOR: 228,       // 40 bytes
};

export const MAXLEN = {
  title: 112, author: 40, bundleId: 44,
};

export const FLAG = {
  CUSTOM_COVER: 1 << 0,
  AI_TAGS: 1 << 1,
  FEATURED: 1 << 2,
};

// --- Explore / listing -----------------------------------------------------
export const PAGE_SIZE = 48;
export const SORTS = ["top", "new", "trending"];

// --- Content -----------------------------------------------------------------
// The blurb lives in the uploaded bundle (never in server state), so it can be
// generous; this is ~10x the original 110-char limit.
export const MAX_BLURB = 1100;
export const MAX_TITLE = 100;
export const MAX_AUTHOR = 40;

// --- Misc ------------------------------------------------------------------
export const APP_NAME = "Audionook";
export const SLEEP_OPTIONS = [
  { value: 0, label: "Off" },
  { value: 15, label: "15 minutes" },
  { value: 30, label: "30 minutes" },
  { value: 45, label: "45 minutes" },
  { value: 60, label: "1 hour" },
  { value: 90, label: "1 hour 30 minutes" },
  { value: 120, label: "2 hours" },
  { value: 180, label: "3 hours" },
];
export const DEFAULT_COLLECTION = null;
export const WORDS_PER_MINUTE = 155;
export const LISTEN_REPORT_INTERVAL_MS = 15000; // how often the player reports listen time
export const SHARE_PAYLOAD_VERSION = 2;

// How far the background chunk prefetch reaches from the playhead, in chunks.
// Infinity = the whole book: a linked device mirrors the entire audiobook into
// its local audio cache from the cache itself / a synced peer, so a book
// generated on a fast machine can be pulled down in one go and then played back
// without that machine staying online. Set finite values (e.g. { ahead: 20,
// behind: 2 }) to restore the lazy, near-the-playhead behaviour. See
// src/engine.js (TTSEngine._prefetch / setPrefetchWindow).
export const PREFETCH_WINDOW = { ahead: Infinity, behind: Infinity };
// Cover art is shown in the landscape card slot (`.card .cover` in styles.css),
// so a newly added image is cropped to this width:height ratio before it's kept.
export const COVER_ASPECT = 1.7;
export const SAMPLE_TEXT = "Here's an example of how I sound when I read to you.";
