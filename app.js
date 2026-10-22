// Configure somente URLs oficiais HTTPS. Não coloque segredos neste arquivo público.
const config = {
  subscriptionUrl: '',
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
const messages = {
  subscribe: ['Sua próxima fase começa aqui.', 'A contratação ainda não está disponível. Em breve, você poderá consultar valores, recursos incluídos e condições da assinatura do OmniPDV por aqui.'],
};
document.querySelectorAll('[data-action]').forEach(button => {
  button.addEventListener('click', () => {
    const action = button.dataset.action;
    const destination = config.subscriptionUrl;
    if (destination) {
      try {
        const url = new URL(destination);
        if (url.protocol === 'https:') {
          window.location.assign(url.href);
          return;
        }
      } catch { /* Uma configuração incompleta mantém o aviso acessível. */ }
    }
    const [title, description] = messages[action];
    document.querySelector('#dialog-title').textContent = title;
    document.querySelector('#dialog-description').textContent = description;
    dialog.showModal();
  });
});
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
if (config.subscriptionUrl) document.querySelector('#subscription-status').textContent = 'Consulte as condições de contratação no canal oficial.';
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
