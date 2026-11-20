import { getState, redo, setState, setTool, undo } from '../store.ts';
import { keyState } from './keys.ts';
import {
  addAutoLayout,
  copySelection,
  cutSelection,
  deleteSelection,
  detachSelection,
  duplicateSelection,
  groupSelection,
  makeComponent,
  nudge,
  pickImage,
  reorder,
  selectAll,
  selectChildren,
  selectParent,
  toggleLocked,
  toggleVisible,
  ungroupSelection,
} from './actions.ts';
import { setZoom, zoomBy, zoomToFit, zoomToNodes } from './viewport.ts';

export const SHORTCUTS: Array<[string, string]> = [
  ['V', 'Move / select'],
  ['H  ·  Space-drag', 'Hand (pan)'],
  ['F  ·  A', 'Frame'],
  ['R', 'Rectangle'],
  ['O', 'Ellipse'],
  ['T', 'Text'],
  ['⇧ I', 'Insert image'],
  ['⌘ Z  /  ⇧⌘ Z', 'Undo / redo'],
  ['⌘ C  ⌘ X  ⌘ V', 'Copy / cut / paste'],
  ['⌘ D', 'Duplicate'],
  ['⌥ drag', 'Duplicate while dragging'],
  ['⌘ drag  ·  ⌘ click', 'Move without nesting · deep select'],
  ['⌘ G  /  ⇧⌘ G', 'Group / ungroup'],
  ['⇧ A', 'Add / remove auto layout'],
  ['⌥⌘ K', 'Create component'],
  ['⌥⌘ B', 'Detach instance'],
  ['⌘ ]  ⌘ [', 'Bring forward / send backward'],
  ['⇧⌘ H  /  ⇧⌘ L', 'Hide / lock'],
  ['Enter  /  ⇧ Enter', 'Select children / parent'],
  ['Arrows (⇧ ×10)', 'Nudge (reorders in auto layout)'],
  ['⌥ hover', 'Measure distances'],
  ['⇧ 1  ·  ⇧ 2  ·  ⇧ 0', 'Zoom to fit · selection · 100%'],
  ['⌘ +  /  ⌘ −', 'Zoom in / out'],
  ['⌘ /', 'Show shortcuts'],
];

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
}

export function installShortcuts(): () => void {
  const down = (e: KeyboardEvent) => {
    const s = getState();
    if (!s.doc) return;
    if (e.key === ' ' && !isTyping(e)) {
      if (!keyState.getState().space) keyState.setState({ space: true });
      e.preventDefault();
      return;
    }
    if (e.key === 'Alt') keyState.setState({ alt: true });
    if (isTyping(e)) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    let handled = true;
    if (mod && k === 'z') e.shiftKey ? redo() : undo();
    else if (mod && k === 'y') redo();
    else if (mod && k === 'c') void copySelection();
    else if (mod && k === 'x') void cutSelection();
    else if (mod && k === 'v') handled = false; // handled by the paste event
    else if (mod && k === 'd') duplicateSelection();
    else if (mod && k === 'a') selectAll();
    else if (mod && e.altKey && k === 'k') makeComponent();
    else if (mod && e.altKey && k === 'b') detachSelection();
    else if (mod && e.shiftKey && k === 'g') ungroupSelection();
    else if (mod && k === 'g') groupSelection(e.altKey);
    else if (mod && e.shiftKey && k === 'h') toggleVisible();
    else if (mod && e.shiftKey && k === 'l') toggleLocked();
    else if (mod && (e.key === ']' || e.code === 'BracketRight')) reorder(e.altKey ? 'front' : 'forward');
    else if (mod && (e.key === '[' || e.code === 'BracketLeft')) reorder(e.altKey ? 'back' : 'backward');
    else if (mod && (e.key === '=' || e.key === '+')) zoomBy(1.25);
    else if (mod && (e.key === '-' || e.key === '_')) zoomBy(0.8);
    else if (mod && e.key === '0') setZoom(1);
    else if (mod && e.key === '/') setState({ dialog: s.dialog === 'shortcuts' ? null : 'shortcuts' });
    else if (mod) handled = false;
    else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelection();
    else if (e.key === 'Escape') {
      if (s.contextMenu) setState({ contextMenu: null });
      else if (s.dialog) setState({ dialog: null });
      else if (s.tool !== 'move') setTool('move');
      else selectParent();
    } else if (e.key === 'Enter') e.shiftKey ? selectParent() : selectChildren();
    else if (e.key.startsWith('Arrow')) {
      const step = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowLeft') nudge(-step, 0);
      if (e.key === 'ArrowRight') nudge(step, 0);
      if (e.key === 'ArrowUp') nudge(0, -step);
      if (e.key === 'ArrowDown') nudge(0, step);
    } else if (e.shiftKey && (e.key === '!' || e.code === 'Digit1')) zoomToFit();
    else if (e.shiftKey && (e.key === '@' || e.code === 'Digit2')) zoomToNodes(s.selection, 4);
    else if (e.shiftKey && (e.key === ')' || e.code === 'Digit0')) setZoom(1);
    else if (e.shiftKey && k === 'a') addAutoLayout();
    else if (e.shiftKey && k === 'i') pickImage();
    else if (!e.shiftKey && !e.altKey) {
      if (k === 'v') setTool('move');
      else if (k === 'h') setTool('hand');
      else if (k === 'f' || k === 'a') setTool('frame');
      else if (k === 'r') setTool('rect');
      else if (k === 'o') setTool('ellipse');
      else if (k === 't') setTool('text');
      else handled = false;
    } else handled = false;
    if (handled) e.preventDefault();
  };
  const up = (e: KeyboardEvent) => {
    if (e.key === ' ') keyState.setState({ space: false });
    if (e.key === 'Alt') keyState.setState({ alt: false });
  };
  const blur = () => keyState.setState({ space: false, alt: false });
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);
  window.addEventListener('blur', blur);
  return () => {
    window.removeEventListener('keydown', down);
    window.removeEventListener('keyup', up);
    window.removeEventListener('blur', blur);
  };
}
