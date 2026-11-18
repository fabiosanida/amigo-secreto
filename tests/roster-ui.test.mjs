import test from 'node:test';
import assert from 'node:assert/strict';
import { renderGroups } from '../prototype/groups.js';
import { renderDependents, renderGroupDependents } from '../prototype/dependents.js';
import { renderWishlists } from '../prototype/wishlist.js';

const creator = { id: 'creator-user', firstName: 'Pessoa', email: 'creator@example.test' };
const group = { id: 'group-one', organizerId: creator.id, organizerName: 'Pessoa Criadora', name: 'Grupo de teste', date: '2030-12-25', budget: 50 };
const child = { id: 'child-one', firstName: 'Lia', lastName: 'Teste', name: 'Lia Teste', active: true };
const roster = [
  { id: 'creator-membership', userId: creator.id, name: 'Pessoa Criadora', email: creator.email, status: 'accepted', isOrganizer: true },
  { id: 'member-membership', userId: 'member-user', name: 'Pessoa Convidada', email: 'member@example.test', status: 'accepted' },
  { id: 'pending-membership', userId: null, name: 'Convite Pendente', email: 'pending@example.test', status: 'sent' },
  { id: 'child-membership', userId: null, dependentId: child.id, guardianId: creator.id, isDependent: true, responsibleName: 'Pessoa Criadora', name: child.name, email: '', status: 'accepted' },
];
const state = extra => ({ production: true, user: creator, group, role: 'organizer', drawn: false, participants: roster, ownDependents: [child], ...extra });
const buttons = (html, action) => [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]).filter(button => button.includes(`data-action="${action}"`));
const removalIds = html => buttons(html, 'remove-participant').map(button => button.match(/data-participant-id="([^"]+)"/)?.[1]).sort();

test('only the actual creator receives roster removal and direct dependent-registration actions', () => {
  const expected = ['child-membership', 'member-membership', 'pending-membership'];
  assert.deepEqual(removalIds(renderGroups('group', state())), expected);
  // The identity remains authoritative even if a stale UI role says member.
  assert.deepEqual(removalIds(renderGroups('group-member', state())), expected);
  assert.equal(buttons(renderGroupDependents(state()), 'add-group-dependent').length, 1);
  for (const user of [
    { id: 'member-user', email: 'member@example.test' },
    { id: 'admin-user', email: 'fabiosanida@gmail.com', isAdmin: true },
    { id: 'outsider', email: creator.email },
    null,
  ]) {
    const visitor = state({ user, role: 'organizer', isAdmin: true });
    assert.deepEqual(removalIds(renderGroups('group', visitor)), []);
    assert.equal(buttons(renderGroupDependents(visitor), 'add-group-dependent').length, 0);
  }
  const member = renderGroupDependents(state({ user: { id: 'member-user' }, role: 'member' }));
  assert(member.includes('data-route="dependents?group=group-one"'), 'Members retain the existing personal dependent catalog');
});

test('removal always targets a membership and never offers the creator a self-removal action', () => {
  const html = renderGroups('group', state({ participants: [
    ...roster,
    { id: 'self-with-stale-label', userId: creator.id, name: 'Rótulo antigo', email: 'old-address@example.test', status: 'accepted', isOrganizer: false },
  ] }));
  assert(!removalIds(html).includes('creator-membership'));
  assert(!removalIds(html).includes('self-with-stale-label'));
  for (const button of buttons(html, 'remove-participant')) {
    assert.match(button, /data-participant-id="(?:child|member|pending)-membership"/);
    assert(!button.includes('data-email='), 'A removal must not depend on an email address, including for children without one');
    assert(button.includes('aria-label="Remover '));
  }
});

test('a completed draw exposes no roster mutations, while dependent information remains readable', () => {
  const drawn = state({ drawn: true, group: { ...group, drawn: true }, ownDependentsNextCursor: 'next-page' });
  const html = renderGroups('group', drawn), dependents = renderGroupDependents(drawn);
  for (const action of ['remove-participant', 'add-group-dependent', 'toggle-dependent']) assert.equal(buttons(html, action).length, 0);
  assert(dependents.includes('As participações estão fechadas.'));
  assert(dependents.includes('Participou deste sorteio'));
  assert.equal(buttons(dependents, 'group-dependents-more').length, 1, 'Existing catalog pages can still be read after the draw');
  assert(!dependents.includes('data-route="dependents?group='));
});

