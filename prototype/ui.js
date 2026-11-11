export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const paths = {
  gift:'<path d="M3 8h18v4H3zM5 12v9h14v-9M12 8v13M12 8H7a3 3 0 1 1 3-3l2 3Zm0 0h5a3 3 0 1 0-3-3l-2 3Z"/>',
  'arrow-right':'<path d="M4 12h16m-6-6 6 6-6 6"/>',
  'arrow-left':'<path d="M20 12H4m6-6-6 6 6 6"/>',
  mail:'<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m3 7 9 6 9-6"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 11 3 3 5-5"/>',
  users:'<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6m2 5c3 0 3 3 3 6"/>',
  calendar:'<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 5h2m4 0h2"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  heart:'<path d="M20.5 5.5a5 5 0 0 0-7 0L12 7l-1.5-1.5a5 5 0 0 0-7 7L12 21l8.5-8.5a5 5 0 0 0 0-7Z"/>',
  sparkles:'<path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6L12 3ZM20 2v4m-2-2h4"/>',
  lock:'<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  'chevron-right':'<path d="m9 5 7 7-7 7"/>',
  'chevron-down':'<path d="m5 9 7 7 7-7"/>',
  x:'<path d="m6 6 12 12M6 18 18 6"/>',
  refresh:'<path d="M20 7a9 9 0 0 0-16 3M4 7v3h3m-3 7a9 9 0 0 0 16-3m0 3v-3h-3"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  settings:'<path d="m9 3-.8 3-3 .8 1 3L4 12l2.2 2.2-1 3 3 .8.8 3h6l.8-3 3-.8-1-3L20 12l-2.2-2.2 1-3-3-.8L15 3H9Z"/><circle cx="12" cy="12" r="3"/>',
  logout:'<path d="M9 4H4v16h5m0-8h12m-4-4 4 4-4 4"/>',
  send:'<path d="m22 2-7 20-4-9-9-4L22 2ZM11 13 22 2"/>',
  copy:'<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  eye:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  alert:'<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3h.01"/>',
  'check-circle':'<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  grid:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  monitor:'<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  map:'<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Zm6-3v15m6-12v15"/>',
  'map-pin':'<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 0 1 14 0Z"/><circle cx="12" cy="10" r="2"/>',
  wallet:'<rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 8h18m-4 4h4v5h-4a2.5 2.5 0 0 1 0-5Z"/>',
  bell:'<path d="M5 17h14l-2-4V8a5 5 0 0 0-10 0v5l-2 4Zm5 3h4"/>',
};
export function icon(name,size=20) { return `<svg class="icon" width="${Number(size)||20}" height="${Number(size)||20}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.gift}</svg>`; }
export function brand(dark=false) {return `<span class="brand-lockup${dark?' brand-light':''}"><img src="./assets/mark.svg" width="38" height="38" alt=""><span>amigo<span class="brand-word">secreto<span class="brand-dot">.</span></span></span></span>`;}
let avatarDirectory = new Map();
export function setAvatarDirectory(people=[]) {
 avatarDirectory=new Map(people.filter(person=>person.avatar).map(person=>[person.name||[person.firstName,person.lastName].filter(Boolean).join(' '),person.avatar]));
}
export function avatar(name,index=0,size='',photo) {
 const initials=String(name||'?').trim().split(/\s+/).filter(Boolean).slice(0,2).map(w=>w[0]).join('').toUpperCase();
 const image=arguments.length>=4 ? photo : avatarDirectory.get(String(name));
 if(image && /^data:image\/(?:webp|jpeg|png);base64,/.test(image)) return `<span class="avatar avatar-photo ${escapeHtml(size)}"><img src="${escapeHtml(image)}" alt="${escapeHtml(name)}" width="36" height="36"></span>`;
 return `<span class="avatar avatar-${Math.abs(Number(index)||0)%6} ${escapeHtml(size)}" aria-label="${escapeHtml(name)}">${escapeHtml(initials)}</span>`;
}
