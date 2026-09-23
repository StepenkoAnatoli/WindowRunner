/**
 * Minimal DOM stub for component unit tests (B1).
 *
 * The web components are plain-DOM render functions; this stub implements
 * exactly the surface they (and the `dom.ts` helpers) touch —
 * `createElement`, `createTextNode`, attributes, `append`, listeners,
 * `querySelector(All)`, `closest`, `textContent`, `click`, and form `value` —
 * so unit tests run under Node with no new dependencies. It is not a DOM
 * implementation: only the selector shapes used by the components and tests
 * are supported (tag, `#id`, `.class`, `[attr]`, `[attr="value"]`,
 * `[attr^="prefix"]`, comma groups, descendant chains).
 */

export interface StubEventInit {
  target?: FakeElement | FakeText | null;
  [key: string]: unknown;
}

export class FakeText {
  readonly nodeType = 3 as const;
  parent: FakeElement | null = null;
  constructor(public text: string) {}
  get textContent(): string {
    return this.text;
  }
}

type Listener = (event: Record<string, unknown>) => void;

export class FakeElement {
  readonly nodeType = 1 as const;
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly children: Array<FakeElement | FakeText> = [];
  readonly listeners = new Map<string, Listener[]>();
  parent: FakeElement | null = null;
  /** Form-control current value (`input`/`textarea`). */
  value = "";

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
    if (name === "value" && (this.tagName === "INPUT" || this.tagName === "TEXTAREA")) this.value = String(value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  /** Toggling `hidden` needs a real removal: `setAttribute("hidden","false")`
   *  still hides, because the attribute is boolean in HTML. */
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  get parentElement(): FakeElement | null {
    return this.parent && this.parent.nodeType === 1 ? (this.parent as FakeElement) : null;
  }

  get defaultValue(): string {
    return this.attributes.get("value") ?? "";
  }

  get textContent(): string {
    return this.children.map((c) => c.textContent).join("");
  }

  append(...nodes: Array<FakeElement | FakeText | string>): FakeElement {
    for (let node of nodes) {
      if (typeof node === "string") node = new FakeText(node);
      node.parent = this;
      this.children.push(node);
    }
    return this;
  }

  appendChild<T extends FakeElement | FakeText>(node: T): T {
    node.parent = this;
    this.children.push(node);
    return node;
  }

  /** Replace all children (what `main.ts` render() uses to rebuild the DOM). */
  replaceChildren(...nodes: Array<FakeElement | FakeText | string>): void {
    for (const child of this.children) child.parent = null;
    this.children.length = 0;
    this.append(...nodes);
  }

  /** No-op focus (render() restores focus across re-renders when applicable). */
  focus(): void {}

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type);
    if (list) this.listeners.set(type, list.filter((l) => l !== listener));
  }

  /** Dispatch on this element, then bubble to ancestors (no capture phase). */
  fire(type: string, init: StubEventInit = {}): void {
    const event: Record<string, unknown> = {
      type,
      target: init.target ?? this,
      defaultPrevented: false,
      preventDefault() {
        event.defaultPrevented = true;
      },
      ...init,
    };
    let node: FakeElement | null = this;
    while (node) {
      for (const listener of node.listeners.get(type) ?? []) listener(event);
      node = node.parent;
    }
  }

  click(): void {
    this.fire("click", { target: this });
  }

  submit(): void {
    this.fire("submit", { target: this });
  }

  closest(selector: string): FakeElement | null {
    let node: FakeElement | null = this;
    while (node) {
      if (matchesGroup(node, selector)) return node;
      node = node.parent;
    }
    return null;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  /** Descendants only (never the context element itself), like the real DOM. */
  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    const visit = (node: FakeElement): void => {
      for (const child of node.children) {
        if (child instanceof FakeElement) {
          if (matchesGroup(child, selector)) out.push(child);
          visit(child);
        }
      }
    };
    visit(this);
    return out;
  }
}

interface AttrMatcher {
  name: string;
  op?: "=" | "^=";
  value?: string;
}

