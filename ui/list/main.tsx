import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api } from '../shared/api.ts';
import type { TriageDocument } from '../../src/core/model.ts';

function App() {
  const [doc, setDoc] = useState<TriageDocument | null>(null);
  useEffect(() => {
    api.document().then((r) => setDoc(r.doc)).catch((e) => console.error(e));
  }, []);
  if (!doc) return <p>loading…</p>;
  return (
    <main>
      <h1>{doc.items.length} items</h1>
      <button onClick={() => api.done()}>Done</button>
      <ul>{doc.order.map((id) => <li key={id}>{doc.items.find((i) => i.id === id)?.title}</li>)}</ul>
    </main>
  );
}

render(<App />, document.getElementById('app')!);
