import type { DesignDoc, DocPatch } from './types.ts';

/** Structural diff by object identity (works with immutable / immer updates). */
export function diffDocs(a: DesignDoc, b: DesignDoc): DocPatch {
  const patch: DocPatch = {};
  const nodes = diffMap(a.nodes, b.nodes);
  if (nodes) patch.nodes = nodes;
  const pages = diffMap(a.pages, b.pages);
  if (pages) patch.pages = pages;
  const variables = diffMap(a.variables, b.variables);
  if (variables) patch.variables = variables;
  const comments = diffMap(a.comments ?? {}, b.comments ?? {});
  if (comments) patch.comments = comments;
  if (a.pageOrder !== b.pageOrder && !sameArray(a.pageOrder, b.pageOrder)) patch.pageOrder = b.pageOrder;
  if (a.name !== b.name) patch.name = b.name;
  return patch;
}

function diffMap<T>(a: Record<string, T>, b: Record<string, T>): Record<string, T | null> | null {
  if (a === b) return null;
  let out: Record<string, T | null> | null = null;
  for (const k in b) {
    if (a[k] !== b[k]) (out ??= {})[k] = b[k];
  }
  for (const k in a) {
    if (!(k in b)) (out ??= {})[k] = null;
  }
  return out;
}

function sameArray(a: string[], b: string[]) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function isEmptyPatch(p: DocPatch): boolean {
  return !p.nodes && !p.pages && !p.variables && !p.comments && !p.pageOrder && p.name === undefined;
}

/** Returns a new doc with the patch applied (shallow copies of touched maps). */
export function applyPatch(doc: DesignDoc, patch: DocPatch): DesignDoc {
  const next: DesignDoc = { ...doc };
  if (patch.nodes) next.nodes = applyMap(doc.nodes, patch.nodes);
  if (patch.pages) next.pages = applyMap(doc.pages, patch.pages);
  if (patch.variables) next.variables = applyMap(doc.variables, patch.variables);
  if (patch.comments) next.comments = applyMap(doc.comments ?? {}, patch.comments);
  if (patch.pageOrder) next.pageOrder = patch.pageOrder;
  if (patch.name !== undefined) next.name = patch.name;
  return next;
}

function applyMap<T>(base: Record<string, T>, changes: Record<string, T | null>): Record<string, T> {
  const out = { ...base };
  for (const k in changes) {
    const v = changes[k];
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** Patch that reverts `patch` when applied on top of `after` (computed against `before`). */
export function invertPatch(before: DesignDoc, patch: DocPatch): DocPatch {
  const inv: DocPatch = {};
  if (patch.nodes) {
    inv.nodes = {};
    for (const k in patch.nodes) inv.nodes[k] = before.nodes[k] ?? null;
  }
  if (patch.pages) {
    inv.pages = {};
    for (const k in patch.pages) inv.pages[k] = before.pages[k] ?? null;
  }
  if (patch.variables) {
    inv.variables = {};
    for (const k in patch.variables) inv.variables[k] = before.variables[k] ?? null;
  }
  if (patch.comments) {
    inv.comments = {};
    for (const k in patch.comments) inv.comments[k] = before.comments?.[k] ?? null;
  }
  if (patch.pageOrder) inv.pageOrder = before.pageOrder;
  if (patch.name !== undefined) inv.name = before.name;
  return inv;
}

/** Merge b on top of a. */
export function mergePatches(a: DocPatch, b: DocPatch): DocPatch {
  return {
    nodes: a.nodes || b.nodes ? { ...a.nodes, ...b.nodes } : undefined,
    pages: a.pages || b.pages ? { ...a.pages, ...b.pages } : undefined,
    variables: a.variables || b.variables ? { ...a.variables, ...b.variables } : undefined,
    comments: a.comments || b.comments ? { ...a.comments, ...b.comments } : undefined,
    pageOrder: b.pageOrder ?? a.pageOrder,
    name: b.name ?? a.name,
  };
}

export function patchNodeIds(p: DocPatch): string[] {
  return p.nodes ? Object.keys(p.nodes) : [];
}
