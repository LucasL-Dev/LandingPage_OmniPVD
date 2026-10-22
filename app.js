// Configure somente URLs oficiais HTTPS. Não coloque segredos neste arquivo público.
const config = {
  downloadUrl: 'https://github.com/LucasL-Dev/PDV_Sistem/actions/workflows/windows.yml',
  subscriptionUrl: '',
  priceLabel: '',
  priceDescription: '',
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
  download: ['Download em preparação', 'O instalador oficial ainda não foi disponibilizado nesta página. Volte em breve para conferir a disponibilidade.'],
  subscribe: ['Sua próxima fase começa aqui.', 'A contratação ainda não está disponível. Em breve, você poderá consultar valores, recursos incluídos e condições da assinatura do OmniPDV por aqui.'],
};
document.querySelectorAll('[data-action]').forEach(button => {
  button.addEventListener('click', () => {
    const action = button.dataset.action;
    const destination = action === 'download' ? config.downloadUrl : config.subscriptionUrl;
    if (destination) {
      try {
        const url = new URL(destination);
        if (url.protocol === 'https:') { window.location.assign(url.href); return; }
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
