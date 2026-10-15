/* ============================================================================
 * Catalog extraction — shape agnostic.
 * ----------------------------------------------------------------------------
 * The first version only accepted one exact form:
 *   self.__next_f.push([1,"…\"initialModels\":[…],\"initialModelAId…"])
 * i.e. an escaped array immediately followed by an initialModelXId key. A real
 * logged-in page produced "0 models"; five other shapes turned out to be at least
 * as likely: unescaped payloads, a different following key, the list nested under
 * a "models" key, a plain JSON-string literal, and payloads split over several
 * pushes.
 *
 * Strategy: find the key, locate the '[' right after it, bracket-match the array
 * (string aware, so model names containing "]" like "… [web-search]" survive),
 * then parse. Escaped payloads are handled by decoding the region with JS string
 * semantics first — in `"{\"a\":1}"` the `\"` is a delimiter, not an escaped quote,
 * which is exactly what the old matcher got wrong.
 * ========================================================================== */
var KnowModelScan = (() => {
  'use strict';

  const KEYS = ['initialModels', 'availableModels', 'modelList', 'models'];
  const MAX_DECODE = 16 * 1024 * 1024;   // generous: the real catalog is ~0.5 MB
  const MAX_JOIN = 24 * 1024 * 1024;

  // An array only counts if it looks like models; guards against the word "models"
  // appearing in unrelated payloads.
  function looksLikeModels(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return false;
    for (let i = 0; i < Math.min(arr.length, 5); i++) {
      const m = arr[i];
      if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
      if (typeof m.publicName === 'string' || typeof m.displayName === 'string') return true;
      if (typeof m.id === 'string' && typeof m.userSelectable !== 'undefined') return true;
    }
    return false;
  }

  /* Bracket matching that understands JSON strings. Handles names like
   * "gemini-3-pro-image-2k (nano-banana-pro) [web-search]" without truncating. */
  function matchArray(text, open) {
    let depth = 0, inStr = false, esc = false;
    for (let i = open; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) return i; }
    }
    return -1;   // truncated (a chunk boundary) — caller can retry with more text
  }

  /* Decode a JS double-quoted string body: \" -> ", \\ -> \, \n -> newline, … */
  function unescapeJs(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c !== '\\') { out += c; continue; }
      const n = s[i + 1];
      if (n === undefined) { out += c; break; }
      if (n === '"') { out += '"'; i++; }
      else if (n === '\\') { out += '\\'; i++; }
      else if (n === "'") { out += "'"; i++; }
      else if (n === 'n') { out += '\n'; i++; }
      else if (n === 'r') { out += '\r'; i++; }
      else if (n === 't') { out += '\t'; i++; }
      else if (n === 'b') { out += '\b'; i++; }
      else if (n === 'f') { out += '\f'; i++; }
      else if (n === 'u') {
        const hex = s.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 5; }
        else out += c;                       // not a valid escape: keep the backslash
      } else out += c;
    }
    return out;
  }

  function sliceAt(text, open) {
    try {
      const close = matchArray(text, open);
      if (close === -1) return null;
      const parsed = JSON.parse(text.slice(open, close + 1));
      return looksLikeModels(parsed) ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  /* Pull a catalog array out of one blob of text: a script body, a whole document,
   * an accumulated buffer of pushes, or a raw /models response body. */
  function extract(text) {
    if (typeof text !== 'string' || text.length < 40) return null;
    if (text.indexOf('publicName') === -1 && text.indexOf('userSelectable') === -1 && text.indexOf('displayName') === -1) return null;

    for (const key of KEYS) {
      let from = 0;
      for (let guard = 0; guard < 8; guard++) {
        const at = text.indexOf(key, from);
        if (at === -1) break;
        from = at + key.length;
        const open = text.indexOf('[', at + key.length - 1);
        if (open === -1 || open - at > 24) continue;

        // 1. the text as it stands (plain JSON payloads)
        let arr = sliceAt(text, open);
        if (arr) return arr;

        // 2. the same region decoded as a JS string (escaped payloads)
        const decoded = unescapeJs(text.slice(open, open + MAX_DECODE));
        const o2 = decoded.indexOf('[');
        if (o2 >= 0 && o2 <= 4) {
          arr = sliceAt(decoded, o2);
          if (arr) return arr;
        }
      }
    }

    // last resort: the whole blob is the array (a bare /models response)
    const trimmed = text.trim();
    if (trimmed.charAt(0) === '[') {
      const arr = sliceAt(trimmed, 0);
      if (arr) return arr;
      const decoded = unescapeJs(trimmed.slice(0, MAX_DECODE));
      const o = decoded.indexOf('[');
      if (o >= 0 && o <= 4) {
        const arr2 = sliceAt(decoded, o);
        if (arr2) return arr2;
      }
    }
    return null;
  }

  /* Decode every  self.__next_f.push([1,"…"])  string literal and concatenate.
   * RSC splits a payload across pushes only at the literal level, so decoding each
   * literal and joining them rebuilds the original stream — plain script-text
   * concatenation cannot, because the intervening JS syntax corrupts the JSON. */
  const PUSH_RE = /self\.__next_f\.push\(\[\s*(?:1|"1")\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\)/g;

  function decodePushesFrom(text) {
    let buf = '';
    PUSH_RE.lastIndex = 0;
    let m;
    while ((m = PUSH_RE.exec(text))) {
      try { buf += JSON.parse(m[1]); } catch (e) { /* skip a literal we can't decode */ }
      if (buf.length > MAX_JOIN) break;
    }
    return buf;
  }

  function scanPushes(doc) {
    let buf = '';
    const scripts = doc.querySelectorAll('script');
    for (const s of scripts) {
      const txt = s.textContent || '';
      if (txt.indexOf('__next_f') === -1) continue;
      buf += decodePushesFrom(txt);
      if (buf.length > MAX_JOIN) break;
    }
    return buf;
  }

  // Fallback: the raw script bodies joined (works when nothing is split).
  function scanScripts(doc) {
    let joined = '';
    const scripts = doc.querySelectorAll('script');
    for (const s of scripts) {
      const txt = s.textContent || '';
      if (txt.indexOf('publicName') === -1 && txt.indexOf('userSelectable') === -1 && txt.indexOf('displayName') === -1) continue;
      joined += '\n' + txt;
      if (joined.length > MAX_JOIN) break;
    }
    return joined;
  }

  function scanModels(doc) {
    try {
      const found = extract(scanPushes(doc));
      if (found) return found;
    } catch (e) {}
    try {
      const found = extract(scanScripts(doc));
      if (found) return found;
    } catch (e) {}
    try {
      return extract(doc.documentElement.outerHTML || '');
    } catch (e) {}
    return null;
  }

  return {
    scanModels: scanModels,
    extract: extract,
    looksLikeModels: looksLikeModels,
    matchArray: matchArray,
    unescapeJs: unescapeJs,
    decodePushes: decodePushesFrom,
    scanPushes: scanPushes
  };
})();
