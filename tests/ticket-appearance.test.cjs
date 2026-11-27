const test=require('node:test'),assert=require('node:assert/strict');
const {ACCENT,enabled,divider,shorten,safeText,statusLabel,counted}=require('../ticket-management/appearance');
test('ticket appearance uses one accent, compact separators and human labels',()=>{
  assert.equal(ACCENT,0);
  assert.equal(enabled(true),'Ativado');assert.equal(enabled(false),'Desativado');
  assert.equal(divider().toJSON().spacing,1);
});
test('long ticket labels are truncated without changing short labels',()=>{
  assert.equal(shorten('Suporte',20),'Suporte');assert.equal(shorten('a'.repeat(90),60).length,60);assert.ok(shorten('a'.repeat(90),60).endsWith('…'));
});
test('dynamic labels neutralize mentions, markdown and multiline injection without invisible spacing',()=>{
  const value=safeText('**Tipo**\n# Falso\t@everyone <@123>');
  assert.ok(value.includes('\\*\\*Tipo\\*\\*'));assert.ok(value.includes('＠everyone'));
  assert.doesNotMatch(value,/[\n\t\u200b\u200c\u200d]|<@|@everyone/);
});
test('status and count labels are presentation-only and agree with responsibility',()=>{
  assert.equal(statusLabel('open'),'Aguardando');assert.equal(statusLabel('open',true),'Em atendimento');
  assert.equal(statusLabel('closed'),'Fechado');assert.equal(statusLabel('archived'),'Fechado');
  assert.equal(counted(1,'pendente','pendentes'),'1 pendente');assert.equal(counted(2,'pendente','pendentes'),'2 pendentes');
});
