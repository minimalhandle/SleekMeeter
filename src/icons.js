/* Channel icons and colors, shared by the mixer and the volume overlay. 24×24, stroked. */
(function () {
  "use strict";
  const ICONS = {
    mic: ['Microphone', '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6"/>'],
    wave: ['Instrument', '<path d="M3 12h2.5l2-5.5 3 11 3-8.5 2 5 1.5-2H21"/>'],
    headphones: ['Headphones', '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4.5" height="7" rx="1.5"/><rect x="16.5" y="14" width="4.5" height="7" rx="1.5"/>'],
    speaker: ['Speakers', '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4.5 4.5 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>'],
    desktop: ['Desktop audio', '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M9 20h6M12 16v4"/>'],
    music: ['Music', '<path d="M9 17.5V5.5l10.5-2v12"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="17" cy="15.5" r="2.5"/>'],
    chat: ['Voice chat', '<path d="M4 5h16v11H10l-4.5 3.5V16H4z"/><path d="M8.5 10.5h7"/>'],
    game: ['Games', '<path d="M7.5 8h9a4.5 4.5 0 0 1 4.5 4.5v.8a3.2 3.2 0 0 1-5.8 1.9L14.5 14h-5l-.7 1.2A3.2 3.2 0 0 1 3 13.3v-.8A4.5 4.5 0 0 1 7.5 8z"/><path d="M8 10.5v3M6.5 12h3M15.5 11h.01M17.5 13h.01"/>'],
    browser: ['Browser', '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.3 2.3 3.3 5.2 3.3 8.5s-1 6.2-3.3 8.5M12 3.5C9.7 5.8 8.7 8.7 8.7 12s1 6.2 3.3 8.5"/>'],
    stream: ['Stream', '<circle cx="12" cy="12" r="2"/><path d="M8.3 8.3a5.2 5.2 0 0 0 0 7.4M15.7 8.3a5.2 5.2 0 0 1 0 7.4M5.5 5.5a9.2 9.2 0 0 0 0 13M18.5 5.5a9.2 9.2 0 0 1 0 13"/>'],
    phone: ['Phone', '<path d="M6.5 3.5h3l1.8 4.5-2.3 1.4a10.5 10.5 0 0 0 5.6 5.6l1.4-2.3 4.5 1.8v3a2 2 0 0 1-2 2A15.5 15.5 0 0 1 4.5 5.5a2 2 0 0 1 2-2z"/>'],
    record: ['Recorder', '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none"/>'],
  };
  const COLORS = {
    slate: "Slate", amber: "Amber", coral: "Coral", rose: "Rose",
    violet: "Violet", blue: "Blue", cyan: "Cyan", green: "Green",
  };
  function svg(name, size) {
    const def = ICONS[name] || ICONS.wave;
    return `<svg viewBox="0 0 24 24" width="${size || 18}" height="${size || 18}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${def[1]}</svg>`;
  }
  window.SleekIcons = { ICONS, COLORS, svg };
})();