test('dependent pagination describes a partial catalog and disables duplicate loads', () => {
  const initial = { dependents: [child], dependentsNextCursor: 'page-two' };
  const catalog = renderDependents('dependents', initial);
  assert(catalog.includes('1 dependentes carregados.'));
  assert(catalog.includes('Sua turma de perto <span>1+</span>'));
  assert.equal(buttons(catalog, 'dependents-more').length, 1);
  const loading = buttons(renderDependents('dependents', { ...initial, dependentsLoadingMore: true }), 'dependents-more')[0];
  assert(loading.includes('aria-busy="true"')); assert(/\sdisabled(?:\s|>)/.test(loading));
  assert(loading.includes('Carregando…'));
  assert.equal(buttons(renderDependents('dependents', { ...initial, dependentsNextCursor: null }), 'dependents-more').length, 0);
});

test('the group count includes every participating dependent even when its catalog page is not loaded', () => {
  const partial = state({
    ownDependents: [{ ...child, active: false }], ownDependentsNextCursor: 'next-page',
    participants: [...roster,
      { id: 'second-child-membership', dependentId: 'second-child', guardianId: creator.id, status: 'accepted' },
      { id: 'third-child-membership', dependentId: 'third-child', guardianId: creator.id, status: 'accepted' },
      { id: 'unrelated-child-membership', dependentId: 'unrelated-child', guardianId: 'another-guardian', status: 'accepted' },
    ],
  });
  const html = renderGroupDependents(partial);
  assert(html.includes('Seus dependentes neste grupo <span>3</span>'));
  assert(html.includes('1 dependentes carregados.'));
  assert.equal(buttons(html, 'group-dependents-more').length, 1);
  const loading = buttons(renderGroupDependents({ ...partial, groupDependentsLoadingMore: true }), 'group-dependents-more')[0];
  assert(loading.includes('aria-busy="true"')); assert(/\sdisabled(?:\s|>)/.test(loading));
  assert.equal(buttons(renderGroupDependents({ ...partial, ownDependentsNextCursor: null }), 'group-dependents-more').length, 0);
});

test('participant-controlled names and identifiers cannot inject markup into removal controls', () => {
  const html = renderGroups('group', state({ participants: [{ ...roster[1], id: 'member-" onclick="attack()', name: '<img src=x onerror=attack()>' }] }));
  const button = buttons(html, 'remove-participant')[0];
  assert(button.includes('data-participant-id="member-&quot; onclick=&quot;attack()"'));
  assert(button.includes('&lt;img src=x onerror=attack()&gt;'));
  assert(!html.includes('<img src=x')); assert(!button.includes(' onclick="'));
});

test('wishlist navigation includes an active child beyond the first catalog page using the authorized group roster', () => {
  const catalog = Array.from({ length: 50 }, (_, index) => ({ id: `catalog-child-${index}`, name: `Fora deste grupo ${index}`, active: false }));
  const wishlist = { owner: creator, items: [], originals: {}, deletedIds: [], dependentId: 'child-outside-page' };
  const html = renderWishlists('wishlist', state({
    ownDependents: catalog, ownDependentsNextCursor: 'page-two', wishlist,
    participants: [
      ...roster,
      { id: 'later-membership', dependentId: 'child-outside-page', guardianId: creator.id, name: 'Dependente da segunda página', status: 'accepted' },
      { id: 'other-membership', dependentId: 'another-guardians-child', guardianId: 'other-guardian', name: 'Outra família', status: 'accepted' },
      { id: 'inactive-membership', dependentId: 'inactive-child', guardianId: creator.id, name: 'Participação pendente', status: 'sent' },
    ],
  }));
  const navigation = html.match(/<nav class="wl-person-switch"[\s\S]*?<\/nav>/)?.[0];
  assert(navigation, 'A dependent outside the loaded catalog still has wishlist navigation');
  assert(navigation.includes('Dependente da segunda página'));
  assert.match(navigation, /<a class="is-active"[^>]+dependentId=child-outside-page[^>]+aria-current="page"/);
  assert(navigation.includes('dependentId=child-one'), 'Previously loaded roster children remain available');
  assert(!navigation.includes('another-guardians-child')); assert(!navigation.includes('inactive-child'));
  assert(!navigation.includes('catalog-child-'));
});

test('wishlist navigation never revives stale catalog participation when the current roster is empty or belongs to another session', () => {
  const wishlist = { owner: creator, items: [], originals: {}, deletedIds: [], dependentId: null };
  for (const extra of [{ participants: [] }, { user: { id: 'other-user' } }, { user: null }]) {
    const html = renderWishlists('wishlist', state({ wishlist, ownDependents: [child], ...extra }));
    assert(!html.includes('class="wl-person-switch"'));
    assert(!html.includes('dependentId=child-one'));
  }
});
