/**
 * Script que se inyecta en TODAS las paginas e iframes mientras se graba.
 * Es JS plano (no TS) para poder serializarlo; no uses template literals aqui dentro.
 */
export const INJECT_SCRIPT = String.raw`
(() => {
  if (window.__rpaInjected) return;
  window.__rpaInjected = true;

  const send = (ev) => { try { window.__rpaRecord(ev); } catch (e) {} };
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const dynamicId = (id) =>
    /\d{4,}/.test(id) || /[0-9a-f]{8}-[0-9a-f]{4}/i.test(id) || /^(:r|ember|react|mui-|rc_|__)/i.test(id);
  const isUnique = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; } };

  function cssPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement) {
      const tag = cur.tagName.toLowerCase();
      if (cur.id && !dynamicId(cur.id)) { parts.unshift(tag + '[id="' + esc(cur.id) + '"]'); break; }
      let nth = 1, sib = cur;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === cur.tagName) nth++;
      parts.unshift(tag + ':nth-of-type(' + nth + ')');
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function candidates(el) {
    const tag = el.tagName.toLowerCase();
    const list = [];
    for (const a of ['data-testid', 'data-test', 'data-qa', 'data-cy']) {
      const v = el.getAttribute(a);
      if (v) list.push('[' + a + '="' + esc(v) + '"]');
    }
    if (el.id && !dynamicId(el.id)) list.push('[id="' + esc(el.id) + '"]');
    const name = el.getAttribute('name');
    if (name) list.push(tag + '[name="' + esc(name) + '"]');
    const aria = el.getAttribute('aria-label');
    if (aria) list.push(tag + '[aria-label="' + esc(aria) + '"]');
    const ph = el.getAttribute('placeholder');
    if (ph) list.push(tag + '[placeholder="' + esc(ph) + '"]');
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'input' && (type === 'submit' || type === 'button') && el.value) {
      list.push('input[type="' + type + '"][value="' + esc(el.value) + '"]');
    }
    const role = el.getAttribute('role');
    if (tag === 'button' || tag === 'a' || role === 'button' || role === 'link' || role === 'tab') {
      const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
      if (t && t.length <= 60) list.push(tag + ':text-is("' + esc(t) + '")');
    }
    const unique = list.filter(isUnique);
    const path = cssPath(el);
    // Solo selectores unicos al grabar; el css path va siempre como ultimo recurso.
    return (unique.length ? unique : list).concat(path ? [path] : []);
  }

  const TEXT_TYPES = ['', 'text', 'password', 'email', 'search', 'tel', 'url', 'number'];
  const isTextLike = (el) =>
    el.tagName === 'TEXTAREA' ||
    (el.tagName === 'INPUT' && TEXT_TYPES.indexOf((el.getAttribute('type') || '').toLowerCase()) >= 0);

  const INTERACTIVE = 'button,a,input,select,textarea,label,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[onclick]';

  let pending = null;
  let lastFill = null;
  function flush() {
    const el = pending;
    pending = null;
    if (!el) return;
    const secret = (el.getAttribute('type') || '').toLowerCase() === 'password';
    const key = candidates(el)[0] + '=' + el.value;
    if (lastFill === key) return;
    lastFill = key;
    send({
      type: 'fill',
      candidates: candidates(el),
      value: el.value,
      secret: secret,
      field: el.getAttribute('name') || el.id || (secret ? 'password' : 'field'),
    });
  }

  document.addEventListener('input', (e) => {
    if (!e.isTrusted) return;
    if (isTextLike(e.target)) pending = e.target;
  }, true);
  document.addEventListener('focusout', flush, true);
  document.addEventListener('change', (e) => {
    if (!e.isTrusted) return;
    const el = e.target;
    if (isTextLike(el)) return flush();
    if (el.tagName === 'SELECT') {
      send({ type: 'select', candidates: candidates(el), value: el.value });
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted) return;
    if (e.key === 'Enter' || e.key === 'Escape') {
      flush();
      const el = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
      send({ type: 'press', key: e.key, candidates: el ? candidates(el) : [] });
    }
  }, true);

  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    flush();
    const raw = e.target;
    if (!(raw instanceof Element)) return;
    const el = raw.closest(INTERACTIVE) || raw;
    if (e.altKey) {
      // Alt+Click = marcar el elemento como dato a extraer (no se ejecuta el click).
      e.preventDefault();
      e.stopPropagation();
      const prev = el.style.outline;
      el.style.outline = '3px solid #16a34a';
      setTimeout(() => { el.style.outline = prev; }, 900);
      send({ type: 'extract', candidates: candidates(el), label: (el.innerText || '').trim().slice(0, 40) });
      return;
    }
    if (isTextLike(el)) return; // el fill posterior ya incluye el foco
    send({
      type: 'click',
      candidates: candidates(el),
      label: ((el.innerText || el.value || el.getAttribute('aria-label') || '') + '').trim().slice(0, 40),
    });
  }, true);
})();
`;
