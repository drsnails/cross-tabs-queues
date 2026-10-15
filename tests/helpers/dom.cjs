// Small parsed DOM used by preview and metadata tests. Fixtures preserve supplied
// YouTube markup, while selector matching supports the subset these readers use.
class Element {
    constructor(node = { tag: 'button', attributes: {}, children: [] }) {
        this.tag = node.tag;
        this.localName = node.tag;
        this.attributes = { ...node.attributes };
        this.className = this.attributes.class || '';
        this.children = node.children.map(child => typeof child === 'string' ? child : new Element(child));
        this.children.forEach(child => { if (typeof child !== 'string') child.parent = this; });
        this.dataset = {};
        this.style = {};
        this.rect = { left: 100, top: 200, right: 400, bottom: 400, width: 300, height: 200 };
        this.listeners = {};
        this.classList = { add: value => { if (!this.className.split(' ').includes(value)) this.className += ` ${value}`; } };
    }
    get parentElement() { return this.parent; }
    get isConnected() { return this.tag === 'fixture' || Boolean(this.parent?.isConnected); }
    getBoundingClientRect() { return this.rect; }
    remove() {
        if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
        this.parent = null;
    }
    get textContent() { return this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
    set textContent(value) { this.children = [value]; }
    getAttribute(name) { return name === 'class' ? this.className : this.attributes[name] ?? null; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(type, handler) { this.listeners[type] = handler; }
    appendChild(child) { child.parent = this; this.children.push(child); }
    contains(child) { return child === this || this.children.some(node => typeof node !== 'string' && node.contains(child)); }
    matches(selector) {
        return selector.split(',').some(part => {
            part = part.trim();
            for (const match of part.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)) {
                const value = this.getAttribute(match[1]);
                if (value === null || match[2] !== undefined && value !== match[2]) return false;
            }
            const withoutAttributes = part.replace(/\[[^\]]+\]/g, '');
            const id = withoutAttributes.match(/#([\w-]+)/)?.[1];
            if (id && this.getAttribute('id') !== id) return false;
            for (const match of withoutAttributes.matchAll(/\.([\w-]+)/g)) {
                if (!this.className.split(/\s+/).includes(match[1])) return false;
            }
            const tag = withoutAttributes.match(/^[\w-]+/)?.[0];
            return !tag || tag === this.tag;
        });
    }
    closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) || null; }
    querySelectorAll(selector) {
        const result = [];
        for (const alternative of selector.split(',')) {
            const parts = alternative.trim().split(/\s+/);
            const visit = node => {
                if (node.matches(parts.at(-1))) {
                    let ancestor = node.parent;
                    let index = parts.length - 2;
                    while (ancestor && index >= 0) {
                        if (ancestor.matches(parts[index])) index--;
                        ancestor = ancestor.parent;
                    }
                    if (index < 0 && !result.includes(node)) result.push(node);
                }
                node.children.forEach(child => { if (typeof child !== 'string') visit(child); });
            };
            this.children.forEach(child => { if (typeof child !== 'string') visit(child); });
        }
        return result;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
module.exports = { Element };
