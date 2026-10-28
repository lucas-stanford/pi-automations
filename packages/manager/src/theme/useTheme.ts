import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

// Also read by public/theme-init.js, which applies the theme before first paint.
const THEME_STORAGE_KEY = 'automation-manager-theme';
export const DEFAULT_THEME: Theme = 'dark';
const SYSTEM_QUERY = '(prefers-color-scheme: dark)';

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function readStoredTheme(read: () => string | null = () => localStorage.getItem(THEME_STORAGE_KEY)): Theme {
  try {
    const stored = read();
    return isTheme(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function systemTheme(): ResolvedTheme {
  if (typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia(SYSTEM_QUERY).matches ? 'dark' : 'light';
}

function resolveTheme(theme: Theme): ResolvedTheme {
  return theme === 'system' ? systemTheme() : theme;
}

function applyTheme(theme: Theme): ResolvedTheme {
  const resolved = resolveTheme(theme);
  document.documentElement.classList.toggle('dark', resolved === 'dark');
  document.documentElement.style.colorScheme = resolved;
  return resolved;
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme());
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(readStoredTheme()));

  useEffect(() => {
    setResolved(applyTheme(theme));
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Storage can be blocked by policy; the theme then lasts for this page only.
    }
  }, [theme]);

  useEffect(() => {
    if (theme !== 'system' || typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia(SYSTEM_QUERY);
    const onChange = () => setResolved(applyTheme('system'));
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [theme]);

  const cycle = useCallback(() => {
    setTheme((current) => (current === 'dark' ? 'light' : current === 'light' ? 'system' : 'dark'));
  }, []);

  return { theme, resolved, cycle };
}
