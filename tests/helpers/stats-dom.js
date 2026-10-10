// A fake DOM for the view of the Statistics dock (js/ui/panels/stats-view.js): the one of tests/helpers/version-review-gen.js (installFakeDom: h(), icon(), attributes,
// classList, dataset, listeners, a few selectors) with the three things a keyed list needs that it does not have (insertBefore, nextSibling, previousSibling), plus finders.
// Events are fired with `await element.fire('click')` (that helper runs the listeners in order).
//
//   const dom = installStatsDom();   ... dom.restore() when the test file is done
//   dom.find(root, predicate) / dom.findAll(root, predicate)    elements (not text) below `root` that satisfy the predicate
//   dom.byRole(root, role)  / dom.byClass(root, name)  / dom.byTag(root, tag)
//   dom.text(root)                  all text below `root`
//   dom.liveRegions(root)           every element with an aria-live attribute
import { installFakeDom } from './version-review-gen.js';

export function installStatsDom() {
  const dom = installFakeDom();
  const P = dom.FElement.prototype;
  if (typeof P.insertBefore !== 'function') {
    P.insertBefore = function insertBefore(child, ref) {
      if (ref === null || ref === undefined) return this.appendChild(child);
      if (child.parentNode) child.parentNode.removeChild(child);
      const at = this.childNodes.indexOf(ref);
      if (at < 0) throw new Error('insertBefore: the reference node is not a child');
      child.parentNode = this;
      this.childNodes.splice(at, 0, child);
      return child;
    };
  }
  if (!Object.getOwnPropertyDescriptor(P, 'nextSibling')) {
    Object.defineProperty(P, 'nextSibling', { get() { const p = this.parentNode; if (!p) return null; const i = p.childNodes.indexOf(this); return p.childNodes[i + 1] || null; } });
    Object.defineProperty(P, 'previousSibling', { get() { const p = this.parentNode; if (!p) return null; const i = p.childNodes.indexOf(this); return i > 0 ? p.childNodes[i - 1] : null; } });
  }
  const findAll = (root, pred) => dom.elements(root).filter((e) => e !== root && pred(e));
  return Object.assign(dom, {
    findAll,
    find: (root, pred) => findAll(root, pred)[0] || null,
    byRole: (root, role) => findAll(root, (e) => e.getAttribute('data-role') === role),
    byClass: (root, name) => findAll(root, (e) => e.classList.contains(name)),
    byTag: (root, tag) => findAll(root, (e) => e.localName === tag),
    text: (root) => dom.textNodes(root).join(''),
    liveRegions: (root) => dom.elements(root).filter((e) => e.hasAttribute('aria-live')),
  });
}
