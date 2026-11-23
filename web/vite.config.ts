import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import {
  checkPublicKey,
  checkUrl,
  contentSecurityPolicy,
  headersFile,
  licensesFile,
  packageOf,
  styleAttributes,
  styleElements,
  type PackageInfo,
} from './src/build/headers';
import { SIGN_IN_CSS } from './src/lib/signin-styles';

/**
 * Checks the public values and writes Netlify's _headers (the Content-Security-Policy) and
 * licenses.txt into dist/. On Netlify the three values are required.
 */
function hostedFiles(env: Record<string, string>): Plugin {
  const required = process.env.NETLIFY === 'true';
  const supabaseUrl = checkUrl('VITE_SUPABASE_URL', env.VITE_SUPABASE_URL, required);
  checkPublicKey('VITE_SUPABASE_ANON_KEY', env.VITE_SUPABASE_ANON_KEY, required);
  const apiUrl = checkUrl('VITE_API_URL', env.VITE_API_URL, required);
  return {
    name: 'srj-hosted-files',
    apply: 'build',
    generateBundle(_options, bundle) {
      const html = readFileSync('index.html', 'utf8');
      const svg = readFileSync('src/lib/google-g-light.svg', 'utf8');
      const policy = contentSecurityPolicy({ supabaseUrl, apiUrl, styles: [...styleElements(html), SIGN_IN_CSS], styleAttributes: styleAttributes(svg) });
      this.emitFile({ type: 'asset', fileName: '_headers', source: headersFile(policy) });

      const packages = new Map<string, PackageInfo>();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const id of Object.keys(chunk.modules)) {
          const pkg = packageOf(id);
          if (!pkg || packages.has(pkg.name)) continue;
          const meta = JSON.parse(readFileSync(join(pkg.root, 'package.json'), 'utf8')) as { version: string; license?: string };
          const file = readdirSync(pkg.root).find((f) => /^(licen[cs]e|copying)/i.test(f));
          packages.set(pkg.name, { name: pkg.name, version: meta.version, license: meta.license ?? 'unknown', text: file ? readFileSync(join(pkg.root, file), 'utf8') : null });
        }
      }
      this.emitFile({ type: 'asset', fileName: 'licenses.txt', source: licensesFile([...packages.values()]) });
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: '/',
  // The API's address reaches the page as import.meta.env.VITE_API_URL, like the Supabase values.
  plugins: [hostedFiles(loadEnv(mode, process.cwd(), 'VITE_'))],
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
}));
