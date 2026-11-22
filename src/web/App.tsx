import { useEffect, useState } from 'react';
import Home from './Home.tsx';
import Editor from './Editor.tsx';

function parseRoute(): { name: 'home'; folder: string } | { name: 'doc'; id: string } {
  const m = location.pathname.match(/^\/d\/([\w-]+)/);
  if (m) return { name: 'doc', id: m[1] };
  const f = location.pathname.match(/^\/f\/(.+?)\/?$/);
  let folder = '';
  if (f) {
    try {
      folder = f[1].split('/').map(decodeURIComponent).filter(Boolean).join('/');
    } catch {
      /* malformed URL → root */
    }
  }
  return { name: 'home', folder };
}

export function folderUrl(folder: string) {
  return folder ? `/f/${folder.split('/').map(encodeURIComponent).join('/')}` : '/';
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
  return <Home folder={route.folder} />;
}
