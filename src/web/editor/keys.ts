import { create } from 'zustand';

/** Live modifier/space state (for cursors and temporary hand tool). */
export const keyState = create<{ space: boolean; alt: boolean }>(() => ({ space: false, alt: false }));
