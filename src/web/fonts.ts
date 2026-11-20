import { useEffect } from 'react';
import { GOOGLE_FONTS } from '../shared/codegen.ts';
import { useEditor } from './store.ts';

const loaded = new Set<string>();

/**
 * Google Fonts rejects requests for weights a family doesn't have, so try the
 * widest variable range first and fall back to narrower requests.
 */
export function loadGoogleFont(family: string) {
  if (loaded.has(family) || !GOOGLE_FONTS.includes(family)) return;
  loaded.add(family);
  const f = family.replace(/ /g, '+');
  const attempts = [
    `family=${f}:ital,wght@0,100..900;1,100..900`,
    `family=${f}:wght@100..900`,
    `family=${f}:ital,wght@0,400;0,700;1,400;1,700`,
    `family=${f}:wght@400;700`,
    `family=${f}`,
  ];
  const tryAt = (i: number) => {
    if (i >= attempts.length) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?${attempts[i]}&display=swap`;
    link.onerror = () => {
      link.remove();
      tryAt(i + 1);
    };
    document.head.appendChild(link);
  };
  tryAt(0);
}

/** Loads every Google font used by text layers in the open document. */
export function useDocumentFonts() {
  const nodes = useEditor((s) => s.doc?.nodes);
  useEffect(() => {
    loadGoogleFont('Inter');
    if (!nodes) return;
    for (const n of Object.values(nodes)) if (n.type === 'text' && (n as any).fontFamily) loadGoogleFont((n as any).fontFamily);
  }, [nodes]);
}
