import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { DesignDoc, Variable, VariableType } from '../../shared/types.ts';
import { deleteVariable, sanitizeVarName, upsertVariable } from '../../shared/ops.ts';
import { variablesToCss } from '../../shared/style.ts';
import { commit, toast, useEditor } from '../store.ts';
import { ColorField, CopyButton, Select } from './controls.tsx';

const NO_VARS: Record<string, Variable> = {};

/** Replace "$old" references everywhere in the document. */
function renameRefs(d: DesignDoc, from: string, to: string) {
  const walk = (o: any) => {
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (v === '$' + from) o[k] = '$' + to;
      else if (typeof v === 'object') walk(v);
    }
  };
  for (const n of Object.values(d.nodes)) walk(n);
}

export function TokensPanel() {
  const vars = useEditor((s) => s.doc?.variables) ?? NO_VARS;
  const list = Object.values(vars).sort((a, b) => (a.group ?? '').localeCompare(b.group ?? '') || a.name.localeCompare(b.name));
  const [name, setName] = useState('');
  const [type, setType] = useState<VariableType>('color');
  const [value, setValue] = useState('#6366F1');
  const groups = (['color', 'number', 'string'] as const).map((t) => ({ t, items: list.filter((v) => v.type === t) }));
  const add = () => {
    const n = sanitizeVarName(name);
    if (!name.trim()) return toast('Give the token a name', { kind: 'error' });
    if (Object.values(vars).some((v) => v.name === n)) return toast(`Token "${n}" already exists`, { kind: 'error' });
    commit((d) => {
      upsertVariable(d, { name: n, type, value: type === 'number' ? Number(value) || 0 : value });
    });
    setName('');
  };
  return (
    <div className="tokens">
      <p className="hint pad">
        Tokens become CSS variables in generated code. Use them in any field as <code>$name</code>.
      </p>
      {groups.map(
        ({ t, items }) =>
          items.length > 0 && (
            <div key={t} className="token-group">
              <div className="layers-title">{t === 'color' ? 'Colors' : t === 'number' ? 'Numbers' : 'Strings'}</div>
              {items.map((v) => (
                <TokenRow key={v.id} v={v} />
              ))}
            </div>
          ),
      )}
      <div className="token-add">
        <div className="layers-title">New token</div>
        <div className="prow">
          <input className="text-input grow" placeholder="name e.g. primary" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
          <Select
            value={type}
            className="narrow"
            options={[
              { value: 'color', label: 'Color' },
              { value: 'number', label: 'Number' },
              { value: 'string', label: 'String' },
            ]}
            onChange={(t) => {
              setType(t);
              setValue(t === 'color' ? '#6366F1' : t === 'number' ? '16' : '');
            }}
          />
        </div>
        <div className="prow">
          {type === 'color' ? <ColorField value={value} allowTokens={false} onChange={(v) => setValue(v)} /> : <input className="text-input grow" value={value} onChange={(e) => setValue(e.target.value)} />}
          <button className="btn small primary" onClick={add}>
            <Plus size={12} /> Add
          </button>
        </div>
      </div>
      {list.length > 0 && (
        <div className="pad">
          <CopyButton text={variablesToCss(vars)} label="Copy as CSS variables" />
        </div>
      )}
    </div>
  );
}

function TokenRow({ v }: { v: Variable }) {
  const [nameDraft, setNameDraft] = useState(v.name);
  return (
    <div className="token-item">
      {v.type === 'color' ? (
        <ColorField value={String(v.value)} allowTokens={false} onChange={(c, o) => commit((d) => void (d.variables[v.id] = { ...d.variables[v.id], value: c }), { key: o.scrub ? 'tok' + v.id : undefined })} />
      ) : (
        <input
          className="text-input token-value"
          defaultValue={String(v.value)}
          onBlur={(e) => {
            const raw = e.target.value;
            commit((d) => void (d.variables[v.id] = { ...d.variables[v.id], value: v.type === 'number' ? Number(raw) || 0 : raw }));
          }}
        />
      )}
      <input
        className="text-input token-name"
        value={nameDraft}
        onChange={(e) => setNameDraft(e.target.value)}
        onBlur={() => {
          const n = sanitizeVarName(nameDraft);
          if (n === v.name) return setNameDraft(v.name);
          commit((d) => {
            d.variables[v.id] = { ...d.variables[v.id], name: n };
            renameRefs(d, v.name, n);
          });
          setNameDraft(n);
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <button
        className="iconbtn hover-only"
        title="Delete token"
        onClick={() => {
          if (confirm(`Delete token $${v.name}? Layers using it will lose the value.`)) commit((d) => deleteVariable(d, v.id));
        }}
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}
