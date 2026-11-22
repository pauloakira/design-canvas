// Figma plugin main thread: owns the document, talks to ui.html (which talks
// to the local Design Canvas server).
/* global dcCreateApplier */
var applier = dcCreateApplier();

figma.showUI(__html__, { width: 380, height: 640, themeColors: true, title: 'Design Canvas' });

function postSelection() {
  var sel = figma.currentPage.selection;
  figma.ui.postMessage({ type: 'selection', count: sel.length, names: sel.slice(0, 3).map(function (n) { return n.name; }) });
}
figma.on('selectionchange', postSelection);
figma.on('currentpagechange', postSelection);
setTimeout(postSelection, 100);

function post(msg) {
  figma.ui.postMessage(msg);
}

figma.ui.onmessage = async function (msg) {
  try {
    if (msg.type === 'storage-get') {
      post({ type: 'storage', value: (await figma.clientStorage.getAsync('design-canvas')) || null });
    } else if (msg.type === 'storage-set') {
      await figma.clientStorage.setAsync('design-canvas', msg.value);
    } else if (msg.type === 'synced') {
      post({ type: 'synced', value: applier.syncedDocs(), file: figma.root.name });
    } else if (msg.type === 'apply') {
      var res;
      try {
        res = await applier.apply(msg.payload, msg.images || {});
      } catch (e) {
        post({ type: 'applied', id: msg.id, ok: false, error: String((e && e.message) || e) });
        figma.notify('Design Canvas: ' + String((e && e.message) || e), { error: true });
        return;
      }
      var onPage = res.nodes.filter(function (n) {
        var p = n;
        while (p && p.type !== 'PAGE') p = p.parent;
        return p === figma.currentPage;
      });
      if (onPage.length && msg.reveal !== false) {
        figma.currentPage.selection = onPage;
        figma.viewport.scrollAndZoomIntoView(onPage);
      }
      var r = res.report;
      figma.notify(
        'Design Canvas: ' + r.created + ' created, ' + r.updated + ' updated' + (r.removed ? ', ' + r.removed + ' removed' : '') + (r.warnings.length ? ' · ' + r.warnings.length + ' note(s)' : ''),
      );
      post({ type: 'applied', id: msg.id, ok: true, report: r, file: figma.root.name });
    } else if (msg.type === 'serialize') {
      var sel = figma.currentPage.selection.slice();
      if (!sel.length) {
        post({ type: 'serialized', id: msg.id, ok: false, error: 'Select one or more layers in Figma first.' });
        return;
      }
      try {
        var out = await applier.serialize(sel);
        post({ type: 'serialized', id: msg.id, ok: true, payload: out.payload, images: out.images });
      } catch (e) {
        post({ type: 'serialized', id: msg.id, ok: false, error: String((e && e.message) || e) });
      }
    } else if (msg.type === 'tag-imported') {
      await applier.tagImported(msg.docId, msg.docName, msg.keyMap, msg.rootFigmaIds || []);
      post({ type: 'synced', value: applier.syncedDocs(), file: figma.root.name });
    } else if (msg.type === 'open-url') {
      figma.openExternal(msg.url);
    } else if (msg.type === 'notify') {
      figma.notify(msg.text, { error: !!msg.error });
    } else if (msg.type === 'resize') {
      figma.ui.resize(380, Math.max(320, Math.min(900, msg.height)));
    }
  } catch (e) {
    post({ type: 'error', error: String((e && e.message) || e) });
  }
};
