import {readFile,writeFile,mkdir,copyFile,cp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=new URL('../',import.meta.url);
await rm(new URL('public/',root),{recursive:true,force:true});
await mkdir(new URL('public/',root),{recursive:true});
const files=['account-tools.js','account-tools.css','wishlist.js','wishlist.css','dependents.js','dependents.css','marmelada.js','marmelada.css','admin.js','admin.css','group-fields.js','group-fields.css','invite-fields.js','invite-fields.css','otp.js','ui.js','auth.js','groups.js','styles.css','auth.css','groups.css','profile.js','profile.css'];
const resources = [
  ...files.map(file => [file, file]),
  ['app.js', 'live.js'],
];
const contents = await Promise.all(resources.map(async ([file, source]) => [file, await readFile(new URL(`prototype/${source}`, root))]));
const hash = createHash('sha256');
for (const [file, body] of contents) hash.update(file).update('\0').update(body).update('\0');
hash.update(await readFile(new URL('package-lock.json', root)));
const release = `releases/${hash.digest('hex').slice(0, 16)}/`;
await mkdir(new URL(`public/${release}`, root), { recursive: true });
for (const [file, body] of contents) {
  await writeFile(new URL(`public/${file}`, root), body);
  await writeFile(new URL(`public/${release}${file}`, root), body);
}
await cp(new URL('node_modules/@simplewebauthn/browser/esm/',root),new URL('public/webauthn/',root),{
  recursive:true,filter:path=>!path.endsWith('.map')&&!path.endsWith('.ts'),
});
await copyFile(new URL('node_modules/@simplewebauthn/browser/LICENSE.md',root),new URL('public/webauthn/LICENSE.md',root));
await cp(new URL('public/webauthn/', root), new URL(`public/${release}webauthn/`, root), { recursive: true });
await cp(new URL('prototype/assets/',root),new URL('public/assets/',root),{recursive:true});
let html=await readFile(new URL('prototype/index.html',root),'utf8');
html=html.replace(/\s*<link rel="stylesheet" href="\.\/(?:emails|brand)\.css">/g,'').replace('</head>','<link rel="stylesheet" href="./profile.css">\n<style>body{padding-bottom:0}</style>\n</head>');
html=html.replace(/\s*<div id="review-tools"><\/div>/,'').replace(/\s*<dialog id="screen-picker"[^>]*><\/dialog>/,'');
html=html.replace('Prévia visual do Amigo Secreto:','Amigo Secreto:');
// Keep the entry point, relative module imports and styles on the same release.
html = html.replace(/((?:src|href)="\.\/)([\w-]+\.(?:js|css))"/g, `$1${release}$2"`);
await writeFile(new URL('public/index.html',root),html);
console.log('Aplicação pronta em public/. Apenas arquivos públicos foram incluídos.');
