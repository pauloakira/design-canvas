// Design Canvas → Figma apply engine.
//
// Applies a `design-canvas/figma@1` export (built by src/shared/figma.ts) to the
// current Figma file with the Plugin API. Every node it creates is tagged with a
// stable key (`<docId>/<nodeId>`), so applying the same design again updates the
// existing layers in place: main components keep their identity and every
// instance in the file follows, exactly like on the canvas.
//
// Plain ES2019 (no optional chaining) so it runs in any Figma plugin sandbox.
// `env` lets the build/test harness swap storage and page loading.

/* eslint-disable no-unused-vars */
var DC_NS = 'designcanvas';
var DC_COMPONENTS_PAGE = 'Design Canvas components';

function dcCreateApplier(env) {
  env = env || {};
  var getTag =
    env.getTag ||
    function (node) {
      return node.getSharedPluginData(DC_NS, 'key');
    };
  var setTag =
    env.setTag ||
    function (node, key) {
      node.setSharedPluginData(DC_NS, 'key', key);
    };
  var setMeta =
    env.setMeta ||
    function (node, k, v) {
      node.setSharedPluginData(DC_NS, k, v);
    };
  var getMeta =
    env.getMeta ||
    function (node, k) {
      return node.getSharedPluginData(DC_NS, k);
    };
  var loadAllPages =
    env.loadAllPages ||
    function () {
      return figma.loadAllPagesAsync();
    };

  var WEIGHT_NAMES = {
    100: ['Thin', 'Hairline'],
    200: ['ExtraLight', 'Extra Light', 'UltraLight', 'Ultra Light'],
    300: ['Light'],
    400: ['Regular', 'Normal', 'Book', 'Roman'],
    500: ['Medium'],
    600: ['SemiBold', 'Semi Bold', 'DemiBold', 'Demi Bold'],
    700: ['Bold'],
    800: ['ExtraBold', 'Extra Bold', 'UltraBold', 'Ultra Bold', 'Heavy'],
    900: ['Black', 'Heavy'],
  };

  function styleWeight(style) {
    var s = style.toLowerCase().replace(/italic|oblique/g, '').trim();
    if (!s) return 400;
    var best = 400;
    var bestLen = 0;
    for (var w in WEIGHT_NAMES) {
      var names = WEIGHT_NAMES[w];
      for (var i = 0; i < names.length; i++) {
        var n = names[i].toLowerCase();
        if (s.indexOf(n) >= 0 && n.length > bestLen) {
          best = Number(w);
          bestLen = n.length;
        }
      }
    }
    return best;
  }

  function Applier(payload, imageBytes, opts) {
    this.p = payload;
    this.opts = opts || {};
    this.imageBytes = imageBytes || {};
    this.prefix = payload.docId + '/';
    this.index = {};
    this.built = {};
    this.applying = {};
    this.fresh = {};
    this.vars = {};
    this.fontCache = {};
    this.available = null;
    this.imageHashes = {};
    this.report = { created: 0, updated: 0, removed: 0, foreignKept: 0, warnings: payload.warnings.slice(), roots: [], components: 0, instances: 0 };
  }

  Applier.prototype.warn = function (msg) {
    if (this.report.warnings.indexOf(msg) < 0) this.report.warnings.push(msg);
  };

  Applier.prototype.safe = function (fn, msg) {
    try {
      fn();
      return true;
    } catch (e) {
      if (msg) this.warn(msg + ' (' + (e && e.message ? e.message : e) + ')');
      return false;
    }
  };

  Applier.prototype.fullKey = function (k) {
    return this.prefix + k;
  };

  // ---------------------------------------------------------------- index
  Applier.prototype.buildIndex = async function () {
    await loadAllPages();
    var self = this;
    figma.root.children.forEach(function (page) {
      var found = page.findAllWithCriteria({ sharedPluginData: { namespace: DC_NS, keys: ['key'] } });
      found.forEach(function (n) {
        if (n.id.charAt(0) === 'I') return; // layers inside instances
        var k = getTag(n);
        if (k && k.indexOf(self.prefix) === 0 && !self.index[k]) self.index[k] = n;
      });
    });
  };

  // ------------------------------------------------------------ variables
  Applier.prototype.syncVariables = async function () {
    var vars = this.p.variables || [];
    if (!vars.length || !figma.variables) return;
    var title = 'Design Canvas — ' + this.p.docName;
    var cols = await figma.variables.getLocalVariableCollectionsAsync();
    var col = null;
    for (var i = 0; i < cols.length; i++) {
      if (getMeta(cols[i], 'doc') === this.p.docId) col = cols[i];
    }
    if (!col) {
      col = figma.variables.createVariableCollection(title);
      setMeta(col, 'doc', this.p.docId);
    } else if (col.name !== title) col.name = title;
    var modeId = col.modes[0].modeId;
    var existing = await figma.variables.getLocalVariablesAsync();
    var byName = {};
    existing.forEach(function (v) {
      if (v.variableCollectionId === col.id) byName[v.name] = v;
    });
    for (var j = 0; j < vars.length; j++) {
      var spec = vars[j];
      var v = byName[spec.name];
      if (v && v.resolvedType !== spec.type) {
        v.remove();
        v = null;
      }
      if (!v) v = figma.variables.createVariable(spec.name, col, spec.type);
      var value = spec.value;
      if (spec.type === 'COLOR') value = { r: spec.value.r, g: spec.value.g, b: spec.value.b, a: spec.value.a };
      this.safe(
        function () {
          v.setValueForMode(modeId, value);
        },
        'Could not set variable ' + spec.name,
      );
      this.safe(function () {
        v.setVariableCodeSyntax('WEB', 'var(--' + spec.token + ')');
      });
      if (spec.description) v.description = spec.description;
      this.vars[spec.token] = v;
    }
  };

  // ---------------------------------------------------------------- fonts
  Applier.prototype.resolveFont = function (family, weight, italic) {
    var key = family + '|' + weight + '|' + italic;
    if (this.fontCache[key]) return this.fontCache[key];
    var styles = this.available[family.toLowerCase()];
    var chosen = null;
    if (!styles) {
      this.warn('Font "' + family + '" is not available in Figma; used Inter.');
      styles = this.available.inter || [];
      family = 'Inter';
    }
    var fam = styles.length ? styles[0].family : family;
    var bestScore = Infinity;
    for (var i = 0; i < styles.length; i++) {
      var st = styles[i].style;
      var isItalic = /italic|oblique/i.test(st);
      var score = Math.abs(styleWeight(st) - weight) + (isItalic === !!italic ? 0 : 1000);
      // Prefer the canonical name for the weight (e.g. "Regular" over "Book").
      if (score < bestScore || (score === bestScore && WEIGHT_NAMES[weight] && WEIGHT_NAMES[weight].indexOf(st.replace(/\s*italic/i, '')) === 0)) {
        bestScore = score;
        chosen = st;
      }
    }
    var font = { family: fam, style: chosen || 'Regular' };
    if (bestScore >= 1000) this.warn('"' + fam + '" has no italic style; used ' + font.style + '.');
    else if (bestScore > 0) this.warn('"' + fam + '" has no weight ' + weight + '; used ' + font.style + '.');
    this.fontCache[key] = font;
    return font;
  };

  Applier.prototype.loadFonts = async function () {
    var list = await figma.listAvailableFontsAsync();
    var map = {};
    list.forEach(function (f) {
      var k = f.fontName.family.toLowerCase();
      (map[k] = map[k] || []).push(f.fontName);
    });
    this.available = map;
    var wanted = [{ family: 'Inter', style: 'Regular' }];
    var self = this;
    (this.p.fonts || []).forEach(function (f) {
      wanted.push(self.resolveFont(f.family, f.weight, f.italic));
    });
    for (var i = 0; i < wanted.length; i++) {
      try {
        await figma.loadFontAsync(wanted[i]);
      } catch (e) {
        this.warn('Could not load font ' + wanted[i].family + ' ' + wanted[i].style);
      }
    }
  };

  Applier.prototype.loadNodeFonts = async function (node) {
    if (node.type !== 'TEXT' || !node.characters.length) return;
    var fonts = node.getRangeAllFontNames(0, node.characters.length);
    for (var i = 0; i < fonts.length; i++) await figma.loadFontAsync(fonts[i]);
  };

  // --------------------------------------------------------------- images
  Applier.prototype.loadImages = function () {
    for (var url in this.imageBytes) {
      var bytes = this.imageBytes[url];
      if (!bytes) continue;
      try {
        this.imageHashes[url] = figma.createImage(bytes).hash;
      } catch (e) {
        this.warn('Could not import image ' + url.slice(0, 80));
      }
    }
  };

  // --------------------------------------------------------------- paints
  Applier.prototype.paint = function (p) {
    if (p.type === 'SOLID') {
      var paint = { type: 'SOLID', color: { r: p.color.r, g: p.color.g, b: p.color.b }, opacity: p.color.a, visible: p.visible };
      var v = p.variable && this.vars[p.variable];
      if (v) {
        try {
          paint = figma.variables.setBoundVariableForPaint(paint, 'color', v);
          // A bound paint takes the color from the variable; keep the paint opacity at 1
          // unless the token itself is translucent (alpha lives in the variable).
          paint = Object.assign({}, paint, { opacity: 1 });
        } catch (e) {
          /* keep raw color */
        }
      }
      return paint;
    }
    if (p.type === 'IMAGE') {
      var hash = this.imageHashes[p.url];
      if (!hash) {
        this.warn('Image not available: ' + p.url.slice(0, 80));
        return { type: 'SOLID', color: { r: 0.9, g: 0.91, b: 0.92 }, visible: p.visible };
      }
      var img = { type: 'IMAGE', imageHash: hash, scaleMode: p.scaleMode, visible: p.visible };
      if (p.scaleMode === 'CROP') img.imageTransform = [
        [1, 0, 0],
        [0, 1, 0],
      ];
      return img;
    }
    return {
      type: p.type,
      gradientTransform: p.transform,
      gradientStops: p.stops.map(function (s) {
        return { position: s.position, color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a } };
      }),
      visible: p.visible,
    };
  };

  Applier.prototype.paints = function (list) {
    var self = this;
    return (list || []).map(function (p) {
      return self.paint(p);
    });
  };

  Applier.prototype.effect = function (e) {
    if (e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR') return { type: e.type, radius: e.radius, visible: e.visible, blurType: 'NORMAL' };
    var fx = { type: e.type, color: e.color, offset: e.offset, radius: e.radius, spread: e.spread, visible: e.visible, blendMode: 'NORMAL' };
    if (e.type === 'DROP_SHADOW') fx.showShadowBehindNode = false;
    var v = e.variable && this.vars[e.variable];
    if (v) {
      try {
        fx = figma.variables.setBoundVariableForEffect(fx, 'color', v);
      } catch (err) {
        /* raw color */
      }
    }
    return fx;
  };

  // ----------------------------------------------------------- materialize
  function figmaType(kind) {
    return kind === 'SVG' ? 'FRAME' : kind;
  }

  Applier.prototype.compatible = function (node, spec) {
    if (node.type !== figmaType(spec.kind)) return false;
    var isSvg = getMeta(node, 'kind') === 'SVG';
    if ((spec.kind === 'SVG') !== isSvg) return false;
    if (spec.kind === 'SVG' && getMeta(node, 'svg') !== String(spec.svg.length) + ':' + hash(spec.svg)) return false;
    return true;
  };

  function hash(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return String(h >>> 0);
  }

  Applier.prototype.create = async function (spec) {
    var node;
    switch (spec.kind) {
      case 'FRAME':
        node = figma.createFrame();
        break;
      case 'COMPONENT':
        node = figma.createComponent();
        break;
      case 'INSTANCE': {
        var comp = await this.ensureComponent(spec.componentKey);
        if (!comp) {
          this.warn('Missing component for instance "' + spec.name + '"');
          node = figma.createFrame();
        } else node = comp.createInstance();
        break;
      }
      case 'RECTANGLE':
        node = figma.createRectangle();
        break;
      case 'ELLIPSE':
        node = figma.createEllipse();
        break;
      case 'TEXT':
        node = figma.createText();
        break;
      case 'SVG': {
        try {
          node = figma.createNodeFromSvg(spec.svg);
        } catch (e) {
          this.warn('Could not import SVG "' + spec.name + '"; created an empty frame.');
          node = figma.createFrame();
        }
        this.fitSvg(node, spec);
        setMeta(node, 'kind', 'SVG');
        setMeta(node, 'svg', String(spec.svg.length) + ':' + hash(spec.svg));
        break;
      }
    }
    if (node.type === 'FRAME' || node.type === 'COMPONENT') {
      node.fills = [];
      node.clipsContent = false;
    }
    return node;
  };

  /** CSS renders an SVG scaled to its box (preserveAspectRatio xMidYMid meet). */
  Applier.prototype.fitSvg = function (node, spec) {
    var w = spec.width;
    var h = spec.height;
    if (!node.width || !node.height) return;
    var s = Math.min(w / node.width, h / node.height);
    if (Math.abs(s - 1) > 0.001) this.safe(function () {
      node.rescale(s);
    });
    var dx = (w - node.width) / 2;
    var dy = (h - node.height) / 2;
    node.resizeWithoutConstraints(w, h);
    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
      node.children.forEach(function (c) {
        c.x += dx;
        c.y += dy;
      });
    }
    node.clipsContent = false;
  };

  Applier.prototype.ensureComponent = async function (key) {
    var fk = this.fullKey(key);
    if (this.built[fk]) return this.built[fk];
    var spec = this.p.components[key];
    if (!spec) return null;
    if (this.applying[fk]) return this.index[fk] || null;
    var parent = null;
    var index = 0;
    if (spec.external) {
      parent = await this.componentsPage();
      index = parent.children.length;
    }
    return this.materialize(spec, parent, index, null, !!spec.external);
  };

  Applier.prototype.componentsPage = async function () {
    if (this._compPage) return this._compPage;
    var page = null;
    figma.root.children.forEach(function (p) {
      if (p.name === DC_COMPONENTS_PAGE) page = p;
    });
    if (!page) {
      page = figma.createPage();
      page.name = DC_COMPONENTS_PAGE;
    }
    this._compPage = page;
    return page;
  };

  /**
   * Create or update the node for `spec`, put it at `index` in `parent`
   * (null = leave where it is / current page) and recurse into children.
   */
  Applier.prototype.materialize = async function (spec, parent, index, parentSpec, placeOnPage) {
    var fk = this.fullKey(spec.key);
    var node = this.built[fk];
    var isNew = false;
    var replaced = null;
    if (!node) {
      var existing = this.index[fk];
      if (existing && existing.removed) existing = null;
      if (existing && !this.compatible(existing, spec)) {
        if (spec.kind === 'COMPONENT' && existing.type === 'FRAME' && getMeta(existing, 'kind') !== 'SVG') {
          existing = figma.createComponentFromNode(existing);
        } else {
          replaced = existing;
          existing = null;
        }
      }
      if (existing && spec.kind === 'INSTANCE') {
        var main = await existing.getMainComponentAsync();
        var want = await this.ensureComponent(spec.componentKey);
        if (want && main !== want) existing.swapComponent(want);
      }
      node = existing || (await this.create(spec));
      isNew = !existing;
      if (isNew) this.report.created++;
      else this.report.updated++;
      if (spec.kind === 'COMPONENT') this.report.components++;
      if (spec.kind === 'INSTANCE') this.report.instances++;
      setTag(node, fk);
      this.built[fk] = node;
      if (isNew) this.fresh[fk] = true;
    }
    if (parent) {
      if (replaced && replaced.parent === parent) {
        var at = parent.children.indexOf(replaced);
        parent.insertChild(at, node);
      } else if (node.parent !== parent || parent.children.indexOf(node) !== index) {
        parent.insertChild(Math.min(index, parent.children.length), node);
      }
    } else if (isNew && node.parent !== figma.currentPage && !placeOnPage) {
      figma.currentPage.appendChild(node);
    }
    if (replaced) {
      if (!parent && replaced.parent) replaced.parent.insertChild(replaced.parent.children.indexOf(replaced), node);
      replaced.remove();
    }
    if (this.applying[fk]) return node;
    this.applying[fk] = true;
    await this.applyProps(node, spec, parentSpec, { isNew: isNew || !!this.fresh[fk], placeOnPage: placeOnPage || !parent });
    if (spec.children && (node.type === 'FRAME' || node.type === 'COMPONENT')) await this.reconcileChildren(node, spec);
    if (spec.kind === 'INSTANCE') await this.applyOverrides(node, spec);
    // Sizing that depends on the parent and children is applied last.
    this.applySizing(node, spec, parentSpec);
    delete this.applying[fk];
    return node;
  };

  Applier.prototype.reconcileChildren = async function (node, spec) {
    var wanted = [];
    for (var i = 0; i < spec.children.length; i++) {
      var child = await this.materialize(spec.children[i], node, i, spec, false);
      wanted.push(child);
    }
    var self = this;
    node.children.slice().forEach(function (ch) {
      if (wanted.indexOf(ch) >= 0) return;
      var k = getTag(ch);
      if (k && k.indexOf(self.prefix) === 0) {
        ch.remove();
        self.report.removed++;
      } else self.report.foreignKept++;
    });
  };

  // ----------------------------------------------------------------- props
  Applier.prototype.applyProps = async function (node, spec, parentSpec, ctx) {
    var self = this;
    var isInstance = node.type === 'INSTANCE';
    var isContainer = node.type === 'FRAME' || node.type === 'COMPONENT';
    if (isInstance) this.safe(function () {
      node.resetOverrides();
    });
    node.name = spec.name;

    if (isContainer && getMeta(node, 'kind') !== 'SVG') {
      var l = spec.layout;
      if (l) {
        node.layoutMode = l.mode;
        node.layoutWrap = l.wrap ? 'WRAP' : 'NO_WRAP';
        node.itemSpacing = l.itemSpacing;
        if (l.wrap) node.counterAxisSpacing = l.counterAxisSpacing;
        node.paddingTop = l.padding[0];
        node.paddingRight = l.padding[1];
        node.paddingBottom = l.padding[2];
        node.paddingLeft = l.padding[3];
        node.primaryAxisAlignItems = l.primaryAxisAlignItems;
        node.counterAxisAlignItems = l.counterAxisAlignItems;
        node.itemReverseZIndex = false;
        node.strokesIncludedInLayout = false;
      } else node.layoutMode = 'NONE';
      node.clipsContent = !!spec.clipsContent;
    }

    if (node.type === 'TEXT') await this.applyText(node, spec);

    // Size (hug/fill are applied later in applySizing).
    if (node.type === 'TEXT') {
      if (spec.text.textAutoResize === 'HEIGHT') node.resize(Math.max(spec.width, 0.01), node.height);
      else if (spec.text.textAutoResize === 'NONE') node.resize(Math.max(spec.width, 0.01), Math.max(spec.height, 0.01));
    } else if (getMeta(node, 'kind') === 'SVG') {
      if (Math.abs(node.width - spec.width) > 0.01 || Math.abs(node.height - spec.height) > 0.01) this.fitSvg(node, spec);
    } else {
      this.safe(function () {
        node.resize(Math.max(spec.width, 0.01), Math.max(spec.height, 0.01));
      });
    }

    // Position: auto-layout children are placed by the layout.
    var parentAuto = node.parent && 'layoutMode' in node.parent && node.parent.layoutMode !== 'NONE' && node.parent.type !== 'PAGE';
    if (parentAuto) this.safe(function () {
      node.layoutPositioning = spec.absolute ? 'ABSOLUTE' : 'AUTO';
    });
    var keepRootPosition = ctx.placeOnPage && !ctx.isNew;
    if (!spec.inFlow && !keepRootPosition) this.place(node, spec);
    else if (spec.rotation && !keepRootPosition) node.rotation = -spec.rotation;

    node.visible = spec.visible;
    node.locked = spec.locked;
    node.opacity = spec.opacity;
    this.safe(function () {
      node.blendMode = spec.blendMode === 'NORMAL' && isContainer ? 'PASS_THROUGH' : spec.blendMode;
    });

    ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'].forEach(function (k) {
      if (spec[k] !== undefined) self.safe(function () {
        node[k] = spec[k];
      });
      else if (!isInstance && k in node && node[k] !== null) self.safe(function () {
        node[k] = null;
      });
    });

    if (spec.fills) node.fills = this.paints(spec.fills);
    else if (!isInstance && 'fills' in node && node.type !== 'TEXT' && getMeta(node, 'kind') !== 'SVG') node.fills = [];

    if (node.type !== 'TEXT') {
      if (spec.strokes) {
        node.strokes = this.paints(spec.strokes);
        node.strokeWeight = spec.strokeWeight;
        this.safe(function () {
          node.strokeAlign = spec.strokeAlign;
        });
        node.dashPattern = spec.dashPattern || [];
      } else if (!isInstance && getMeta(node, 'kind') !== 'SVG') node.strokes = [];
    }

    if ('topLeftRadius' in node && node.type !== 'ELLIPSE') {
      if (spec.radius) {
        node.topLeftRadius = spec.radius[0];
        node.topRightRadius = spec.radius[1];
        node.bottomRightRadius = spec.radius[2];
        node.bottomLeftRadius = spec.radius[3];
      } else if (!isInstance) node.cornerRadius = 0;
    }

    if (spec.effects)
      this.safe(
        function () {
          node.effects = spec.effects.map(function (e) {
            return self.effect(e);
          });
        },
        'Could not apply effects on "' + spec.name + '"',
      );
    else if (!isInstance) node.effects = [];

    if (spec.bindings) {
      for (var field in spec.bindings) {
        var v = this.vars[spec.bindings[field]];
        if (!v) continue;
        (function (f, variable) {
          self.safe(function () {
            node.setBoundVariable(f, variable);
          });
        })(field, v);
      }
    }

    if (node.type === 'COMPONENT') {
      var lines = [];
      if (spec.codeConnect) {
        var cc = spec.codeConnect;
        lines.push('Code: <' + cc.name + ' />' + (cc.importPath ? " from '" + cc.importPath + "'" : ''));
        if (cc.notes) lines.push(cc.notes);
        setMeta(node, 'codeConnect', JSON.stringify(cc));
      }
      if (spec.description) lines.push(spec.description);
      node.description = lines.join('\n');
    } else if (spec.description) setMeta(node, 'description', spec.description);
  };

  /** x/y (+ CSS rotation around the center) relative to the parent. */
  Applier.prototype.place = function (node, spec) {
    if (!spec.rotation) {
      node.rotation = 0;
      node.x = spec.x;
      node.y = spec.y;
      return;
    }
    var t = (spec.rotation * Math.PI) / 180;
    var c = Math.cos(t);
    var s = Math.sin(t);
    var w = spec.width;
    var h = spec.height;
    var cx = spec.x + w / 2;
    var cy = spec.y + h / 2;
    node.relativeTransform = [
      [c, -s, cx - (c * w) / 2 + (s * h) / 2],
      [s, c, cy - (s * w) / 2 - (c * h) / 2],
    ];
  };

  Applier.prototype.applySizing = function (node, spec, parentSpec) {
    var self = this;
    var canSet = 'layoutSizingHorizontal' in node;
    if (!canSet) return;
    var parentAuto = node.parent && node.parent.type !== 'PAGE' && 'layoutMode' in node.parent && node.parent.layoutMode !== 'NONE';
    var selfAuto = 'layoutMode' in node && node.layoutMode !== 'NONE';
    function ok(mode) {
      if (mode === 'FILL') return parentAuto && !spec.absolute;
      if (mode === 'HUG') return selfAuto || node.type === 'TEXT' || node.type === 'INSTANCE';
      return true;
    }
    ['H', 'V'].forEach(function (axis) {
      var mode = axis === 'H' ? spec.sizingH : spec.sizingV;
      if (!ok(mode)) mode = 'FIXED';
      if (node.type === 'TEXT' && mode === 'FIXED' && axis === 'V' && spec.text.textAutoResize === 'HEIGHT') return;
      self.safe(function () {
        node[axis === 'H' ? 'layoutSizingHorizontal' : 'layoutSizingVertical'] = mode;
      });
    });
  };

  Applier.prototype.applyText = async function (node, spec) {
    var t = spec.text;
    await this.loadNodeFonts(node);
    var font = this.resolveFont(t.family, t.weight, t.italic);
    try {
      await figma.loadFontAsync(font);
    } catch (e) {
      font = { family: 'Inter', style: 'Regular' };
    }
    node.fontName = font;
    node.characters = t.characters;
    node.fontSize = t.fontSize;
    node.lineHeight = t.lineHeight;
    node.letterSpacing = { unit: 'PIXELS', value: t.letterSpacing };
    node.textAlignHorizontal = t.textAlignHorizontal;
    node.textAlignVertical = 'TOP';
    node.textDecoration = t.textDecoration;
    node.textCase = t.textCase;
    node.textAutoResize = t.textAutoResize;
  };

  // ------------------------------------------------------------- overrides
  Applier.prototype.applyOverrides = async function (inst, spec) {
    if (!spec.overrides) return;
    for (var i = 0; i < spec.overrides.length; i++) {
      var o = spec.overrides[i];
      var ids = [];
      var okPath = true;
      for (var j = 0; j < o.path.length; j++) {
        var main = this.built[this.fullKey(o.path[j])] || this.index[this.fullKey(o.path[j])];
        if (!main) {
          okPath = false;
          break;
        }
        ids.push(main.id);
      }
      if (!okPath) {
        this.warn('Override on "' + spec.name + '" points to a layer that no longer exists.');
        continue;
      }
      var base = inst.id.charAt(0) === 'I' ? inst.id : 'I' + inst.id;
      var target = await figma.getNodeByIdAsync(base + ';' + ids.join(';'));
      if (!target) {
        var last = ids[ids.length - 1];
        target = inst.findOne(function (n) {
          return n.id.slice(-(last.length + 1)) === ';' + last;
        });
      }
      if (!target) {
        this.warn('Could not find overridden layer in instance "' + spec.name + '".');
        continue;
      }
      if (o.characters !== undefined && target.type === 'TEXT') {
        await this.loadNodeFonts(target);
        target.characters = o.characters;
      }
      if (o.visible !== undefined) target.visible = o.visible;
      if (o.fills && 'fills' in target) target.fills = this.paints(o.fills);
    }
  };

  // ------------------------------------------------------------------- run
  Applier.prototype.run = async function () {
    await this.buildIndex();
    await this.syncVariables();
    await this.loadFonts();
    this.loadImages();
    var page = figma.currentPage;

    // New roots keep their relative arrangement, placed right of existing content.
    var self = this;
    var newRoots = this.p.roots.filter(function (r) {
      var n = self.index[self.fullKey(r.key)];
      return !n || n.removed;
    });
    var anchor = null;
    if (newRoots.length) {
      var maxX = 0;
      var minY = Infinity;
      page.children.forEach(function (c) {
        maxX = Math.max(maxX, c.x + c.width);
        minY = Math.min(minY, c.y);
      });
      if (!page.children.length) minY = 0;
      var rMinX = Math.min.apply(null, newRoots.map(function (r) { return r.x; }));
      var rMinY = Math.min.apply(null, newRoots.map(function (r) { return r.y; }));
      anchor = { dx: (page.children.length ? maxX + 200 : 0) - rMinX, dy: minY - rMinY };
    }

    // External components first so instances can point at them.
    for (var key in this.p.components) {
      if (this.p.components[key].external) await this.ensureComponent(key);
    }

    var nodes = [];
    for (var i = 0; i < this.p.roots.length; i++) {
      var spec = this.p.roots[i];
      var existing = this.index[this.fullKey(spec.key)];
      var placed = spec;
      if ((!existing || existing.removed) && anchor) placed = Object.assign({}, spec, { x: spec.x + anchor.dx, y: spec.y + anchor.dy });
      var parent = existing && !existing.removed ? null : page;
      var node = await this.materialize(placed, parent, parent ? page.children.length : 0, null, true);
      nodes.push(node);
    }
    this.report.roots = nodes.map(function (n) {
      return n.id;
    });
    this.rememberSync();
    return { nodes: nodes, report: this.report };
  };

  /** Remember what was sent so "Sync again" can refresh it later. */
  Applier.prototype.rememberSync = function () {
    var raw = getMeta(figma.root, 'syncs');
    var syncs = {};
    try {
      syncs = raw ? JSON.parse(raw) : {};
    } catch (e) {
      syncs = {};
    }
    var cur = syncs[this.p.docId] || { name: this.p.docName, keys: [] };
    cur.name = this.p.docName;
    this.p.roots.forEach(function (r) {
      if (cur.keys.indexOf(r.key) < 0) cur.keys.push(r.key);
    });
    cur.at = Date.now();
    syncs[this.p.docId] = cur;
    setMeta(figma.root, 'syncs', JSON.stringify(syncs));
  };


  // ======================================================================
  // Figma → Design Canvas: serialize Figma layers into FigmaSpecs (the same
  // shape the export uses), consumed by src/shared/figma-import.ts.
  // ======================================================================
  var VECTORISH = { VECTOR: 1, LINE: 1, STAR: 1, POLYGON: 1, BOOLEAN_OPERATION: 1 };
  var SKIP = { SLICE: 1, CONNECTOR: 1, STICKY: 1, SHAPE_WITH_TEXT: 1, WIDGET: 1, EMBED: 1, LINK_UNFURL: 1, CODE_BLOCK: 1, STAMP: 1, WASHI_TAPE: 1, HIGHLIGHT: 1, MEDIA: 1, TABLE: 1 };

  function Serializer() {
    this.warnings = [];
    this.components = {};
    this.compPending = {};
    this.images = {};
    this.vars = {};
    this.varTokens = {};
    this.keys = {};
    this.usedKeys = {};
    this.inRoots = {};
  }

  Serializer.prototype.warn = function (m) {
    if (this.warnings.indexOf(m) < 0) this.warnings.push(m);
  };

  /** Stable key: the Design Canvas tag if the layer came from there, else its Figma id. */
  Serializer.prototype.keyOf = function (node) {
    if (this.keys[node.id]) return this.keys[node.id];
    var tag = node.id.charAt(0) === 'I' ? '' : getTag(node);
    var key = tag && !this.usedKeys[tag] ? tag : 'figma:' + node.id;
    this.usedKeys[key] = true;
    this.keys[node.id] = key;
    return key;
  };

  Serializer.prototype.variable = async function (alias) {
    if (!alias || !alias.id) return undefined;
    if (this.varTokens[alias.id] !== undefined) return this.varTokens[alias.id] || undefined;
    var v = await figma.variables.getVariableByIdAsync(alias.id);
    if (!v) {
      this.varTokens[alias.id] = '';
      return undefined;
    }
    var web = (v.codeSyntax && v.codeSyntax.WEB) || '';
    var m = web.match(/var\(--([\w-]+)\)/);
    var parts = v.name.split('/');
    var token = m ? m[1] : parts.join('-').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
    // Resolve the value in the collection's default mode (following aliases).
    var value = null;
    var cur = v;
    for (var guard = 0; guard < 8 && cur; guard++) {
      var col = await figma.variables.getVariableCollectionByIdAsync(cur.variableCollectionId);
      var raw = cur.valuesByMode[col ? col.defaultModeId : Object.keys(cur.valuesByMode)[0]];
      if (raw && typeof raw === 'object' && raw.type === 'VARIABLE_ALIAS') cur = await figma.variables.getVariableByIdAsync(raw.id);
      else {
        value = raw;
        break;
      }
    }
    if (value === null || v.resolvedType === 'BOOLEAN') {
      this.varTokens[alias.id] = '';
      return undefined;
    }
    this.varTokens[alias.id] = token;
    this.vars[token] = { token: token, group: parts.length > 1 ? parts.slice(0, -1).join('/') : undefined, type: v.resolvedType, value: value, description: v.description || undefined };
    return token;
  };

  Serializer.prototype.paint = async function (p, nodeName) {
    var visible = p.visible !== false;
    var op = p.opacity === undefined ? 1 : p.opacity;
    if (p.type === 'SOLID') {
      var out = { type: 'SOLID', color: { r: p.color.r, g: p.color.g, b: p.color.b, a: op }, visible: visible };
      var tok = p.boundVariables && p.boundVariables.color ? await this.variable(p.boundVariables.color) : undefined;
      if (tok && op >= 0.999) out.variable = tok;
      return out;
    }
    if (p.type === 'IMAGE') {
      if (!p.imageHash) return null;
      if (!this.images[p.imageHash]) this.images[p.imageHash] = true;
      if (p.scaleMode === 'TILE') this.warn('"' + nodeName + '": tiled images are imported as "cover".');
      return { type: 'IMAGE', url: 'figma-image:' + p.imageHash, scaleMode: p.scaleMode === 'FIT' ? 'FIT' : p.scaleMode === 'CROP' ? 'CROP' : 'FILL', visible: visible };
    }
    if (p.type === 'GRADIENT_LINEAR' || p.type === 'GRADIENT_RADIAL' || p.type === 'GRADIENT_ANGULAR' || p.type === 'GRADIENT_DIAMOND') {
      if (p.type === 'GRADIENT_ANGULAR' || p.type === 'GRADIENT_DIAMOND') this.warn('"' + nodeName + '": angular/diamond gradients are imported as radial.');
      return {
        type: p.type === 'GRADIENT_LINEAR' ? 'GRADIENT_LINEAR' : 'GRADIENT_RADIAL',
        transform: p.gradientTransform,
        stops: p.gradientStops.map(function (s) {
          return { position: s.position, color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a * op } };
        }),
        visible: visible,
      };
    }
    this.warn('"' + nodeName + '": ' + p.type.toLowerCase() + ' fills are not supported; skipped.');
    return null;
  };

  Serializer.prototype.paints = async function (list, nodeName) {
    if (!list || list === figma.mixed) return undefined;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var p = await this.paint(list[i], nodeName);
      if (p) out.push(p);
    }
    return out;
  };

  Serializer.prototype.effects = async function (node) {
    if (!('effects' in node) || !node.effects.length) return undefined;
    var out = [];
    for (var i = 0; i < node.effects.length; i++) {
      var e = node.effects[i];
      if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
        var fx = { type: e.type, color: { r: e.color.r, g: e.color.g, b: e.color.b, a: e.color.a }, offset: { x: e.offset.x, y: e.offset.y }, radius: e.radius, spread: e.spread || 0, visible: e.visible !== false };
        var tok = e.boundVariables && e.boundVariables.color ? await this.variable(e.boundVariables.color) : undefined;
        if (tok) fx.variable = tok;
        out.push(fx);
      } else if (e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR') {
        if (e.blurType === 'PROGRESSIVE') this.warn('"' + node.name + '": progressive blur is imported as a uniform blur.');
        out.push({ type: e.type, radius: e.radius, visible: e.visible !== false });
      } else this.warn('"' + node.name + '": ' + String(e.type).toLowerCase() + ' effects are not supported; skipped.');
    }
    return out.length ? out : undefined;
  };

  Serializer.prototype.bindings = async function (node, fields) {
    var b = node.boundVariables || {};
    var out = {};
    var any = false;
    for (var i = 0; i < fields.length; i++) {
      var alias = b[fields[i]];
      if (Array.isArray(alias)) alias = alias[0];
      if (!alias) continue;
      var tok = await this.variable(alias);
      if (tok) {
        out[fields[i]] = tok;
        any = true;
      }
    }
    return any ? out : undefined;
  };

  /** Unrotated box (x, y relative to the parent) + CSS rotation, from a Figma transform. */
  function box(node, m) {
    var w = node.width;
    var h = node.height;
    var cx = m[0][0] * (w / 2) + m[0][1] * (h / 2) + m[0][2];
    var cy = m[1][0] * (w / 2) + m[1][1] * (h / 2) + m[1][2];
    var deg = (Math.atan2(m[1][0], m[0][0]) * 180) / Math.PI;
    return { x: cx - w / 2, y: cy - h / 2, rotation: Math.abs(deg) < 0.01 ? 0 : Math.round(deg * 100) / 100 };
  }

  function isIconLike(node) {
    if (!('children' in node) || !node.children.length) return false;
    if ('layoutMode' in node && node.layoutMode !== 'NONE') return false;
    if (node.width > 128 || node.height > 128) return false;
    var ok = true;
    var vectors = 0;
    node.findAll(function (n) {
      if (VECTORISH[n.type] || n.type === 'ELLIPSE' || n.type === 'RECTANGLE') vectors++;
      else if (n.type !== 'GROUP' && n.type !== 'FRAME') ok = false;
      if ('fills' in n && n.fills !== figma.mixed) n.fills.forEach(function (f) { if (f.type === 'IMAGE') ok = false; });
      return false;
    });
    return ok && vectors > 0 && node.findAll(function (n) { return VECTORISH[n.type]; }).length > 0;
  }

  Serializer.prototype.svgSpec = async function (node, spec) {
    try {
      spec.svg = await node.exportAsync({ format: 'SVG_STRING' });
    } catch (e) {
      this.warn('"' + node.name + '" could not be exported as SVG.');
      spec.svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    }
    spec.kind = 'SVG';
    // The SVG already contains the rotation and the layer's own fills/strokes/effects.
    spec.rotation = 0;
    delete spec.fills;
    delete spec.strokes;
    delete spec.effects;
    delete spec.radius;
    return spec;
  };

  Serializer.prototype.node = async function (node, parent, groupOffset, isRoot) {
    if (SKIP[node.type]) {
      this.warn(node.type.toLowerCase().replace(/_/g, ' ') + ' layers are not supported; skipped "' + node.name + '".');
      return null;
    }
    var parentAuto = parent && 'layoutMode' in parent && parent.layoutMode !== 'NONE' && parent.layoutMode !== 'GRID';
    var abs = parentAuto && node.layoutPositioning === 'ABSOLUTE';
    var b = box(node, isRoot ? node.absoluteTransform : node.relativeTransform);
    if (groupOffset) {
      b.x -= groupOffset.x;
      b.y -= groupOffset.y;
    }
    var spec = {
      key: this.keyOf(node),
      figmaId: node.id,
      kind: 'FRAME',
      name: node.name,
      x: b.x,
      y: b.y,
      width: node.width,
      height: node.height,
      rotation: -b.rotation,
      visible: node.visible !== false,
      locked: !!node.locked,
      opacity: 'opacity' in node ? node.opacity : 1,
      blendMode: 'blendMode' in node ? node.blendMode : 'NORMAL',
      sizingH: 'layoutSizingHorizontal' in node ? node.layoutSizingHorizontal : 'FIXED',
      sizingV: 'layoutSizingVertical' in node ? node.layoutSizingVertical : 'FIXED',
      absolute: !!abs,
      inFlow: !!parentAuto && !abs,
    };
    if (isRoot) {
      spec.inFlow = false;
      spec.absolute = false;
      if (spec.sizingH === 'FILL') spec.sizingH = 'FIXED';
      if (spec.sizingV === 'FILL') spec.sizingV = 'FIXED';
    }
    ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'].forEach(function (k) {
      if (k in node && node[k] !== null && node[k] !== undefined) spec[k] = node[k];
    });
    var fx = await this.effects(node);
    if (fx) spec.effects = fx;
    if ('strokes' in node && node.strokes.length && node.type !== 'GROUP') {
      spec.strokes = await this.paints(node.strokes, node.name);
      var sw = node.strokeWeight;
      if (sw === figma.mixed) {
        sw = Math.max(node.strokeTopWeight || 0, node.strokeRightWeight || 0, node.strokeBottomWeight || 0, node.strokeLeftWeight || 0);
        this.warn('"' + node.name + '": per-side stroke widths are imported as one ' + sw + 'px stroke.');
      }
      spec.strokeWeight = sw;
      spec.strokeAlign = node.strokeAlign || 'INSIDE';
      if (node.dashPattern && node.dashPattern.length) spec.dashPattern = node.dashPattern.slice();
    }
    if ('topLeftRadius' in node && node.type !== 'ELLIPSE') spec.radius = [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius];
    var bind = await this.bindings(node, ['itemSpacing', 'counterAxisSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius', 'fontSize', 'lineHeight']);
    if (bind) spec.bindings = bind;
    var desc = getMeta(node, 'description') || ('description' in node ? node.description : '');

    switch (node.type) {
      case 'TEXT':
        await this.text(node, spec);
        break;
      case 'RECTANGLE':
        spec.kind = 'RECTANGLE';
        spec.fills = await this.paints(node.fills, node.name);
        break;
      case 'ELLIPSE':
        if (node.arcData && (node.arcData.innerRadius > 0 || Math.abs(node.arcData.endingAngle - node.arcData.startingAngle) < 6.28)) return this.svgSpec(node, spec);
        spec.kind = 'ELLIPSE';
        spec.fills = await this.paints(node.fills, node.name);
        break;
      case 'INSTANCE':
        await this.instance(node, spec);
        break;
      case 'COMPONENT':
      case 'COMPONENT_SET':
      case 'FRAME':
      case 'SECTION':
      case 'GROUP': {
        if (node.type === 'FRAME' && getMeta(node, 'kind') === 'SVG') return this.svgSpec(node, spec);
        if ((node.type === 'GROUP' || node.type === 'FRAME') && !getTag(node) && isIconLike(node)) return this.svgSpec(node, spec);
        spec.kind = node.type === 'COMPONENT' ? 'COMPONENT' : 'FRAME';
        if (node.type === 'COMPONENT_SET') this.warn('Variants in "' + node.name + '" are imported as separate components.');
        spec.fills = node.type === 'GROUP' ? [] : await this.paints(node.fills, node.name);
        spec.clipsContent = node.type === 'GROUP' ? false : !!node.clipsContent;
        if ('layoutMode' in node && node.layoutMode !== 'NONE') {
          if (node.layoutMode === 'GRID') this.warn('"' + node.name + '": grid layout is imported as free positioning.');
          else {
            spec.layout = {
              mode: node.layoutMode,
              wrap: node.layoutWrap === 'WRAP',
              itemSpacing: node.primaryAxisAlignItems === 'SPACE_BETWEEN' ? node.itemSpacing : node.itemSpacing,
              counterAxisSpacing: node.counterAxisSpacing || 0,
              padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft],
              primaryAxisAlignItems: node.primaryAxisAlignItems,
              counterAxisAlignItems: node.counterAxisAlignItems,
            };
            if (spec.layout.wrap && node.counterAxisSpacing && node.counterAxisSpacing !== node.itemSpacing) this.warn('"' + node.name + '": different row and column gaps are imported as one gap.');
          }
        }
        if (node.type === 'COMPONENT') {
          var cc = getMeta(node, 'codeConnect');
          if (cc) {
            try {
              spec.codeConnect = JSON.parse(cc);
            } catch (e) {
              /* ignore */
            }
          }
          desc = String(desc || '').split('\n').filter(function (l) { return !/^Code: </.test(l); }).join('\n');
          this.components[spec.key] = spec;
        }
        // Children of a group are positioned in the group's parent space.
        var off = node.type === 'GROUP' ? { x: node.relativeTransform[0][2], y: node.relativeTransform[1][2] } : null;
        spec.children = [];
        for (var i = 0; i < node.children.length; i++) {
          var c = await this.node(node.children[i], node, off, false);
          if (c) spec.children.push(c);
        }
        break;
      }
      default:
        if (VECTORISH[node.type]) return this.svgSpec(node, spec);
        this.warn('"' + node.name + '" (' + node.type + ') is not supported; skipped.');
        return null;
    }
    if (desc) spec.description = desc;
    return spec;
  };

  Serializer.prototype.text = async function (node, spec) {
    spec.kind = 'TEXT';
    var segs = node.getStyledTextSegments(['fontName', 'fontSize', 'fills', 'letterSpacing', 'lineHeight', 'textDecoration', 'textCase']);
    if (segs.length > 1) this.warn('"' + node.name + '": mixed text styles are imported with the first style.');
    var s = segs[0] || { fontName: { family: 'Inter', style: 'Regular' }, fontSize: 12, fills: [], letterSpacing: { unit: 'PIXELS', value: 0 }, lineHeight: { unit: 'AUTO' }, textDecoration: 'NONE', textCase: 'ORIGINAL' };
    spec.fills = await this.paints(s.fills, node.name);
    var ls = s.letterSpacing.unit === 'PERCENT' ? (s.letterSpacing.value * s.fontSize) / 100 : s.letterSpacing.value;
    var lh = s.lineHeight.unit === 'AUTO' ? { unit: 'AUTO' } : { unit: s.lineHeight.unit, value: s.lineHeight.value };
    var tc = s.textCase === 'SMALL_CAPS' || s.textCase === 'SMALL_CAPS_FORCED' ? 'ORIGINAL' : s.textCase;
    if (tc !== s.textCase) this.warn('"' + node.name + '": small caps are not supported.');
    spec.text = {
      characters: node.characters,
      family: s.fontName.family,
      weight: styleWeight(s.fontName.style),
      italic: /italic|oblique/i.test(s.fontName.style),
      fontSize: s.fontSize,
      lineHeight: lh,
      letterSpacing: ls,
      textAlignHorizontal: node.textAlignHorizontal,
      textDecoration: s.textDecoration,
      textCase: tc,
      textAutoResize: node.textAutoResize === 'TRUNCATE' ? 'NONE' : node.textAutoResize,
    };
    if (node.textAlignVertical !== 'TOP' && node.textAutoResize === 'NONE') this.warn('"' + node.name + '": vertical text alignment is imported as top.');
  };

  Serializer.prototype.instance = async function (node, spec) {
    spec.kind = 'INSTANCE';
    var main = await node.getMainComponentAsync();
    if (!main) {
      this.warn('Instance "' + node.name + '" has no main component; imported as a frame.');
      spec.kind = 'FRAME';
      spec.fills = [];
      spec.children = [];
      return;
    }
    spec.componentKey = this.keyOf(main);
    if (!this.components[spec.componentKey] && !this.compPending[spec.componentKey]) {
      this.compPending[spec.componentKey] = true;
      var cs = await this.node(main, null, null, true);
      if (cs) this.components[spec.componentKey] = cs;
    }
    // Instance-level visuals only when they differ from the main component.
    var self = this;
    var ov = node.overrides || [];
    var rootFields = [];
    ov.forEach(function (o) {
      if (o.id === node.id) rootFields = o.overriddenFields;
    });
    if (rootFields.indexOf('fills') < 0) delete spec.fills;
    else spec.fills = await this.paints(node.fills, node.name);
    if (rootFields.indexOf('strokes') < 0) {
      delete spec.strokes;
      delete spec.strokeWeight;
      delete spec.strokeAlign;
      delete spec.dashPattern;
    }
    if (!rootFields.some(function (f) { return /Radius$/.test(f) || f === 'cornerRadius'; })) delete spec.radius;
    if (rootFields.indexOf('effects') < 0) delete spec.effects;
    var overrides = [];
    for (var i = 0; i < ov.length; i++) {
      var o = ov[i];
      if (o.id === node.id) continue;
      var sub = await figma.getNodeByIdAsync(o.id);
      if (!sub) continue;
      var segs = o.id.split(';').slice(1);
      var path = [];
      for (var j = 0; j < segs.length; j++) {
        var mainNode = await figma.getNodeByIdAsync(segs[j]);
        if (!mainNode) {
          path = null;
          break;
        }
        path.push(self.keyOf(mainNode));
      }
      if (!path) continue;
      var fo = { path: path };
      var used = false;
      if (o.overriddenFields.indexOf('characters') >= 0 && sub.type === 'TEXT') {
        fo.characters = sub.characters;
        used = true;
      }
      if (o.overriddenFields.indexOf('visible') >= 0) {
        fo.visible = sub.visible;
        used = true;
      }
      if (o.overriddenFields.indexOf('fills') >= 0 && 'fills' in sub) {
        fo.fills = await this.paints(sub.fills, sub.name);
        used = true;
      }
      var other = o.overriddenFields.filter(function (f) { return ['characters', 'visible', 'fills', 'name'].indexOf(f) < 0 && !/^(fontName|fontSize|styledTextSegments|textStyleId)$/.test(f); });
      if (other.length) this.warn('"' + node.name + '": overrides of ' + other.slice(0, 3).join(', ') + ' are not supported yet; the main component\'s values are used.');
      if (used) overrides.push(fo);
    }
    if (overrides.length) spec.overrides = overrides;
  };

  Serializer.prototype.run = async function (nodes) {
    var roots = [];
    for (var i = 0; i < nodes.length; i++) {
      var s = await this.node(nodes[i], null, null, true);
      if (s) roots.push(s);
    }
    var inRoots = {};
    (function mark(list) {
      list.forEach(function (x) {
        inRoots[x.key] = true;
        if (x.children) mark(x.children);
      });
    })(roots);
    var comps = {};
    for (var k in this.components) if (!inRoots[k]) comps[k] = this.components[k];
    var images = {};
    for (var hash in this.images) {
      var img = figma.getImageByHash(hash);
      if (img) {
        try {
          images[hash] = await img.getBytesAsync();
        } catch (e) {
          this.warn('An image could not be read from Figma.');
        }
      }
    }
    var vars = [];
    for (var t in this.vars) vars.push(this.vars[t]);
    return {
      payload: { format: 'design-canvas/figma-import@1', fileName: figma.root.name, variables: vars, components: comps, roots: roots, warnings: this.warnings },
      images: images,
    };
  };

  return {
    /** Serialize Figma layers for import into Design Canvas. */
    serialize: async function (nodes) {
      return new Serializer().run(nodes);
    },
    /** After an import: tag the Figma layers with their new Design Canvas ids. */
    tagImported: async function (docId, docName, keyMap, rootFigmaIds) {
      var roots = [];
      for (var fid in keyMap) {
        var n = await figma.getNodeByIdAsync(fid);
        if (!n || n.id.charAt(0) === 'I') continue;
        setTag(n, docId + '/' + keyMap[fid]);
        if (rootFigmaIds.indexOf(fid) >= 0) roots.push(keyMap[fid]);
      }
      var raw = getMeta(figma.root, 'syncs');
      var syncs = {};
      try {
        syncs = raw ? JSON.parse(raw) : {};
      } catch (e) {
        syncs = {};
      }
      var cur = syncs[docId] || { name: docName, keys: [] };
      roots.forEach(function (k) {
        if (cur.keys.indexOf(k) < 0) cur.keys.push(k);
      });
      cur.name = docName;
      cur.at = Date.now();
      syncs[docId] = cur;
      setMeta(figma.root, 'syncs', JSON.stringify(syncs));
    },
    apply: async function (payload, imageBytes, opts) {
      if (!payload || payload.format !== 'design-canvas/figma@1') throw new Error('Not a Design Canvas export');
      var a = new Applier(payload, imageBytes, opts);
      return a.run();
    },
    syncedDocs: function () {
      var raw = getMeta(figma.root, 'syncs');
      try {
        return raw ? JSON.parse(raw) : {};
      } catch (e) {
        return {};
      }
    },
  };
}
