import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWelcomeEmail } from '../emails/render-welcome.mjs';

const fixture = {
  customerName: 'Ana <Silva> & família', planName: 'OmniPVD', price: 'R$ 79,90',
  billingPeriod: 'mês', purchaseDate: '27/10/2026',
  downloadUrl: 'https://download.example.invalid/installer?token=test-only&expires=123',
  supportEmail: 'suporte@example.invalid',
};
test('e-mail renderiza os dados, escapa HTML e inclui logo inline e versão texto', async () => {
  const result = await buildWelcomeEmail(fixture);
  assert.ok(result.html.includes('Ana &lt;Silva&gt; &amp; família'));
  assert.ok(!result.html.includes('Ana <Silva>'));
  assert.equal((result.html.match(/href="https:\/\/download.example.invalid\/installer\?token=test-only&amp;expires=123"/g)||[]).length, 2);
  assert.ok(!result.html.includes('{{'));
  assert.ok(result.text.includes(fixture.downloadUrl));
  assert.ok(result.html.includes(`cid:${result.attachments[0].contentId}`));
  assert.equal(Buffer.from(result.attachments[0].content, 'base64').subarray(1,4).toString(), 'PNG');
});
test('e-mail não permite acesso ausente, inseguro ou dados inválidos', async () => {
  for (const downloadUrl of ['', '{{downloadUrl}}', 'http://example.invalid/file', 'javascript:alert(1)', 'https://user:pass@example.invalid/file']) {
    await assert.rejects(buildWelcomeEmail({ ...fixture, downloadUrl }));
  }
  await assert.rejects(buildWelcomeEmail({ ...fixture, customerName: '' }));
  await assert.rejects(buildWelcomeEmail({ ...fixture, supportEmail: 'suporte" onclick="alert(1)' }));
});
