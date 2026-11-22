import { useLayoutEffect, useRef, useState } from 'react';
import { isFrameLike } from '../../shared/doc.ts';
import { getState, setState, useEditor } from '../store.ts';
import {
  addAutoLayout,
  copyAsCode,
  copyAsPng,
  copySelection,
  cutSelection,
  deleteSelection,
  detachSelection,
  duplicateSelection,
  goToMainComponent,
  groupSelection,
  makeComponent,
  pasteText,
  reorder,
  selectAll,
  toggleLocked,
  toggleVisible,
  ungroupSelection,
} from '../editor/actions.ts';
import { zoomToNodes } from '../editor/viewport.ts';
import { implementPrompt } from './CodePanel.tsx';
import { sendToFigma } from '../editor/figma.ts';

export function ContextMenu() {
  const menu = useEditor((s) => s.contextMenu);
  const sel = useEditor((s) => s.selection);
  const doc = useEditor((s) => s.doc);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const h = ref.current.offsetHeight;
    const w = ref.current.offsetWidth;
    setPos({ left: Math.min(menu.x, window.innerWidth - w - 8), top: Math.min(menu.y, window.innerHeight - h - 8) });
  }, [menu]);
  if (!menu || !doc) return null;
  const nodes = sel.map((id) => doc.nodes[id]).filter(Boolean);
  const one = nodes.length === 1 ? nodes[0] : null;
  const close = () => setState({ contextMenu: null });
  const item = (label: string, run: () => void, kbd?: string, disabled?: boolean) => (
    <button
      disabled={disabled}
      onClick={() => {
        close();
        run();
      }}
    >
      <span>{label}</span>
      {kbd && <kbd>{kbd}</kbd>}
    </button>
  );
  return (
    <>
      <div className="menu-backdrop" onPointerDown={close} onContextMenu={(e) => (e.preventDefault(), close())} />
      <div className="menu context" ref={ref} style={pos}>
        {nodes.length > 0 ? (
          <>
            {item('Copy', copySelection, '⌘C')}
            {item('Cut', cutSelection, '⌘X')}
            {item('Paste', async () => pasteText(await navigator.clipboard.readText()), '⌘V')}
            {item('Duplicate', duplicateSelection, '⌘D')}
            {item('Delete', deleteSelection, '⌫')}
            <hr />
            {item('Copy as React + Tailwind', () => copyAsCode(nodes[0].id, 'react-tailwind'), undefined, !one)}
            {item('Copy as HTML + CSS', () => copyAsCode(nodes[0].id, 'html'), undefined, !one)}
            {item('Copy as PNG', () => copyAsPng(nodes[0].id), undefined, !one)}
            {item('Copy prompt for Claude Code / Codex', () => navigator.clipboard.writeText(implementPrompt(doc.name, doc.id, nodes[0].name, nodes[0].id)), undefined, !one)}
            {item('Send to Figma', () => sendToFigma(sel), '⌥⇧F')}
            <hr />
            {item('Group selection', () => groupSelection(false), '⌘G')}
            {item('Frame with auto layout', () => addAutoLayout(), '⇧A')}
            {nodes.some((n) => n.type === 'frame') && item('Ungroup', ungroupSelection, '⇧⌘G')}
            {one && one.type !== 'component' && one.type !== 'instance' && item('Create component', makeComponent, '⌥⌘K')}
            {one?.type === 'instance' && item('Go to main component', () => goToMainComponent(one.id))}
            {nodes.some((n) => n.type === 'instance') && item('Detach instance', detachSelection, '⌥⌘B')}
            <hr />
            {item('Bring to front', () => reorder('front'), '⌥⌘]')}
            {item('Bring forward', () => reorder('forward'), '⌘]')}
            {item('Send backward', () => reorder('backward'), '⌘[')}
            {item('Send to back', () => reorder('back'), '⌥⌘[')}
            <hr />
            {item(nodes.every((n) => n.visible === false) ? 'Show' : 'Hide', () => toggleVisible(), '⇧⌘H')}
            {item(nodes.every((n) => n.locked) ? 'Unlock' : 'Lock', () => toggleLocked(), '⇧⌘L')}
            {item('Zoom to selection', () => zoomToNodes(sel, 4), '⇧2')}
            {one && isFrameLike(one) && item('Ask AI about this…', () => setState({ rightTab: 'ai' }))}
          </>
        ) : (
          <>
            {item('Paste', async () => pasteText(await navigator.clipboard.readText()), '⌘V')}
            {item('Select all', selectAll, '⌘A')}
            {item('Send page to Figma', () => sendToFigma([]), '⌥⇧F')}
            {item('Design with AI…', () => setState({ rightTab: 'ai' }))}
          </>
        )}
      </div>
    </>
  );
}

void getState;
