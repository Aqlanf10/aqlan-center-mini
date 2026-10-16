import type { Plugin } from 'esbuild';
/** Next router boundary only; production HR components still run under real React.
 * Native history preserves A -> B -> A lifetimes in the isolated browser fixture. */
export const hrNavigationAdapter: Plugin = { name: 'synthetic-next-navigation', setup(build) {
  build.onResolve({ filter: /^next\/(navigation|link)$/ }, args => ({ path: args.path, namespace: 'hr-next-fixture' }));
  build.onLoad({ filter: /.*/, namespace: 'hr-next-fixture' }, args => ({ resolveDir: process.cwd(), loader: 'jsx', contents: args.path === 'next/navigation'
    ? `import {useSyncExternalStore} from 'react'; const listen=fn=>{window.addEventListener('popstate',fn);return()=>window.removeEventListener('popstate',fn);}; const navigate=url=>{history.pushState(null,'',url);window.dispatchEvent(new PopStateEvent('popstate'));}; export const useSearchParams=()=>new URLSearchParams(useSyncExternalStore(listen,()=>location.search,()=>''));export const useRouter=()=>({push:navigate,replace:navigate});`
    : `import React from 'react';export default function Link({href,prefetch,scroll,onClick,children,...props}){return <a {...props} href={href} onClick={event=>{onClick?.(event);if(event.defaultPrevented||event.metaKey||event.ctrlKey)return;event.preventDefault();history.pushState(null,'',href);window.dispatchEvent(new PopStateEvent('popstate'));}}>{children}</a>;}` }));
} };
