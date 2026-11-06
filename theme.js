// Apply the saved appearance before the stylesheet paints the page.
(() => {
  const storageKey = 'along-the-way:appearance';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try {
    const saved = localStorage.getItem(storageKey);
    if (['light', 'dark', 'system'].includes(saved)) preference = saved;
  } catch (_) { /* Appearance still works when storage is unavailable. */ }

  function apply() {
    const dark = preference === 'dark' || (preference === 'system' && system.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]').content = dark ? '#111e19' : '#f5f4ee';
  }
  apply();
  system.addEventListener('change', () => { if (preference === 'system') apply(); });
  document.addEventListener('DOMContentLoaded', () => {
    const control = document.getElementById('appearance');
    control.value = preference;
    control.addEventListener('change', () => {
      preference = control.value;
      try { localStorage.setItem(storageKey, preference); } catch (_) {}
      apply();
    });
  });
})();
