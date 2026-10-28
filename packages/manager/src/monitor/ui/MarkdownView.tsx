import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

/** The URL when it is http or https, which is all a link here may be; undefined otherwise. */
export function safeHref(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** Links open in a new tab and say nothing about this page; anything not http(s) is plain text. */
const components: Components = {
  a({ href, children }) {
    const safe = safeHref(href);
    return safe ? <a href={safe} target="_blank" rel="noreferrer">{children}</a> : <span>{children}</span>;
  },
};

export function MarkdownView({ text }: { text: string }) {
  return (
    <div className="am-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={components} skipHtml>
        {text || '_Nothing to preview yet._'}
      </ReactMarkdown>
    </div>
  );
}