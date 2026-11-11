import {readFile,writeFile} from 'node:fs/promises';

const read = name => readFile(new URL(name,import.meta.url),'utf8');
const clean = code => code.replace(/^import .*?;\s*$/gm,'').replace(/\bexport (?=(?:function|const|let)\b)/g,'');
const modules=[
 ['otp.js','OTP',['setupOTP']],
 ['ui.js','UI',['icon','brand','avatar','escapeHtml']],
 ['group-fields.js','GroupFields',['setupGroupFields','parseBudget']],
 ['invite-fields.js','InviteFields',['setupInviteFields','setInviteFieldsBusy']],
 ['auth.js','Auth',['renderAuth','AUTH_ROUTES']],
 ['groups.js','Groups',['renderGroups','GROUP_ROUTES']],
 ['emails.js','Emails',['renderEmails','EMAIL_ROUTES']],
 ['brand.js','Brand',['renderBrand']],
 ['draw.js','Draw',['createCycle']],
];
let script='';
for(const [file,name,exports] of modules) {
 script+=`const ${name}=(()=>{\n${clean(await read(file))}\nreturn {${exports.join(',')}};})();\nconst {${exports.join(',')}}=${name};\n`;
}
script+=clean(await read('app.js'));
const css=(await Promise.all(['styles.css','auth.css','groups.css','group-fields.css','invite-fields.css','emails.css','brand.css'].map(read))).join('\n');
const mark='data:image/svg+xml;base64,'+Buffer.from(await read('assets/mark.svg')).toString('base64');
const html=(await read('index.html'))
 .replace(/\s*<link rel="stylesheet"[^>]+>/g,'')
 .replace('</head>',`<style>${css}</style>\n</head>`)
 .replace('<script type="module" src="./app.js"></script>',`<script type="module">${script.replace(/<\/script/gi,'<\\/script')}</script>`)
 .replaceAll('./assets/mark.svg',mark);
await writeFile(new URL('amigo-secreto-layouts.html',import.meta.url),html);
console.log('Prévia portátil criada: amigo-secreto-layouts.html');
