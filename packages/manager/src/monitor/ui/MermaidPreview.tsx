import { useEffect, useId, useState } from 'react';
import type { ResolvedTheme } from '../../theme/useTheme';

export function MermaidPreview({ text, theme }: { text: string; theme: ResolvedTheme }) {
  const id = useId().replaceAll(':', '');
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const styles = getComputedStyle(document.documentElement);
    const token = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
    void import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: theme === 'dark' ? 'dark' : 'default',
        themeVariables: {
          fontFamily: 'Inter Variable, sans-serif',
          primaryColor: token('--card', theme === 'dark' ? '#101013' : '#ffffff'),
          primaryTextColor: token('--foreground', theme === 'dark' ? '#f2f2f3' : '#202126'),
          lineColor: token('--dag-edge', theme === 'dark' ? '#606a7c' : '#7b8494'),
        },
      });
      return mermaid.render(`am-mermaid-${id}`, text);
    }).then((result) => {
      if (!cancelled) {
        setSvg(result.svg);
        setError('');
      }
    }).catch((err: unknown) => {
      if (!cancelled) {
        setSvg('');
        setError(err instanceof Error ? err.message : 'Mermaid could not render this chart.');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [id, text, theme]);

  if (error) return <pre className="am-mermaid-error">This chart could not be rendered: {error}</pre>;
  return <div className="am-mermaid-preview" dangerouslySetInnerHTML={{ __html: svg }} />;
}
