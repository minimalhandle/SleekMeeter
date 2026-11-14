(() => {
  const storageKey = 'sleekmeeter-site-theme';
  const systemTheme = matchMedia('(prefers-color-scheme: dark)');
  const themeColor = document.querySelector('meta[name="theme-color"]');
  const root = document.documentElement;
  let toggle;
  let preference = readPreference();

  function readPreference() {
    try {
      const saved = localStorage.getItem(storageKey);
      return saved === 'light' || saved === 'dark' ? saved : null;
    } catch {
      return null;
    }
  }

  function applyTheme() {
    const theme = preference ?? (systemTheme.matches ? 'dark' : 'light');
    const dark = theme === 'dark';
    root.dataset.theme = theme;
    themeColor.content = dark ? '#181916' : '#f5f3ed';
    if (toggle) {
      toggle.setAttribute('aria-pressed', String(dark));
      toggle.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    }
  }

  applyTheme();
  systemTheme.addEventListener('change', applyTheme);
  window.addEventListener('storage', ({ key }) => {
    if (key === storageKey || key === null) {
      preference = readPreference();
      applyTheme();
    }
  });

  document.addEventListener('DOMContentLoaded', () => {
    toggle = document.querySelector('#site-theme-toggle');
    applyTheme();
    toggle.hidden = false;
    toggle.addEventListener('click', () => {
      preference = root.dataset.theme === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(storageKey, preference);
      } catch {
        // The choice still applies for this page if storage is unavailable.
      }
      applyTheme();
    });
  });
})();