interface Compound {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: AttrMatcher[];
}

function parseCompound(source: string): Compound {
  const compound: Compound = { classes: [], attrs: [] };
  let rest = source;
  const tag = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(rest);
  if (tag) {
    compound.tag = tag[0].toUpperCase();
    rest = rest.slice(tag[0].length);
  } else if (rest.startsWith("*")) {
    rest = rest.slice(1);
  }
  for (;;) {
    if (rest.startsWith("#")) {
      const m = /^#([\w-]+)/.exec(rest);
      if (!m) throw new Error(`unsupported selector: ${source}`);
      compound.id = m[1];
      rest = rest.slice(m[0].length);
    } else if (rest.startsWith(".")) {
      const m = /^\.([\w-]+)/.exec(rest);
      if (!m) throw new Error(`unsupported selector: ${source}`);
      compound.classes.push(m[1]);
      rest = rest.slice(m[0].length);
    } else if (rest.startsWith("[")) {
      const m = /^\[([\w-]+)(?:(\^?=)"([^"]*)")?\]/.exec(rest);
      if (!m) throw new Error(`unsupported selector: ${source}`);
      compound.attrs.push({ name: m[1], op: (m[2] as "=" | "^=" | undefined) ?? undefined, value: m[3] });
      rest = rest.slice(m[0].length);
    } else if (rest === "") {
      break;
    } else {
      throw new Error(`unsupported selector: ${source}`);
    }
  }
  return compound;
}

function matchesCompound(el: FakeElement, compound: Compound): boolean {
  if (compound.tag && el.tagName !== compound.tag) return false;
  if (compound.id && el.getAttribute("id") !== compound.id) return false;
  if (compound.classes.length > 0) {
    const classes = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
    for (const c of compound.classes) if (!classes.includes(c)) return false;
  }
  for (const attr of compound.attrs) {
    const actual = el.getAttribute(attr.name);
    if (attr.op === undefined) {
      if (actual === null) return false;
    } else if (attr.op === "=") {
      if (actual !== attr.value) return false;
    } else {
      if (actual === null || !actual.startsWith(attr.value ?? "")) return false;
    }
  }
  return true;
}

function matchesChain(el: FakeElement, chain: Compound[]): boolean {
  if (!matchesCompound(el, chain[chain.length - 1])) return false;
  let ancestor = el.parent;
  for (let i = chain.length - 2; i >= 0; i--) {
    while (ancestor && !matchesCompound(ancestor, chain[i])) ancestor = ancestor.parent;
    if (!ancestor) return false;
    ancestor = ancestor.parent;
  }
  return true;
}

function matchesGroup(el: FakeElement, group: string): boolean {
  return group.split(",").some((part) => {
    const chain = part.trim().split(/\s+/).filter(Boolean).map(parseCompound);
    return chain.length > 0 && matchesChain(el, chain);
  });
}

export interface StubDocument {
  createElement(tag: string): FakeElement;
  createTextNode(text: string): FakeText;
  /** Descendant lookup by `id` attribute (what `main.ts` uses to find `#app`). */
  getElementById(id: string): FakeElement | null;
  readonly body: FakeElement;
  activeElement: FakeElement | null;
}

function findById(node: FakeElement, id: string): FakeElement | null {
  if (node.getAttribute("id") === id) return node;
  for (const child of node.children) {
    if (child instanceof FakeElement) {
      const found = findById(child, id);
      if (found) return found;
    }
  }
  return null;
}

export function createStubDocument(): StubDocument {
  const body = new FakeElement("body");
  return {
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (text: string) => new FakeText(text),
    getElementById: (id: string) => findById(body, id),
    body,
    activeElement: null,
  };
}

export function installDomStub(): StubDocument {
  const doc = createStubDocument();
  (globalThis as Record<string, unknown>).document = doc;
  return doc;
}

export function uninstallDomStub(): void {
  delete (globalThis as Record<string, unknown>).document;
}
