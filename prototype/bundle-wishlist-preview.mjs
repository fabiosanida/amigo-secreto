import { readFile, writeFile, mkdir } from 'node:fs/promises';
const read = name => readFile(new URL(name, import.meta.url), 'utf8');
const ui = (await read('ui.js')).replace(/\bexport (?=(?:function|const|let)\b)/g, '');
const controller = (await read('wishlist-preview.js')).replace(/^import .*;\n/gm, '');
const script = `const PreviewUI=(()=>{${ui}\nreturn {icon,brand,avatar,escapeHtml};})();\nconst {icon,brand,avatar,escapeHtml:esc}=PreviewUI;\n${controller}`;
const css = (await Promise.all(['styles.css','groups.css','wishlist-preview.css'].map(read))).join('\n');
const mark = 'data:image/svg+xml;base64,' + Buffer.from(await read('assets/mark.svg')).toString('base64');
const html = (await read('wishlist-preview.html'))
  .replace(/\s*<link rel="stylesheet"[^>]+>/g, '')
  .replace('</head>', `<style>${css}</style>\n</head>`)
  .replace('<script type="module" src="./wishlist-preview.js"></script>', `<script type="module">${script.replace(/<\/script/gi, '<\\/script')}</script>`)
  .replaceAll('./assets/mark.svg', mark);
await mkdir(new URL('review/', import.meta.url), { recursive: true });
await writeFile(new URL('review/sugestoes-presentes.html', import.meta.url), html);
console.log('Prévia portátil: prototype/review/sugestoes-presentes.html');
