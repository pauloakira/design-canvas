import { getState, setState, toast } from '../store.ts';

/** Queue the selection (or the whole page) for the Design Canvas Figma plugin. */
export async function sendToFigma(ids?: string[]) {
  const s = getState();
  if (!s.doc) return;
  const nodeIds = ids ?? s.selection;
  try {
    const r = await fetch('/api/figma/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: s.doc.id, pageId: s.pageId, nodeIds }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error ?? 'Could not send to Figma');
    const what = nodeIds.length ? `${data.layers} layer${data.layers === 1 ? '' : 's'}` : 'this page';
    if (data.pluginConnected) toast(`Sending ${what} to Figma…`, { kind: 'info' });
    else
      toast(`Queued ${what} for Figma. Open the Design Canvas plugin in Figma to receive it.`, {
        ms: 8000,
        action: { label: 'Set up', run: () => setState({ dialog: 'connect', connectTab: 'figma' }) },
      });
  } catch (e: any) {
    toast(e.message, { kind: 'error' });
  }
}

export interface FigmaResult {
  ok: boolean;
  error?: string;
  file?: string;
  report?: { created: number; updated: number; removed: number; components: number; instances: number; warnings: string[] };
}

export function announceFigmaResult(msg: FigmaResult) {
  if (!msg.ok || !msg.report) {
    toast(`Figma: ${msg.error ?? 'import failed'}`, { kind: 'error', ms: 8000 });
    return;
  }
  const r = msg.report;
  const parts = [r.created && `${r.created} created`, r.updated && `${r.updated} updated`, r.removed && `${r.removed} removed`].filter(Boolean).join(', ') || 'no changes';
  const notes = r.warnings.length;
  toast(`In Figma${msg.file ? ` (${msg.file})` : ''}: ${parts}${notes ? ` · ${notes} note${notes === 1 ? '' : 's'}` : ''}`, {
    ms: notes ? 9000 : 5000,
    action: notes ? { label: 'Details', run: () => alert(`Notes from the Figma import:\n\n• ${r.warnings.join('\n• ')}`) } : undefined,
  });
}
