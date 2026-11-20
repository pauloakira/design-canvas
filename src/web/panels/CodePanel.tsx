import { useMemo, useState } from 'react';
import hljs from 'highlight.js/lib/core';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import javascript from 'highlight.js/lib/languages/javascript';
import { Bot, Terminal } from 'lucide-react';
import { generateCode, inspectCss, type Framework } from '../../shared/codegen.ts';
import { useEditor } from '../store.ts';
import { CopyButton, Section } from './controls.tsx';

hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('javascript', javascript);

const FRAMEWORKS: Array<{ id: Framework; label: string }> = [
  { id: 'react-tailwind', label: 'React + Tailwind' },
  { id: 'html', label: 'HTML + CSS' },
  { id: 'react-css', label: 'React (styles)' },
];

export function Highlighted({ code, lang }: { code: string; lang: 'xml' | 'css' | 'javascript' }) {
  const html = useMemo(() => {
    try {
      return hljs.highlight(code, { language: lang }).value;
    } catch {
      return code.replace(/</g, '&lt;');
    }
  }, [code, lang]);
  return <pre className="code hljs" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function implementPrompt(docName: string, docId: string, nodeName: string, nodeId: string) {
  return `Implement the "${nodeName}" design from Design Canvas (document "${docName}" ${docId}, node ${nodeId}) in this codebase. Use the design-canvas MCP tools: call get_design_context with nodeId "${nodeId}" for reference code, tokens and assets, and get_screenshot to compare visually. Reuse our existing components, styles and conventions instead of copying the generated code verbatim.`;
}

export function CodePanel() {
  const doc = useEditor((s) => s.doc);
  const sel = useEditor((s) => s.selection);
  const [fw, setFw] = useState<Framework>(() => (localStorage.getItem('dc:fw') as Framework) || 'react-tailwind');
  const id = sel.find((x) => doc?.nodes[x]);
  const result = useMemo(() => {
    if (!doc || !id) return null;
    try {
      return generateCode(doc, id, { framework: fw, assetBase: location.origin });
    } catch (e: any) {
      return { error: e.message } as any;
    }
  }, [doc, id, fw]);
  const cssText = useMemo(() => (doc && id ? inspectCss(doc, id) : ''), [doc, id]);
  if (!doc) return null;
  if (!id || !result) {
    return (
      <div className="code-panel">
        <div className="empty-state">
          <Terminal size={22} />
          <p>Select a layer to see production-ready code.</p>
          <p className="hint">
            Or let your coding agent do it: connect Claude Code or Codex (top-right <b>Connect</b>), select a frame here, then ask your agent to <i>“implement my Design Canvas selection”</i>.
          </p>
        </div>
      </div>
    );
  }
  const node = doc.nodes[id];
  const prompt = implementPrompt(doc.name, doc.id, node.name, node.id);
  return (
    <div className="code-panel">
      <Section title="Hand off to your agent">
        <p className="hint">Paste into Claude Code or Codex (with the Design Canvas MCP connected):</p>
        <div className="prompt-box">{prompt}</div>
        <div className="prow">
          <CopyButton text={prompt} label="Copy prompt" />
          <CopyButton text={`claude ${JSON.stringify(prompt)}`} label="claude …" />
          <CopyButton text={`codex ${JSON.stringify(prompt)}`} label="codex …" />
        </div>
        <div className="prow small muted">
          <Bot size={12} /> node id <code>{node.id}</code>
          <CopyButton text={node.id} label="Copy id" className="ghost" />
        </div>
      </Section>
      <div className="fw-tabs">
        {FRAMEWORKS.map((f) => (
          <button
            key={f.id}
            className={fw === f.id ? 'active' : ''}
            onClick={() => {
              setFw(f.id);
              localStorage.setItem('dc:fw', f.id);
            }}
          >
            {f.label}
          </button>
        ))}
      </div>
      {result.error ? (
        <p className="error pad">{result.error}</p>
      ) : (
        <>
          <div className="code-wrap">
            <div className="code-actions">
              <CopyButton text={result.code} />
            </div>
            <Highlighted code={result.code} lang={fw === 'html' ? 'xml' : 'javascript'} />
          </div>
          {result.tokensCss && fw !== 'html' && (
            <Section title="Tokens (CSS variables)" collapsible>
              <div className="code-wrap">
                <div className="code-actions">
                  <CopyButton text={result.tokensCss} />
                </div>
                <Highlighted code={result.tokensCss} lang="css" />
              </div>
            </Section>
          )}
          {result.components.length > 0 && (
            <Section title="Components" collapsible>
              {result.components.map((c: any) => (
                <div key={c.id} className="small">
                  <span className="component-color">❖ {c.name}</span>{' '}
                  {c.codeConnect ? (
                    <code>
                      {'<'}
                      {c.codeConnect.name} /{'>'} from {c.codeConnect.importPath ?? '?'}
                    </code>
                  ) : (
                    <span className="muted">not mapped — add Code Connect on the main component</span>
                  )}
                </div>
              ))}
            </Section>
          )}
          {result.assets.length > 0 && (
            <Section title="Assets" collapsible>
              {result.assets.map((a: string) => (
                <div key={a} className="small ellipsis">
                  <a href={a} target="_blank" rel="noreferrer">
                    {a}
                  </a>
                </div>
              ))}
            </Section>
          )}
          <Section title="Inspect (this layer)" collapsible>
            <div className="code-wrap">
              <div className="code-actions">
                <CopyButton text={cssText} />
              </div>
              <Highlighted code={cssText} lang="css" />
            </div>
          </Section>
        </>
      )}
    </div>
  );
}
