export function passkeySite(req) {
  let origin;
  try { origin = new URL(process.env.APP_URL || 'https://amigosecreto.sanida.me'); }
  catch { return null; }
  const local = !process.env.VERCEL && ['localhost', '127.0.0.1'].includes(origin.hostname);
  if ((origin.protocol !== 'https:' && !(local && origin.protocol === 'http:')) || req.headers.origin !== origin.origin) return null;
  return { origin: origin.origin, rpID: origin.hostname, secure: origin.protocol === 'https:' };
}
