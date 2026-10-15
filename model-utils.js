/* 模型小工具（共享）：能力标签与有效性判定。 */
var KnowModel = (() => {
  'use strict';
  function outputCaps(m) {
    return (((m || {}).capabilities || {}).outputCapabilities) || {};
  }
  function caps(m) {
    const c = (m || {}).capabilities;
    if (Array.isArray(c)) return c.slice();
    const oc = outputCaps(m);
    const out = [];
    if (oc.text) out.push('文本');
    if (oc.search) out.push('搜索');
    if (oc.image) out.push('生图');
    if (oc.video) out.push('视频');
    return out;
  }
  function isValid(m) {
    const oc = outputCaps(m);
    return Boolean(m && m.publicName && (oc.text || oc.search || oc.image || oc.video || true));
  }
  return { caps: caps, isValid: isValid };
})();