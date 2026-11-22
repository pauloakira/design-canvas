// A small in-memory stand-in for the Figma Plugin API — just enough surface for
// the Design Canvas engine, with the behaviors that matter for correctness:
// create* appends to the current page, text needs its font loaded before edits,
// instances copy their main component (ids `I<instance>;<main child>`), and
// shared plugin data is copied into instance sublayers.

export function createFakeFigma() {
  let seq = 1;
  const registry = new Map();
  const loadedFonts = new Set();
  const fontKey = (f) => `${f.family}|${f.style}`;

  class Node {
    constructor(type, id) {
      this.id = id ?? `1:${seq++}`;
      this.type = type;
      this.name = type;
      this.parent = null;
      this.removed = false;
      this._data = {};
      registry.set(this.id, this);
    }
    setSharedPluginData(ns, k, v) {
      this._data[`${ns}:${k}`] = v;
    }
    getSharedPluginData(ns, k) {
      return this._data[`${ns}:${k}`] ?? '';
    }
    remove() {
      if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = null;
      this.removed = true;
    }
  }

  const Container = (Base) =>
    class extends Base {
      constructor(...a) {
        super(...a);
        this.children = [];
      }
      appendChild(n) {
        this.insertChild(this.children.length, n);
      }
      insertChild(i, n) {
        if (n.parent) {
          const at = n.parent.children.indexOf(n);
          n.parent.children.splice(at, 1);
          if (n.parent === this && at < i) i--;
        }
        this.children.splice(Math.max(0, Math.min(i, this.children.length)), 0, n);
        n.parent = this;
      }
      findAll(fn = () => true) {
        const out = [];
        const walk = (n) => {
          for (const c of n.children ?? []) {
            if (fn(c)) out.push(c);
            walk(c);
          }
        };
        walk(this);
        return out;
      }
      findOne(fn) {
        return this.findAll(fn)[0] ?? null;
      }
      findAllWithCriteria(c) {
        const { namespace, keys } = c.sharedPluginData;
        return this.findAll((n) => keys.some((k) => n.getSharedPluginData(namespace, k)));
      }
    };

  class SceneNode extends Node {
    constructor(type, id) {
      super(type, id);
      Object.assign(this, { x: 0, y: 0, width: 100, height: 100, visible: true, locked: false, opacity: 1, rotation: 0, blendMode: 'PASS_THROUGH', effects: [], strokes: [], strokeWeight: 1, dashPattern: [] });
      this.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
      this.layoutSizingHorizontal = 'FIXED';
      this.layoutSizingVertical = 'FIXED';
      this.layoutPositioning = 'AUTO';
      this.bound = {};
    }
    resize(w, h) {
      this.width = w;
      this.height = h;
    }
    resizeWithoutConstraints(w, h) {
      this.resize(w, h);
    }
    rescale(s) {
      this.width *= s;
      this.height *= s;
    }
    setBoundVariable(field, v) {
      this.bound[field] = v.id;
    }
    set relativeTransform(m) {
      this._transform = m;
      this.x = m[0][2];
      this.y = m[1][2];
    }
    get relativeTransform() {
      return this._transform;
    }
  }
  const withCorners = (n) => Object.assign(n, { topLeftRadius: 0, topRightRadius: 0, bottomRightRadius: 0, bottomLeftRadius: 0, cornerRadius: 0 });

  class FrameNode extends Container(SceneNode) {
    constructor(type = 'FRAME', id) {
      super(type, id);
      withCorners(this);
      Object.assign(this, { layoutMode: 'NONE', clipsContent: true, minWidth: null, maxWidth: null, minHeight: null, maxHeight: null, description: '' });
    }
  }
  class ComponentNode extends FrameNode {
    constructor(id) {
      super('COMPONENT', id);
    }
    createInstance() {
      const inst = new InstanceNode(this);
      figma.currentPage.appendChild(inst);
      return inst;
    }
  }
  class InstanceNode extends Container(SceneNode) {
    constructor(main) {
      super('INSTANCE');
      withCorners(this);
      this.mainComponent = main;
      this.layoutMode = main.layoutMode;
      this.rebuild();
    }
    rebuild() {
      this.children.slice().forEach((c) => c.remove());
      const clone = (src, parent, path) => {
        const id = `I${this.id};${path.concat(src.id).join(';')}`;
        let c;
        if (src.type === 'TEXT') c = new TextNode(undefined, id);
        else if (src.children) c = new FrameNode(src.type === 'INSTANCE' ? 'INSTANCE' : 'FRAME', id);
        else c = new SceneNode(src.type, id);
        Object.assign(c, { name: src.name, fills: src.fills, visible: src.visible });
        if (src.type === 'TEXT') Object.assign(c, { _characters: src.characters, _fontName: src.fontName });
        c._data = { ...src._data };
        parent.children.push(c);
        c.parent = parent;
        for (const ch of src.children ?? []) clone(ch, c, path);
      };
      for (const ch of this.mainComponent.children) clone(ch, this, []);
    }
    async getMainComponentAsync() {
      return this.mainComponent;
    }
    swapComponent(c) {
      this.mainComponent = c;
      this.rebuild();
    }
    resetOverrides() {
      this.rebuild();
    }
  }
  class TextNode extends SceneNode {
    constructor(_t, id) {
      super('TEXT', id);
      this._fontName = { family: 'Inter', style: 'Regular' };
      this._characters = '';
      Object.assign(this, { fontSize: 12, textAutoResize: 'WIDTH_AND_HEIGHT', lineHeight: { unit: 'AUTO' } });
    }
    get fontName() {
      return this._fontName;
    }
    set fontName(f) {
      if (!loadedFonts.has(fontKey(f))) throw new Error(`Font ${fontKey(f)} not loaded`);
      this._fontName = f;
    }
    get characters() {
      return this._characters;
    }
    set characters(s) {
      if (s !== undefined && !loadedFonts.has(fontKey(this._fontName))) throw new Error(`Font ${fontKey(this._fontName)} not loaded`);
      this._characters = s;
    }
    getRangeAllFontNames() {
      return [this._fontName];
    }
  }
  class PageNode extends Container(Node) {
    constructor() {
      super('PAGE');
    }
  }
  class DocumentNode extends Container(Node) {
    constructor() {
      super('DOCUMENT', '0:0');
      this.name = 'Test file';
    }
  }

  const root = new DocumentNode();
  const page1 = new PageNode();
  page1.name = 'Page 1';
  root.appendChild(page1);

  const collections = [];
  const variables = [];
  const created = (n) => {
    figma.currentPage.appendChild(n);
    return n;
  };

  const figma = {
    root,
    currentPage: page1,
    async loadAllPagesAsync() {},
    createFrame: () => created(new FrameNode()),
    createComponent: () => created(new ComponentNode()),
    createRectangle: () => created(withCorners(new SceneNode('RECTANGLE'))),
    createEllipse: () => created(new SceneNode('ELLIPSE')),
    createText: () => created(new TextNode()),
    createPage() {
      const p = new PageNode();
      root.appendChild(p);
      return p;
    },
    createNodeFromSvg() {
      const f = created(new FrameNode());
      f.resize(24, 24);
      f.appendChild(new SceneNode('VECTOR'));
      return f;
    },
    createComponentFromNode(frame) {
      const c = new ComponentNode();
      const parent = frame.parent;
      const at = parent.children.indexOf(frame);
      parent.insertChild(at, c);
      frame.children.slice().forEach((ch) => c.appendChild(ch));
      c._data = { ...frame._data };
      frame.remove();
      return c;
    },
    createImage: () => ({ hash: `img${seq++}` }),
    async getNodeByIdAsync(id) {
      const n = registry.get(id);
      return n && !n.removed ? n : null;
    },
    async listAvailableFontsAsync() {
      return ['Regular', 'Medium', 'Semi Bold', 'Bold', 'Extra Bold', 'Italic'].map((style) => ({ fontName: { family: 'Inter', style } }));
    },
    async loadFontAsync(f) {
      loadedFonts.add(fontKey(f));
    },
    variables: {
      async getLocalVariableCollectionsAsync() {
        return collections;
      },
      async getLocalVariablesAsync() {
        return variables.filter((v) => !v.removed);
      },
      createVariableCollection(name) {
        const c = new Node('VARIABLE_COLLECTION');
        Object.assign(c, { name, modes: [{ modeId: 'm1', name: 'Mode 1' }] });
        collections.push(c);
        return c;
      },
      createVariable(name, col, type) {
        const v = {
          id: `VariableID:${seq++}`,
          name,
          resolvedType: type,
          variableCollectionId: col.id,
          valuesByMode: {},
          codeSyntax: {},
          setValueForMode(m, val) {
            this.valuesByMode[m] = val;
          },
          setVariableCodeSyntax(p, s) {
            this.codeSyntax[p] = s;
          },
          remove() {
            this.removed = true;
          },
        };
        variables.push(v);
        return v;
      },
      setBoundVariableForPaint: (p, f, v) => ({ ...p, boundVariables: { [f]: { type: 'VARIABLE_ALIAS', id: v.id } } }),
      setBoundVariableForEffect: (e, f, v) => ({ ...e, boundVariables: { [f]: { type: 'VARIABLE_ALIAS', id: v.id } } }),
    },
  };
  return { figma, variables, collections };
}
