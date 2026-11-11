import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

// Generate the public sharing card from the application's existing brand mark.
// The committed PNG is deployed as-is so social crawlers need no JavaScript or fonts.
const root = new URL('../', import.meta.url);
const mark = await readFile(new URL('prototype/assets/mark.svg', root));
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#FAF8F2"/>
  <circle cx="1140" cy="40" r="245" fill="#E7EDE2"/>
  <circle cx="30" cy="640" r="180" fill="#F3E4D9"/>
  <rect x="46" y="42" width="1108" height="546" rx="32" fill="#FFFFFF" stroke="#E8E7DF" stroke-width="2"/>
  <image x="330" y="134" width="164" height="164" href="data:image/svg+xml;base64,${mark.toString('base64')}"/>
  <g fill="#203D35" font-family="Arial,sans-serif" font-weight="700" font-size="78" letter-spacing="-4">
    <text x="525" y="202">amigo</text>
    <text x="525" y="279">secreto<tspan fill="#EE775B">.</tspan></text>
  </g>
  <text x="600" y="390" fill="#203D35" font-family="Georgia,serif" font-size="48" text-anchor="middle">Gente querida. Boas surpresas.</text>
  <text x="600" y="443" fill="#637365" font-family="Arial,sans-serif" font-size="25" text-anchor="middle">Reúna sua turma e deixe a surpresa com a gente.</text>
  <rect x="453" y="488" width="294" height="46" rx="23" fill="#F2F5EB"/>
  <text x="600" y="518" fill="#536D56" font-family="Arial,sans-serif" font-size="21" text-anchor="middle">amigosecreto.sanida.me</text>
</svg>`;
await writeFile(new URL('prototype/assets/social-card.png', root), await sharp(Buffer.from(svg)).png().toBuffer());
console.log('Imagem de compartilhamento criada: 1200 × 630.');
