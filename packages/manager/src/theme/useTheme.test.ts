import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, readStoredTheme } from './useTheme';

describe('theme storage', () => {
  it('defaults to dark', () => {
    expect(DEFAULT_THEME).toBe('dark');
    expect(readStoredTheme(() => null)).toBe('dark');
  });

  it('keeps only supported values', () => {
    expect(readStoredTheme(() => 'light')).toBe('light');
    expect(readStoredTheme(() => 'system')).toBe('system');
    expect(readStoredTheme(() => 'neon')).toBe('dark');
  });
});
