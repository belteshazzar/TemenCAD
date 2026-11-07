/**
 * Dropdown menus: one open at a time; outside click or Escape closes.
 * The main (☰) menu has drill-down sub panels (Plate, Parts) that slide in
 * from the right; data-sub="name" buttons open them, .menu-back returns.
 */
const SUB_TITLES = { plate: 'Plate', parts: 'Parts' };

export function initMenus() {
  const menus = [...document.querySelectorAll('.menu')];
  const mainMenu = document.querySelector('#menu-root > .menu-items');
  const panelMain = mainMenu.querySelector('.panel-main');
  const panelSub = mainMenu.querySelector('.panel-sub');
  const subTitle = mainMenu.querySelector('.sub-title');

  const closeMenus = () => menus.forEach((m) => m.classList.remove('open'));

  function fitMenuHeight() {
    const drilled = mainMenu.classList.contains('drilled');
    const cs = getComputedStyle(mainMenu);
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    // The sub panel's header stays fixed; only its content area scrolls.
    const content = drilled ? panelSub.querySelector('.sub-head').offsetHeight + panelSub.querySelector('.sub-scroll').scrollHeight : panelMain.scrollHeight;
    mainMenu.style.height = `${Math.min(content + pad, window.innerHeight * 0.7)}px`;
  }
  function openSub(name) {
    for (const c of panelSub.querySelectorAll('.sub-content')) c.hidden = c.dataset.subContent !== name;
    subTitle.textContent = SUB_TITLES[name] ?? 'Back';
    panelSub.querySelector('.sub-scroll').scrollTop = 0;
    mainMenu.classList.add('drilled');
    fitMenuHeight();
  }
  function closeSub() { mainMenu.classList.remove('drilled'); fitMenuHeight(); }
  /** Re-measure an open sub panel after its content changed. */
  function refit() { if (mainMenu.classList.contains('drilled')) fitMenuHeight(); }

  for (const m of menus) {
    m.querySelector('.menu-button').addEventListener('click', (e) => {
      e.stopPropagation();
      const open = m.classList.contains('open');
      closeMenus();
      if (!open) {
        m.classList.add('open');
        if (m.id === 'menu-root') { mainMenu.style.transition = 'none'; closeSub(); requestAnimationFrame(() => { mainMenu.style.transition = ''; }); }
      }
    });
  }
  document.addEventListener('click', closeMenus);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
  mainMenu.addEventListener('click', (e) => {
    const subBtn = e.target.closest('[data-sub]');
    if (subBtn) { e.stopPropagation(); openSub(subBtn.dataset.sub); return; }
    if (e.target.closest('.menu-back')) { e.stopPropagation(); closeSub(); }
  });

  return { closeMenus, refit };
}
