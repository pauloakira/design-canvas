import { useEffect, useState } from 'react';
import Home from './Home.tsx';
import Editor from './Editor.tsx';

function parseRoute(): { name: 'home' } | { name: 'doc'; id: string } {
  const m = location.pathname.match(/^\/d\/([\w-]+)/);
  if (m) return { name: 'doc', id: m[1] };
  return { name: 'home' };
}

export function navigate(path: string) {
  history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export default function App() {
  const [route, setRoute] = useState(parseRoute);
  useEffect(() => {
    const on = () => setRoute(parseRoute());
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  if (route.name === 'doc') return <Editor key={route.id} docId={route.id} />;
  return <Home />;
}
