import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// Under a parallel run a first render can take seconds; the 1 s default turns that into failures.
configure({ asyncUtilTimeout: 5000 });

// `server/` tests run in node, where there is no DOM.
const dom = typeof window !== 'undefined';

afterEach(() => {
  if (dom) cleanup();
  vi.restoreAllMocks();
});

// jsdom has no layout engine; React Flow needs these before a canvas renders.
if (!('ResizeObserver' in globalThis)) {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

if (!('DOMMatrixReadOnly' in globalThis)) {
  (globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = class {
    m22 = 1;
  };
}
