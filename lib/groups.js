import { randomInt, randomUUID } from 'node:crypto';
import { ApiError, query, requireUUID, transaction } from './db.js';
import { hashToken, newToken, normalizeEmail, rateLimit } from './auth.js';
import { getDeliveryReceipt, sendNotification } from './mail.js';

const userFields = row => ({ id: row.id, firstName: row.first_name, lastName: row.last_name, email: row.deleted_at ? '' : row.email, avatar: row.deleted_at ? null : row.avatar || null, name: `${row.first_name} ${row.last_name}` });
async function lockActiveUser(client, user) {
  const active = (await client.query('SELECT id FROM as_users WHERE id=$1 AND deleted_at IS NULL FOR KEY SHARE', [user.id])).rows[0];
  if (!active) throw new ApiError(401, 'UNAUTHORIZED', 'Entre na sua conta para continuar.');
}
export function createCycle(people, random = randomInt) {
  if (!Array.isArray(people) || people.length < 3) throw new ApiError(409, 'MIN_PARTICIPANTS', 'São necessárias pelo menos 3 pessoas confirmadas.');
  if (new Set(people.map(person => person.id)).size !== people.length) throw new Error('Participant ids must be unique');
  const shuffled = [...people];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.map((giver, i) => ({ giver, receiver: shuffled[(i + 1) % shuffled.length] }));
}
export function validateGroup(body) {
  const text = (key, max, required = false) => {
    if (body[key] !== undefined && typeof body[key] !== 'string') throw new ApiError(400, 'INVALID_GROUP', 'Confira os detalhes do grupo.');
    const value = (body[key] || '').trim();
    if (value.length > max || required && !value || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw new ApiError(400, 'INVALID_GROUP', 'Confira os detalhes do grupo.');
    return value;
  };
  const date = text('date', 10, true), budget = Number(body.budget);
  const parsed = new Date(`${date}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date || date < new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Maceio' }).format(new Date())) throw new ApiError(400, 'INVALID_DATE', 'Escolha uma data válida a partir de hoje.');
  if (!['number', 'string'].includes(typeof body.budget) || !Number.isFinite(budget) || budget < 1 || budget > 100000 || String(body.budget).trim() === '') throw new ApiError(400, 'INVALID_BUDGET', 'Informe um valor entre R$ 1,00 e R$ 100.000,00.');
  return { name: text('name', 80, true), date, budget: Math.round(budget * 100) / 100, location: text('location', 120), description: text('description', 500) };
}
function groupView(row, userId) {
  return { id: row.id, name: row.name, date: row.event_date, budget: Number(row.budget), location: row.location, description: row.description,
    organizerId: row.organizer_id, organizerName: row.organizer_name, drawn: Boolean(row.drawn_at), drawnAt: row.drawn_at, role: row.organizer_id === userId ? 'organizer' : 'member',
    participantCount: Number(row.participant_count || 0), acceptedCount: Number(row.accepted_count || 0), pendingCount: Number(row.pending_count || 0), failedCount: Number(row.failed_count || 0), notificationFailures: Number(row.notification_failures || 0) };
}
const groupColumns = `g.id,g.organizer_id,g.name,to_char(g.event_date,'YYYY-MM-DD') AS event_date,g.budget,g.location,g.description,g.drawn_at,
  o.first_name || ' ' || o.last_name AS organizer_name,o.email AS organizer_email`;
// Compute maintenance flags in the existing authorized group read. No payloads or
// extra empty transactions are fetched merely because someone opens a group.
const notificationSummary = `CASE WHEN g.organizer_id=$2 THEN (
  SELECT json_build_object(
    'failures', count(*) FILTER (WHERE n.state='failed' AND (n.kind='result' OR
      (m.status<>'accepted' AND g.drawn_at IS NULL AND coalesce(n.provider_status,'') NOT IN ('bounced','complained','suppressed')))),
    'outboxDue', coalesce(bool_or(
      ((n.state IN ('pending','failed') AND n.next_attempt_at<=now()) OR (n.state='sending' AND n.lease_until<now()))
      AND n.attempts<8 AND coalesce(n.provider_status,'') NOT IN ('bounced','complained','suppressed')
      AND (n.kind<>'invite' OR (m.status<>'accepted' AND g.drawn_at IS NULL))),false),
    'receiptsDue', coalesce(bool_or(
      n.kind='invite' AND n.state='sent' AND n.provider_id IS NOT NULL AND n.receipt_terminal=false
      AND n.receipt_next_check_at<=now() AND n.sent_at>now()-interval '7 days' AND m.status<>'accepted'
      AND NOT EXISTS(SELECT 1 FROM as_outbox newer WHERE newer.membership_id=n.membership_id AND newer.kind='invite' AND newer.created_at>n.created_at)),false))
  FROM as_outbox n JOIN as_memberships m ON m.id=n.membership_id WHERE n.group_id=g.id
) ELSE NULL END AS notification_summary`;
async function accessibleGroup(client, id, user, { lock = false, organizerOnly = false, notificationStats = false } = {}) {
  requireUUID(id);
  const { rows } = await client.query(`SELECT ${groupColumns}${notificationStats ? `,${notificationSummary}` : ''} FROM as_groups g JOIN as_users o ON o.id=g.organizer_id
    WHERE g.id=$1 AND (g.organizer_id=$2 OR EXISTS(SELECT 1 FROM as_memberships m WHERE m.group_id=g.id AND m.user_id=$2 AND m.status='accepted')) ${lock ? 'FOR UPDATE OF g' : ''}`, [id, user.id]);
  if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Não encontramos esse grupo.');
  if (organizerOnly && rows[0].organizer_id !== user.id) throw new ApiError(403, 'FORBIDDEN', 'Apenas quem organiza pode fazer isso.');
  return rows[0];
}
export async function listGroups(user) {
  const { rows } = await query(`WITH visible_groups AS (
      SELECT g.id FROM as_groups g WHERE g.organizer_id=$1 OR EXISTS(
        SELECT 1 FROM as_memberships m WHERE m.group_id=g.id AND m.user_id=$1 AND m.status='accepted')
      ORDER BY g.created_at DESC LIMIT 200
    ) SELECT ${groupColumns},counts.participant_count,counts.accepted_count,counts.pending_count,counts.failed_count
    FROM visible_groups v JOIN as_groups g ON g.id=v.id JOIN as_users o ON o.id=g.organizer_id
    CROSS JOIN LATERAL (
      SELECT count(*) AS participant_count,count(*) FILTER (WHERE m.status='accepted') AS accepted_count,
        count(*) FILTER (WHERE m.status IN ('sent','delivered','opened')) AS pending_count,
        count(*) FILTER (WHERE m.status='failed') AS failed_count
      FROM as_memberships m WHERE m.group_id=g.id
    ) counts ORDER BY g.created_at DESC`, [user.id]);
  return { groups: rows.map(row => groupView(row, user.id)) };
}
export async function createGroup(user, body) {
  const group = validateGroup(body);
  await rateLimit('create-group', user.id, 20, 86400);
  const id = randomUUID();
  await transaction(async client => {
    await lockActiveUser(client, user);
    await client.query('INSERT INTO as_groups(id,organizer_id,name,event_date,budget,location,description) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, user.id, group.name, group.date, group.budget, group.location, group.description]);
    await client.query("INSERT INTO as_memberships(id,group_id,user_id,email,invited_name,status,accepted_at) VALUES($1,$2,$3,$4,$5,'accepted',now())", [randomUUID(), id, user.id, user.email, `${user.firstName} ${user.lastName}`]);
  });
  return { group: (await getGroup(user, id)).group };
}
async function resultFor(client, groupId, userId) {
  const { rows } = await client.query(`SELECT u.id,u.first_name,u.last_name,u.email,u.avatar,u.deleted_at FROM as_draw_results r
    JOIN as_memberships giver ON giver.id=r.giver_id AND giver.group_id=r.group_id
    JOIN as_memberships receiver ON receiver.id=r.receiver_id AND receiver.group_id=r.group_id
    JOIN as_users u ON u.id=receiver.user_id WHERE r.group_id=$1 AND giver.user_id=$2`, [groupId, userId]);
  return rows[0] ? userFields(rows[0]) : null;
}
export async function getGroup(user, id) {
  const client = { query };
  let row = await accessibleGroup(client, id, user, { notificationStats: true });
  const maintenance = [];
  if (row.notification_summary?.outboxDue) maintenance.push(flushOutbox(id, 15));
  if (row.notification_summary?.receiptsDue) maintenance.push(syncDeliveryReceipts(id, 10));
  if (maintenance.length) {
    // Refreshing an organizer's list returns the new delivery state immediately.
    // Failures remain durable for the hourly fallback or an explicit retry.
    await Promise.allSettled(maintenance);
    row = await accessibleGroup(client, id, user, { notificationStats: true });
  }
  row.notification_failures = row.notification_summary?.failures || 0;
  const { rows } = await query(`SELECT m.id,CASE WHEN u.deleted_at IS NULL THEN m.email ELSE '' END AS email,m.status,m.user_id,m.invited_name,u.first_name,u.last_name,u.avatar,m.opened_at,m.delivered_at
    FROM as_memberships m LEFT JOIN as_users u ON u.id=m.user_id WHERE m.group_id=$1
    ORDER BY CASE WHEN m.user_id=$2 THEN 0 ELSE 1 END,m.created_at,m.id`, [id, row.organizer_id]);
  row.participant_count = rows.length;
  row.accepted_count = rows.filter(p => p.status === 'accepted').length;
  row.failed_count = rows.filter(p => p.status === 'failed').length;
  row.pending_count = rows.length - row.accepted_count - row.failed_count;
  const group = groupView(row, user.id);
  return { group, role: group.role, organizerEmail: row.organizer_email, participants: rows.map((p, i) => ({ id: p.id, invitationId: p.id, userId: p.user_id, name: p.first_name ? `${p.first_name} ${p.last_name}` : p.invited_name || p.email.split('@')[0], email: p.email, status: p.status, avatar: p.avatar || null, color: i % 6, isOrganizer: p.user_id === row.organizer_id, openedAt: p.opened_at, deliveredAt: p.delivered_at })), match: null };
}
export async function getResult(user, id) {
  const group = await accessibleGroup({ query }, id, user);
  if (!group.drawn_at) throw new ApiError(409, 'NOT_DRAWN', 'O sorteio ainda não aconteceu.');
  const match = await resultFor({ query }, id, user.id);
  if (!match) throw new ApiError(404, 'NOT_PARTICIPATING', 'Você não participou deste sorteio.');
  return { match };
}
async function enqueue(client, { groupId, memberId, kind, key, payload }) {
  const id = randomUUID();
  await client.query('INSERT INTO as_outbox(id,group_id,membership_id,kind,dedupe_key,delivery_key,payload) VALUES($1,$2,$3,$4,$5,$5,$6) ON CONFLICT(dedupe_key) DO NOTHING', [id, groupId, memberId, kind, key, JSON.stringify(payload)]);
  return id;
}
export async function invitePeople(user, groupId, body) {
  if (!Array.isArray(body.emails) || !body.emails.length || body.emails.length > 50) throw new ApiError(400, 'INVALID_EMAILS', 'Envie de 1 a 50 e-mails por vez.');
  const emails = [...new Set(body.emails.map(normalizeEmail))];
  await rateLimit('invite-people', user.id, 20, 3600);
  const added = [], skipped = [];
  await transaction(async client => {
    const group = await accessibleGroup(client, groupId, user, { lock: true, organizerOnly: true });
    if (group.drawn_at) throw new ApiError(409, 'GROUP_DRAWN', 'Os participantes não podem mudar depois do sorteio.');
    const existing = (await client.query('SELECT email FROM as_memberships WHERE group_id=$1', [groupId])).rows.map(p => p.email);
    const fresh = emails.filter(email => !existing.includes(email));
    if (existing.length + fresh.length > 200) throw new ApiError(400, 'GROUP_FULL', 'O grupo pode ter até 200 pessoas.');
    for (const email of emails) {
      if (existing.includes(email)) { skipped.push(email); continue; }
      const memberId = randomUUID(), inviteToken = newToken(), trackingToken = newToken();
      await client.query(`INSERT INTO as_memberships(id,group_id,email,invited_name,invite_token_hash,invite_expires_at,tracking_token_hash,last_invited_at)
        VALUES($1,$2,$3,$4,$5,now()+interval '90 days',$6,now())`, [memberId, groupId, email, email.split('@')[0].replace(/[._-]/g, ' '), hashToken(inviteToken), hashToken(trackingToken)]);
      await enqueue(client, { groupId, memberId, kind: 'invite', key: `invite:${memberId}:1`, payload: { kind: 'invite', to: email, user, group: groupView(group, user.id), inviteToken, trackingToken } });
      added.push({ id: memberId, email });
    }
  });
  await flushOutbox(groupId, 50);
  const states = added.length ? (await query("SELECT m.id,m.email,o.state FROM as_memberships m JOIN as_outbox o ON o.membership_id=m.id WHERE m.id=ANY($1::uuid[]) AND o.kind='invite'", [added.map(p => p.id)])).rows : [];
  return { sent: states.filter(row => row.state === 'sent').map(row => row.email), failed: states.filter(row => row.state === 'failed').map(row => ({ email: row.email, message: 'O envio falhou. Você pode tentar novamente.' })), queued: states.filter(row => ['pending','sending'].includes(row.state)).map(row => row.email), skipped };
}
export async function resendInvite(user, groupId, memberId) {
  requireUUID(memberId);
  await rateLimit('resend-invite-user', user.id, 30, 3600);
  await transaction(async client => {
    const group = await accessibleGroup(client, groupId, user, { lock: true, organizerOnly: true });
    if (group.drawn_at) throw new ApiError(409, 'GROUP_DRAWN', 'O sorteio já foi realizado.');
    const member = (await client.query('SELECT id,email,status,last_invited_at FROM as_memberships WHERE id=$1 AND group_id=$2 FOR UPDATE', [memberId, groupId])).rows[0];
    if (!member) throw new ApiError(404, 'NOT_FOUND', 'Convite não encontrado.');
    if (member.status === 'accepted') return;
    if (member.last_invited_at && Date.now() - new Date(member.last_invited_at).getTime() < 60000) throw new ApiError(429, 'RATE_LIMITED', 'Aguarde um minuto para reenviar o convite.');
    const sending = (await client.query("SELECT id FROM as_outbox WHERE membership_id=$1 AND kind='invite' AND state='sending' AND lease_until>now() LIMIT 1", [memberId])).rows[0];
    if (sending) throw new ApiError(409, 'SEND_PENDING', 'Este convite ainda está sendo enviado. Aguarde alguns instantes.');
    const inviteToken = newToken(), trackingToken = newToken();
    await client.query("UPDATE as_outbox SET state='cancelled' WHERE membership_id=$1 AND kind='invite' AND state IN ('pending','failed')", [memberId]);
    await client.query("UPDATE as_memberships SET invite_token_hash=$2,tracking_token_hash=$3,invite_expires_at=now()+interval '90 days',last_invited_at=now(),status='sent',opened_at=NULL,delivered_at=NULL WHERE id=$1", [memberId, hashToken(inviteToken), hashToken(trackingToken)]);
    await enqueue(client, { groupId, memberId, kind: 'invite', key: `invite:${memberId}:${randomUUID()}`, payload: { kind: 'invite', to: member.email, user, group: groupView(group, user.id), inviteToken, trackingToken } });
  });
  const notifications = await flushOutbox(groupId, 50);
  return { ok: true, notifications };
}
export async function getInvitation(token, user = null) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ApiError(404, 'INVITATION_EXPIRED', 'Este convite não está disponível.');
  const { rows } = await query(`SELECT m.email,m.status,m.invite_expires_at,${groupColumns}
    FROM as_memberships m JOIN as_groups g ON g.id=m.group_id JOIN as_users o ON o.id=g.organizer_id WHERE m.invite_token_hash=$1`, [hashToken(token)]);
  const row = rows[0];
  if (!row || new Date(row.invite_expires_at).getTime() <= Date.now()) throw new ApiError(410, 'INVITATION_EXPIRED', 'Esse convite expirou. Peça um novo a quem organiza.');
  await query("UPDATE as_memberships SET opened_at=coalesce(opened_at,now()),status=CASE WHEN status IN ('accepted','failed') THEN status ELSE 'opened' END WHERE invite_token_hash=$1 AND (opened_at IS NULL OR status IN ('sent','delivered'))", [hashToken(token)]);
  const ownMember = user ? (await query('SELECT status,invite_expires_at FROM as_memberships WHERE group_id=$1 AND email=$2', [row.id, user.email])).rows[0] : null;
  const currentUserInvited = Boolean(ownMember && (ownMember.status === 'accepted' || new Date(ownMember.invite_expires_at).getTime() > Date.now()));
  const currentUserAccepted = currentUserInvited && ownMember.status === 'accepted';
  const accountExists = Boolean((await query('SELECT id FROM as_users WHERE email=$1 AND deleted_at IS NULL', [row.email])).rows[0]);
  const [local, domain] = row.email.split('@');
  const effectiveStatus = currentUserInvited ? ownMember.status : row.status;
  return { group: { id: row.id, name: row.name, date: row.event_date, budget: Number(row.budget), location: row.location, description: row.description, drawn: Boolean(row.drawn_at) },
    inviterName: row.organizer_name, emailMasked: `${local[0]}${'*'.repeat(Math.min(6, Math.max(3, local.length - 1)))}@${domain}`,
    recipientEmail: row.email, accountExists, emailVerified: !row.drawn_at && row.status !== 'accepted',
    currentUserInvited, currentUserAccepted, currentUserEmail: user?.email || null,
    status: row.drawn_at && effectiveStatus !== 'accepted' ? 'closed' : effectiveStatus === 'accepted' ? 'accepted' : 'pending' };
}
export async function acceptInvitation(user, token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ApiError(404, 'INVITATION_EXPIRED', 'Convite não encontrado.');
  const groupId = await transaction(async client => {
    // Deletion locks the user before affected groups. Check the same active row
    // before accepting, even when the request loaded its session before deletion.
    await lockActiveUser(client, user);
    const lookup = (await client.query('SELECT group_id FROM as_memberships WHERE invite_token_hash=$1', [hashToken(token)])).rows[0];
    if (!lookup) throw new ApiError(404, 'INVITATION_EXPIRED', 'Convite não encontrado.');
    const group = (await client.query('SELECT id,drawn_at FROM as_groups WHERE id=$1 FOR UPDATE', [lookup.group_id])).rows[0];
    if (!group) throw new ApiError(404, 'INVITATION_EXPIRED', 'Convite não encontrado.');
    const link = (await client.query('SELECT invite_expires_at FROM as_memberships WHERE invite_token_hash=$1 AND group_id=$2', [hashToken(token), group.id])).rows[0];
    if (!link || new Date(link.invite_expires_at).getTime() <= Date.now()) throw new ApiError(410, 'INVITATION_EXPIRED', 'Esse convite expirou. Peça um novo a quem organiza.');
    // A logged-in invitee may use the group's link but only ever accepts their own row.
    const member = (await client.query('SELECT id,email,status,invite_expires_at FROM as_memberships WHERE group_id=$1 AND email=$2 FOR UPDATE', [group.id, user.email])).rows[0];
    if (!member) throw new ApiError(403, 'EMAIL_MISMATCH', 'A conta conectada não recebeu convite para este grupo. Saia para entrar com outra conta.');
    if (member.status === 'accepted') return group.id;
    if (new Date(member.invite_expires_at).getTime() <= Date.now()) throw new ApiError(410, 'INVITATION_EXPIRED', 'Seu convite expirou. Peça um novo a quem organiza.');
    if (group.drawn_at) throw new ApiError(409, 'INVITATION_CLOSED', 'O sorteio já aconteceu e não aceita novos participantes.');
    await client.query("UPDATE as_memberships SET user_id=$2,status='accepted',accepted_at=now() WHERE id=$1", [member.id, user.id]);
    return group.id;
  });
  return { group: (await getGroup(user, groupId)).group };
}
export async function drawGroup(user, groupId) {
  await rateLimit('draw-group', user.id, 30, 3600);
  await transaction(async client => {
    const group = await accessibleGroup(client, groupId, user, { lock: true, organizerOnly: true });
    if (group.drawn_at) return;
    const { rows } = await client.query(`SELECT m.id,u.id AS user_id,u.first_name,u.last_name,u.email,u.avatar FROM as_memberships m
      JOIN as_users u ON u.id=m.user_id WHERE m.group_id=$1 AND m.status='accepted' ORDER BY m.id`, [groupId]);
    const assignments = createCycle(rows);
    for (const { giver, receiver } of assignments) {
      await client.query('INSERT INTO as_draw_results(group_id,giver_id,receiver_id) VALUES($1,$2,$3)', [groupId, giver.id, receiver.id]);
      await enqueue(client, { groupId, memberId: giver.id, kind: 'result', key: `result:${groupId}:${giver.id}`, payload: { kind: 'result', to: giver.email, user: userFields({ ...giver, id: giver.user_id }), group: { ...groupView(group, user.id), drawn: true }, match: userFields({ ...receiver, id: receiver.user_id }) } });
    }
    await client.query('UPDATE as_groups SET drawn_at=now() WHERE id=$1', [groupId]);
    await client.query("UPDATE as_outbox SET state='cancelled' WHERE group_id=$1 AND kind='invite' AND state IN ('pending','failed')", [groupId]);
  });
  const notifications = await flushOutbox(groupId, 200);
  return { group: (await getGroup(user, groupId)).group, notifications };
}
export function nextDeliveryKey(row) {
  return row.provider_status === 'failed' ? `${row.dedupe_key}:retry:${Number(row.attempts) + 1}` : row.delivery_key;
}
export async function flushOutbox(groupId, limit = 50, manual = false) {
  const claimed = await transaction(async client => {
    const { rows } = await client.query(`SELECT id,dedupe_key,delivery_key,provider_status,attempts,payload,kind,membership_id FROM as_outbox WHERE ($1::uuid IS NULL OR group_id=$1)
      AND ((state IN ('pending','failed') AND next_attempt_at<=now()) OR (state='sending' AND lease_until<now())) AND (attempts<8 OR $3::boolean)
      AND coalesce(provider_status,'') NOT IN ('bounced','complained','suppressed')
      AND (kind<>'invite' OR EXISTS(SELECT 1 FROM as_memberships m JOIN as_groups g ON g.id=m.group_id
        WHERE m.id=as_outbox.membership_id AND m.status<>'accepted' AND g.drawn_at IS NULL))
      ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED`, [groupId, Math.min(200, limit), manual]);
    for (const row of rows) {
      // A known provider rejection needs a fresh key. Ambiguous transport failures
      // retain the persisted key so retries cannot duplicate an accepted message.
      row.delivery_key = nextDeliveryKey(row);
      await client.query("UPDATE as_outbox SET state='sending',attempts=attempts+1,delivery_key=$2,provider_status=NULL,lease_until=now()+interval '5 minutes' WHERE id=$1", [row.id, row.delivery_key]);
    }
    return rows;
  });
  let sent = 0, failed = 0;
  // Bounded concurrency avoids provider bursts and keeps retries independently durable.
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, claimed.length) }, async () => {
    while (cursor < claimed.length) {
      const row = claimed[cursor++];
      try {
        const result = await sendNotification({ ...row.payload, idempotencyKey: row.delivery_key });
        if (!result || !['queued', 'processing', 'sent', 'delivered'].includes(result.status)) {
          const error = new Error('Notification was not accepted');
          error.definitiveFailure = result?.status === 'failed'; error.providerId = result?.id;
          throw error;
        }
        await transaction(async client => {
          await client.query("UPDATE as_outbox SET state='sent',provider_id=$2,provider_status=$3,provider_message_id=$4,sent_at=now(),lease_until=NULL,receipt_checked_at=NULL,receipt_next_check_at=now()+interval '1 minute',receipt_terminal=false WHERE id=$1", [row.id, result.id || null, result.status, result.emailMessageId || null]);
          if (row.kind === 'invite') await client.query(`UPDATE as_memberships SET sent_at=coalesce(sent_at,now()),
            delivered_at=CASE WHEN $2='delivered' THEN coalesce(delivered_at,now()) ELSE delivered_at END,
            status=CASE WHEN status IN ('accepted','opened') THEN status WHEN $2='delivered' THEN 'delivered' ELSE 'sent' END WHERE id=$1`, [row.membership_id, result.status]);
        });
        sent++;
      } catch (error) {
        await transaction(async client => {
          await client.query("UPDATE as_outbox SET state='failed',provider_status=$2,provider_id=coalesce($3,provider_id),lease_until=NULL,next_attempt_at=now()+least(attempts*60,3600)*interval '1 second' WHERE id=$1", [row.id, error.definitiveFailure ? 'failed' : null, error.providerId || null]);
          if (row.kind === 'invite') await client.query("UPDATE as_memberships SET status='failed' WHERE id=$1 AND status NOT IN ('accepted','opened','delivered')", [row.membership_id]);
        });
        failed++;
      }
    }
  }));
  return { sent, failed };
}
export async function retryNotifications(user, groupId) {
  await accessibleGroup({ query }, groupId, user, { organizerOnly: true });
  await rateLimit('retry-notifications', user.id, 10, 3600);
  await query("UPDATE as_outbox SET next_attempt_at=now() WHERE group_id=$1 AND state='failed'", [groupId]);
  return { notifications: await flushOutbox(groupId, 200, true) };
}

function receiptDate(value) {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
export function normalizeDeliveryReceipt(receipt, now = Date.now()) {
  if (!receipt || typeof receipt !== 'object') return null;
  const status = String(receipt.status || '').toLowerCase();
  const deliveredAt = receiptDate(receipt.deliveredAt);
  const openedAt = receiptDate(receipt.openedAt);
  for (const [providerStatus, field] of [['suppressed', 'suppressedAt'], ['complained', 'complainedAt'], ['bounced', 'bouncedAt']]) {
    if (status === providerStatus || receiptDate(receipt[field])) return { status: 'failed', providerStatus, deliveredAt, openedAt, terminal: true, retryable: false };
  }
  if (status === 'failed' || receiptDate(receipt.failedAt) && !deliveredAt && !openedAt) return { status: 'failed', providerStatus: 'failed', deliveredAt, openedAt, terminal: true, retryable: true };
  if (openedAt || status === 'opened') return { status: 'opened', providerStatus: 'opened', deliveredAt, openedAt: openedAt || new Date(now).toISOString(), terminal: false, retryable: false };
  if (deliveredAt || status === 'delivered') return { status: 'delivered', providerStatus: 'delivered', deliveredAt: deliveredAt || new Date(now).toISOString(), openedAt: null, terminal: false, retryable: false };
  if (['queued', 'processing', 'sent'].includes(status)) return { status: 'sent', providerStatus: status, deliveredAt: null, openedAt: null, terminal: false, retryable: false };
  return null;
}
export function receiptPollingDelay(sentAt, delivered = false, error = false, now = Date.now()) {
  const age = Math.max(0, now - new Date(sentAt).getTime());
  const delay = age >= 86400000 ? 21600 : delivered || age >= 3600000 ? 1800 : 300;
  return error ? Math.max(1800, delay) : delay;
}
export async function syncDeliveryReceipts(groupId = null, limit = 30) {
  const claimed = await transaction(async client => {
    const { rows } = await client.query(`SELECT o.id,o.membership_id,o.provider_id,o.sent_at,o.provider_status FROM as_outbox o
      JOIN as_memberships m ON m.id=o.membership_id WHERE ($1::uuid IS NULL OR o.group_id=$1)
      AND o.kind='invite' AND o.state='sent' AND o.provider_id IS NOT NULL AND o.receipt_terminal=false
      AND o.receipt_next_check_at<=now() AND o.sent_at>now()-interval '7 days' AND m.status<>'accepted'
      AND NOT EXISTS(SELECT 1 FROM as_outbox newer WHERE newer.membership_id=o.membership_id AND newer.kind='invite' AND newer.created_at>o.created_at)
      ORDER BY o.receipt_next_check_at LIMIT $2 FOR UPDATE OF o SKIP LOCKED`, [groupId, Math.max(1, Math.min(30, limit))]);
    if (rows.length) await client.query("UPDATE as_outbox SET receipt_next_check_at=now()+interval '5 minutes' WHERE id=ANY($1::uuid[])", [rows.map(row => row.id)]);
    return rows;
  });
  let cursor = 0, updated = 0;
  await Promise.all(Array.from({ length: Math.min(3, claimed.length) }, async () => {
    while (cursor < claimed.length) {
      const row = claimed[cursor++];
      let receipt;
      try {
        const response = await getDeliveryReceipt(row.provider_id);
        receipt = response && String(response.id) === row.provider_id ? normalizeDeliveryReceipt(response) : null;
      } catch { receipt = null; }
      if (!receipt) {
        await query("UPDATE as_outbox SET receipt_checked_at=now(),receipt_next_check_at=now()+$2::integer*interval '1 second' WHERE id=$1", [row.id, receiptPollingDelay(row.sent_at, row.provider_status === 'delivered', true)]);
        continue;
      }
      const changed = await transaction(async client => {
        // A superseded invitation must never overwrite the status of its resend.
        const result = await client.query(`UPDATE as_outbox o SET provider_status=$2,receipt_checked_at=now(),receipt_terminal=$3,
          receipt_next_check_at=now()+$4::integer*interval '1 second',state=CASE WHEN $5='failed' THEN 'failed' ELSE state END,
          next_attempt_at=CASE WHEN $6::boolean THEN now()+interval '5 minutes' ELSE next_attempt_at END
          WHERE o.id=$1 AND o.state='sent' AND o.provider_id=$7
          AND NOT EXISTS(SELECT 1 FROM as_outbox newer WHERE newer.membership_id=o.membership_id AND newer.kind='invite' AND newer.created_at>o.created_at)
          RETURNING membership_id`, [row.id, receipt.providerStatus, receipt.terminal, receiptPollingDelay(row.sent_at, Boolean(receipt.deliveredAt)), receipt.status, receipt.retryable, row.provider_id]);
        if (!result.rowCount) return false;
        await client.query(`UPDATE as_memberships SET delivered_at=coalesce(delivered_at,$3::timestamptz),opened_at=coalesce(opened_at,$4::timestamptz),
          status=CASE WHEN status='accepted' THEN status WHEN $2='failed' THEN 'failed' WHEN status='opened' THEN status
            WHEN $2='opened' THEN 'opened' WHEN status='delivered' AND $2='sent' THEN status ELSE $2 END WHERE id=$1`, [row.membership_id, receipt.status, receipt.deliveredAt, receipt.openedAt]);
        return true;
      });
      if (changed) updated++;
    }
  }));
  return { checked: claimed.length, updated };
}
export async function drainOutbox() {
  // One indexed preflight is enough when the application has no pending work.
  // The actual workers retain their transactional claims for concurrent callers.
  const { rows } = await query(`SELECT
    EXISTS(SELECT 1 FROM as_outbox n JOIN as_memberships m ON m.id=n.membership_id JOIN as_groups g ON g.id=n.group_id
      WHERE ((n.state IN ('pending','failed') AND n.next_attempt_at<=now()) OR (n.state='sending' AND n.lease_until<now()))
      AND n.attempts<8 AND coalesce(n.provider_status,'') NOT IN ('bounced','complained','suppressed')
      AND (n.kind<>'invite' OR (m.status<>'accepted' AND g.drawn_at IS NULL))) AS outbox_due,
    EXISTS(SELECT 1 FROM as_outbox n JOIN as_memberships m ON m.id=n.membership_id
      WHERE n.kind='invite' AND n.state='sent' AND n.provider_id IS NOT NULL AND n.receipt_terminal=false
      AND n.receipt_next_check_at<=now() AND n.sent_at>now()-interval '7 days' AND m.status<>'accepted'
      AND NOT EXISTS(SELECT 1 FROM as_outbox newer WHERE newer.membership_id=n.membership_id AND newer.kind='invite' AND newer.created_at>n.created_at)) AS receipts_due`);
  const [notifications, receipts] = await Promise.all([
    rows[0].outbox_due ? flushOutbox(null, 30) : { sent: 0, failed: 0 },
    rows[0].receipts_due ? syncDeliveryReceipts(null, 30) : { checked: 0, updated: 0 },
  ]);
  return { ...notifications, receipts };
}
export async function trackOpen(token) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
  await query("UPDATE as_memberships SET opened_at=coalesce(opened_at,now()),status=CASE WHEN status IN ('accepted','failed') THEN status ELSE 'opened' END WHERE tracking_token_hash=$1 AND (opened_at IS NULL OR status IN ('sent','delivered'))", [hashToken(token)]);
}

export async function deleteGroup(user, id, body) {
  requireUUID(id);
  return transaction(async client => {
    // Deletion, drawing and roster changes serialize on the same group lock.
    const group = await accessibleGroup(client, id, user, { lock: true, organizerOnly: true });
    if (typeof body?.confirmation !== 'string' || body.confirmation !== group.name) {
      throw new ApiError(400, 'CONFIRMATION_REQUIRED', 'Digite o nome do amigo secreto para confirmar a exclusão.');
    }
    // A claimed delivery can be outside this transaction at the mail provider.
    // Lock every outbox row so a new worker cannot claim a message while deleting.
    const deliveries = (await client.query('SELECT state,lease_until FROM as_outbox WHERE group_id=$1 FOR UPDATE', [id])).rows;
    if (deliveries.some(row => row.state === 'sending' && new Date(row.lease_until).getTime() > Date.now())) {
      throw new ApiError(409, 'NOTIFICATIONS_IN_PROGRESS', 'Há um envio de e-mail em andamento. Aguarde alguns instantes e confirme a exclusão novamente.');
    }
    await client.query('DELETE FROM as_draw_results WHERE group_id=$1', [id]);
    // Memberships and pending notification payloads are removed by foreign-key cascades.
    await client.query('DELETE FROM as_groups WHERE id=$1', [id]);
    return { ok: true, deletedId: id };
  });
}
