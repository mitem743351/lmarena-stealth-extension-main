/* Model helpers, shaped by a real arena.ai catalog snapshot (1,066 entries).
 *
 * Real capabilities look like:
 *   "outputCapabilities": { "text": true, "web": true,
 *                           "image": { "aspectRatios": ["1:1"] },   <- object, not bool
 *                           "search": true }
 * so truthiness is the only safe test, and "web" must not be forgotten.
 */
var KnowModel = (() => {
  'use strict';

  // canonical order used by the panel chips and the row labels
  const CAP_ORDER = ['text', 'web', 'image', 'search', 'video'];

  function outputCaps(m) {
    return (((m || {}).capabilities || {}).outputCapabilities) || {};
  }

  // returns e.g. ['text','web'] — lower-case, stable order, objects count as present
  function caps(m) {
    const c = (m || {}).capabilities;
    if (Array.isArray(c)) return c.map(String);
    const oc = outputCaps(m);
    const out = [];
    for (const key of CAP_ORDER) if (oc[key]) out.push(key);
    return out;
  }

  // only fields the extension actually relies on
  function isValid(m) {
    return Boolean(m && typeof m.id === 'string' && typeof m.publicName === 'string');
  }

  function isHidden(m) {
    return Boolean(m) && m.userSelectable === false;
  }

  /* The value Arena puts in ?model_a= is the publicName lower-cased, verbatim —
   * dots, digits and dashes kept. Verified against the real catalog and against
   * the user's own examples: "gemini-3.6-flash", "minimax-m3", and "Max" -> "max".
   * Slugifying (dot -> dash) breaks 219 of 896 real names, so never do it. */
  function paramValue(m) {
    if (!m) return '';
    return String(m.publicName || '').trim().toLowerCase();
  }

  return { caps: caps, isValid: isValid, isHidden: isHidden, paramValue: paramValue, CAP_ORDER: CAP_ORDER };
})();
