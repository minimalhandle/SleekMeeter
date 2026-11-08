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
    camera: ['Camera', '<rect x="3" y="6" width="12" height="12" rx="2"/><path d="m15 10 6-3v10l-6-3"/>'],
    film: ['Film', '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 4v16M16 4v16M3 9h5m-5 6h5m8-6h5m-5 6h5"/>'],
    keyboard: ['Keyboard', '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.1m4 0h.1m4 0h.1m4 0h.1M8 14h8"/>'],
    soundboard: ['Soundboard', '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 8h2v2H8zm6 0h2v2h-2zm-6 6h2v2H8zm6 0h2v2h-2z"/>'],
    guitar: ['Guitar', '<path d="m13.5 12 6-7 1.5 1.5-7 6M14 11c2 3 .5 5.5-2.3 6-.7.1-.4 1.1-1.5 2.1a3.9 3.9 0 0 1-5.5-5.5c1.1-1.1 2-.8 2.2-1.6.5-2.6 3-4.1 6-2.1"/><circle cx="10" cy="14" r="1"/>'],
    bell: ['Alerts', '<path d="M5 17h14l-2-3v-3a5 5 0 0 0-10 0v3zm5 3a2.5 2.5 0 0 0 4 0M12 4V3"/>'],
    people: ['Guests', '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m2 3a4.5 4.5 0 0 1 3 4v2"/>'],
    sliders: ['Effects', '<path d="M4 7h5m4 0h7M4 17h9m4 0h3"/><circle cx="11" cy="7" r="2"/><circle cx="15" cy="17" r="2"/>'],
  };
  const COLORS = {
    slate: "Slate", amber: "Amber", coral: "Coral", rose: "Rose",
    violet: "Violet", blue: "Blue", cyan: "Cyan", green: "Green",
    lemon: "Lemon", lime: "Lime", mint: "Mint", teal: "Teal",
    indigo: "Indigo", magenta: "Magenta", ruby: "Ruby", copper: "Copper",
  };
  function svg(name, size) {
    const def = ICONS[name] || ICONS.wave;
    return `<svg viewBox="0 0 24 24" width="${size || 18}" height="${size || 18}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${def[1]}</svg>`;
  }
  window.SleekIcons = { ICONS, COLORS, svg };
})();
