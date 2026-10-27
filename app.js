// Configure somente URLs oficiais HTTPS. Não coloque segredos neste arquivo público.
const config = {
  priceLabel: 'R$ 79,90',
  priceDescription: 'Assinatura OmniPDV',
};

const menuButton = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#navigation');
function closeMenu() {
  navigation.classList.remove('open');
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.setAttribute('aria-label', 'Abrir menu');
}
menuButton.addEventListener('click', () => {
  const open = navigation.classList.toggle('open');
  menuButton.setAttribute('aria-expanded', String(open));
  menuButton.setAttribute('aria-label', open ? 'Fechar menu' : 'Abrir menu');
});
navigation.querySelectorAll('a').forEach(link => link.addEventListener('click', closeMenu));
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
document.addEventListener('click', event => {
  if (!navigation.contains(event.target) && !menuButton.contains(event.target)) closeMenu();
});

const dialog = document.querySelector('#action-dialog');
function showCheckoutMessage(title, description) {
  document.querySelector('#dialog-title').textContent = title;
  document.querySelector('#dialog-description').textContent = description;
  dialog.showModal();
}
document.querySelectorAll('[data-action="subscribe"]').forEach(button => {
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch('/api/create-checkout-session', { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Não foi possível abrir o pagamento.');
      const url = new URL(result.url);
      if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com') throw new Error('Endereço de pagamento inválido.');
      window.location.assign(url.href);
    } catch (error) {
      showCheckoutMessage('Não foi possível abrir a assinatura', error instanceof TypeError || error instanceof SyntaxError ? 'Verifique sua conexão e tente novamente. O pagamento pode estar temporariamente indisponível.' : error.message);
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  });
});
const checkoutResult = new URLSearchParams(window.location.search).get('checkout');
if (checkoutResult === 'success') {
  showCheckoutMessage('Você retornou do pagamento', 'A confirmação depende do processamento pela Stripe. O acesso por e-mail será liberado após a confirmação; este retorno não confirma a compra.');
} else if (checkoutResult === 'cancelled') {
  showCheckoutMessage('Você pode tentar novamente', 'O checkout foi fechado. Quando quiser, volte à assinatura para continuar.');
}
document.querySelectorAll('.dialog-close, .dialog-dismiss').forEach(button => button.addEventListener('click', () => dialog.close()));
dialog.addEventListener('click', event => {
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
});
if (config.priceLabel) {
  const price = document.querySelector('#plan-price');
  price.replaceChildren(document.createTextNode(config.priceLabel));
  const description = document.createElement('span');
  description.textContent = config.priceDescription;
  price.append(description);
}

document.querySelector('#year').textContent = String(new Date().getFullYear());

const themeButton = document.querySelector('.theme-toggle');
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeButton.setAttribute('aria-pressed', String(theme === 'dark'));
  themeButton.setAttribute('aria-label', theme === 'dark' ? 'Ativar modo claro' : 'Ativar modo escuro');
  document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#121c19' : '#f6f7f8';
}
applyTheme(document.documentElement.dataset.theme || 'light');
themeButton.addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(theme);
  try { localStorage.setItem('omnipdv-site-theme', theme); } catch { /* O tema funciona mesmo sem armazenamento. */ }
});
