const icons = {
  mixer: '<path d="M5 4v16m7-16v16m7-16v16M2 9h6m1 6h6m1-7h6"/>',
  routing: '<circle cx="5" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="19" cy="19" r="2"/><path d="M5 7v8a4 4 0 0 0 4 4h8M5 11h8a6 6 0 0 0 6-4"/>',
  deck: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 8h2m3 0h2m3 0h1M7 12h2m3 0h2m3 0h1M7 16h10"/>',
  mic: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11v1a7 7 0 0 0 14 0v-1m-7 8v3m-3 0h6"/>',
  game: '<path d="M8 7h8a4 4 0 0 1 3.9 3.2l1.2 5.5a2.3 2.3 0 0 1-3.9 2.1L14 15h-4l-3.2 2.8a2.3 2.3 0 0 1-3.9-2.1l1.2-5.5A4 4 0 0 1 8 7Zm0 3v4m-2-2h4m5-1h.01m3 2h.01"/>',
  chat: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l1.3-3.8A8.5 8.5 0 1 1 21 11.5Z"/><path d="M8.5 12h.01m4 0h.01m4 0h.01"/>',
  music: '<path d="M9 18V6l11-3v12M9 18a3 3 0 1 1-3-3h3m11 0a3 3 0 1 1-3-3h3"/>',
  headphones: '<path d="M3 14v-2a9 9 0 0 1 18 0v2M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Zm18 0h-3a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2Z"/>',
  broadcast: '<circle cx="12" cy="12" r="2"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4m8.4-8.4a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/>',
  speaker: '<path d="M4 9h4l5-4v14l-5-4H4Zm12 0a4 4 0 0 1 0 6m2.5-8a7 7 0 0 1 0 10"/>',
  reset: '<path d="M3 12a9 9 0 1 1 3 6.7M3 5v7h7"/>',
  monitor: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  brb: '<path d="M3 9h14v5a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5V9Zm14 2h2a2.5 2.5 0 0 1 0 5h-2M8 3v3m5-3v3"/>',
  record: '<circle cx="12" cy="12" r="7" fill="currentColor" stroke="none"/>',
  duck: '<path d="M4 8v12m5-9v9m5-6v6m5-3v3M9 5h11m-3-3 3 3-3 3"/>',
  scene: '<rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 10h18m-13-5 3 5m3-5 3 5m-7 3 5 2.5-5 2.5Z"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
};

const channels = [
  { id: 'mic', label: 'Mic', detail: 'Shure MV7', icon: 'mic', color: '#f7bb69', gain: -3, signal: .68, routes: ['B2'] },
  { id: 'game', label: 'Game', detail: 'Virtual input', icon: 'game', color: '#a9a0fc', gain: -8, signal: .81, routes: ['A1', 'B2'] },
  { id: 'chat', label: 'Discord', detail: 'Virtual input', icon: 'chat', color: '#8baef5', gain: -6, signal: .63, routes: ['A1'] },
  { id: 'music', label: 'Music', detail: 'Virtual input', icon: 'music', color: '#86dda8', gain: -15, signal: .79, routes: ['A1'] },
  { id: 'A1', label: 'Headphones', detail: 'A1 · Hardware out', icon: 'headphones', color: '#f7bb69', gain: 0 },
  { id: 'B2', label: 'Stream mix', detail: 'B2 · Virtual out', icon: 'broadcast', color: '#75d1ee', gain: -4 },
];

const applications = [
  { id: 'game-app', label: 'Game audio', detail: 'Game session', icon: 'game', channel: 'game', color: '#a9a0fc' },
  { id: 'discord-app', label: 'Discord', detail: 'Voice chat', icon: 'chat', channel: 'chat', color: '#8baef5' },
  { id: 'spotify-app', label: 'Spotify', detail: 'Music session', icon: 'music', channel: 'music', color: '#86dda8' },
];

const appInputs = channels.slice(1, 4);

const modes = [
  { id: 'mixer', label: 'Mixer', icon: 'mixer', hint: 'Drag a fader, mute a channel, or click A1 and B2 to change where it goes.' },
  { id: 'routing', label: 'App routing', icon: 'routing', hint: 'Assign an app to a different virtual input. Changes carry over to the mixer.' },
  { id: 'deck', label: 'Stream Deck', icon: 'deck', hint: 'Try the keys and change a dial level. The controls stay in sync with the mixer.' },
];

function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
}

function decibels(value) {
  const number = Number(value);
  const sign = number > 0 ? '+' : number < 0 ? '−' : '';
  return `${sign}${Math.abs(number).toFixed(1)}`;
}

function strip(channel) {
  const { id, label, detail, color } = channel;
  return `<article class="pv-strip" data-pv-strip="${id}" style="--pv-channel:${color}">
    <div class="pv-strip-head">
      <span class="pv-chip">${icon(channel.icon)}</span>
      <div><h4>${label}</h4><span>${detail}</span></div>
    </div>
    <div class="pv-sends">${channel.routes ? ['A1', 'B2'].map((bus) =>
      `<button type="button" data-pv-route="${id}" data-pv-bus="${bus}" aria-label="Send ${label} to ${bus === 'A1' ? 'Headphones' : 'Stream mix'}" aria-pressed="false">${bus}</button>`).join('') :
      `<span class="pv-bus-tag">${id}</span>`}</div>
    <div class="pv-fader">
      <div class="pv-meter" aria-hidden="true"><i></i><i></i></div>
      <div class="pv-scale" aria-hidden="true"><span>+12</span><span>0</span><span>−12</span><span>−24</span><span>−48</span></div>
      <input class="pv-gain" data-pv-gain="${id}" type="range" min="-48" max="12" step="0.5" value="${channel.gain}" aria-label="${label} gain" title="Double-click to reset to 0 dB">
    </div>
    <div class="pv-readout"><output data-pv-value="${id}">${decibels(channel.gain)}</output><span> dB</span></div>
    <button class="pv-mute" data-pv-mute="${id}" type="button" aria-label="Mute ${label}" aria-pressed="false">${icon('speaker')}<span>Mute</span></button>
  </article>`;
}

function mixerPanel() {
  return `<div class="pv-mixer" tabindex="0" aria-label="Mixer channel strips">
    <div class="pv-mix-group"><h3>Inputs <span>04</span></h3><div class="pv-strips">${channels.slice(0, 4).map(strip).join('')}</div></div>
    <div class="pv-mix-group pv-outputs"><h3>Outputs <span>02</span></h3><div class="pv-strips">${channels.slice(4).map(strip).join('')}</div></div>
  </div>`;
}

function routingPanel() {
  return `<div class="pv-routing">
    <div class="pv-mode-intro"><h3>App audio flow</h3><p>Give each app its own place in your mix.</p></div>
    <div class="pv-flow">
      <div class="pv-flow-list"><h4>Applications</h4>${applications.map((app) => `<label class="pv-flow-node" style="--pv-channel:${app.color}">
        <span class="pv-chip">${icon(app.icon)}</span><span class="pv-node-name">${app.label}<small>${app.detail}</small></span>
        <select data-pv-app="${app.id}" aria-label="Route ${app.label} to">${appInputs.map((channel) => `<option value="${channel.id}"${channel.id === app.channel ? ' selected' : ''}>${channel.label}</option>`).join('')}</select>
      </label>`).join('')}</div>
      <svg class="pv-flow-lines" viewBox="0 0 140 168" preserveAspectRatio="none" aria-hidden="true">
        ${applications.map((app) => `<path data-pv-flow="${app.id}" fill="none" stroke="${app.color}" stroke-width="2" vector-effect="non-scaling-stroke"/>`).join('')}
      </svg>
      <div class="pv-flow-list"><h4>Mixer inputs</h4>${appInputs.map((channel) => `<div class="pv-flow-node pv-flow-target" style="--pv-channel:${channel.color}">
        <span class="pv-chip">${icon(channel.icon)}</span><span class="pv-node-name">${channel.label}<small data-pv-app-count="${channel.id}"></small></span>
      </div>`).join('')}</div>
    </div>
    <p class="pv-routing-note" role="status">App assignments follow the virtual input you choose.</p>
  </div>`;
}

const deckKeys = [
  { id: 'mic', label: 'Mic', icon: 'mic', color: '#88d8af' },
  { id: 'route', label: 'Mic to stream', icon: 'broadcast', color: '#89b9ff' },
  { id: 'game', label: 'Game level', icon: 'game', color: '#89b9ff', action: 'Turn game down 3 dB' },
  { id: 'scene', label: 'Scene', icon: 'scene', color: '#f2b976' },
  { id: 'brb', label: 'Be right back', icon: 'brb', color: '#f2b976' },
  { id: 'record', label: 'Recorder', icon: 'record', color: '#ff858b' },
  { id: 'duck', label: 'Talk over', icon: 'duck', color: '#88d8af' },
  { id: 'music', label: 'Music', icon: 'music', color: '#88d8af' },
];

function deckPanel() {
  return `<div class="pv-deck">
    <div class="pv-mode-intro"><h3>Sleekmeeter Studio</h3><p>Live keys and channel levels on Stream Deck +.</p></div>
    <div class="pv-deck-body">
      <div class="pv-deck-keys">${deckKeys.map((key) => `<button class="pv-deck-key" type="button" data-pv-key="${key.id}" aria-label="${key.action || (key.id === 'scene' ? 'Switch scene' : `Toggle ${key.label.toLowerCase()}`)}" style="--pv-key:${key.color}">
        <span>${key.label}</span>${icon(key.icon)}<strong></strong><i></i>
      </button>`).join('')}</div>
      <div class="pv-deck-dials">${channels.slice(0, 4).map((channel) => `<div class="pv-deck-dial" style="--pv-channel:${channel.color}">
        <div><span>${channel.label}</span><strong><output data-pv-value="${channel.id}"></output> dB</strong></div>
        <input data-pv-gain="${channel.id}" type="range" min="-48" max="12" step="0.5" value="${channel.gain}" aria-label="${channel.label} dial level">
      </div>`).join('')}</div>
    </div>
  </div>`;
}

function createState() {
  return {
    gain: Object.fromEntries(channels.map(({ id, gain }) => [id, gain])),
    mute: Object.fromEntries(channels.map(({ id }) => [id, false])),
    routes: Object.fromEntries(channels.filter(({ routes }) => routes).map(({ id, routes }) => [id, new Set(routes)])),
    assignments: Object.fromEntries(applications.map(({ id, channel }) => [id, channel])),
    scene: 'Gaming',
    brb: false,
    record: false,
    duck: false,
  };
}

function muted(id, state) {
  return state.mute[id] || (id === 'mic' && state.brb);
}

function inputSignal(channel, state) {
  if (muted(channel.id, state)) return 0;
  const appSources = applications.filter(({ id }) => state.assignments[id] === channel.id);
  const source = channel.id === 'mic' ? channel.signal : Math.max(0, ...appSources.map(({ channel }) => channels.find(({ id }) => id === channel).signal));
  const reduction = channel.id === 'game' && (state.brb || (state.duck && !muted('mic', state))) ? .2 : 0;
  return Math.max(0, source ? source + state.gain[channel.id] / 65 - reduction : 0);
}

function outputSignal(id, state, signals) {
  const connected = channels.filter((source) => state.routes[source.id]?.has(id));
  const source = Math.max(0, ...connected.map((channel) => signals[channel.id]));
  return source ? Math.max(0, source + state.gain[id] / 65) : 0;
}

export function initPreview(root) {
  if (!root) return;

  root.innerHTML = `<div class="pv-toolbar">
    <div class="pv-tabs" role="tablist" aria-label="Interactive previews">${modes.map((mode, index) => `<button class="pv-tab" id="pv-tab-${mode.id}" type="button" role="tab" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}" aria-controls="pv-panel-${mode.id}" data-pv-mode="${mode.id}">${icon(mode.icon)}<span>${mode.label}</span></button>`).join('')}</div>
    <button class="pv-reset" type="button" data-pv-reset aria-label="Reset preview">${icon('reset')}<span>Reset demo</span></button>
  </div>
  <div class="pv-window">
    <div class="pv-titlebar"><div class="pv-title"><span class="pv-mark" aria-hidden="true"><i></i><i></i><i></i></span>Sleekmeeter</div><div class="pv-connection"><i></i><span>Voicemeeter</span> preview</div><div class="pv-window-controls" aria-hidden="true"><span>−</span><span>□</span><span>×</span></div></div>
    <div class="pv-panel" id="pv-panel-mixer" role="tabpanel" aria-labelledby="pv-tab-mixer">${mixerPanel()}</div>
    <div class="pv-panel" id="pv-panel-routing" role="tabpanel" aria-labelledby="pv-tab-routing" hidden>${routingPanel()}</div>
    <div class="pv-panel" id="pv-panel-deck" role="tabpanel" aria-labelledby="pv-tab-deck" hidden>${deckPanel()}</div>
    <div class="pv-statusbar"><span><i></i> Simulated audio</span><span data-pv-scene>Scene · Gaming</span></div>
  </div>
  <div class="pv-caption"><span data-pv-hint>${modes[0].hint}</span><span class="pv-scroll-hint">Scroll for outputs ${icon('chevron')}</span></div>`;

  const get = (selector) => root.querySelector(selector);
  const all = (selector) => root.querySelectorAll(selector);
  const tabs = [...all('[data-pv-mode]')];
  let state = createState();

  function switchMode(id, focus = false) {
    for (const tab of tabs) {
      const selected = tab.dataset.pvMode === id;
      tab.setAttribute('aria-selected', selected);
      tab.tabIndex = selected ? 0 : -1;
      get(`#${tab.getAttribute('aria-controls')}`).hidden = !selected;
      if (selected && focus) tab.focus();
    }
    root.dataset.pvMode = id;
    get('[data-pv-hint]').textContent = modes.find((mode) => mode.id === id).hint;
  }

  function syncMixer() {
    const signals = Object.fromEntries(channels.filter(({ routes }) => routes).map((channel) => [channel.id, inputSignal(channel, state)]));
    for (const channel of channels) {
      const { id } = channel;
      const gain = state.gain[id];
      const isMuted = muted(id, state);
      const amount = isMuted ? 0 : channel.routes ? signals[id] : outputSignal(id, state, signals);
      const strip = get(`[data-pv-strip="${id}"]`);
      strip.classList.toggle('pv-muted', isMuted);
      strip.classList.toggle('pv-has-signal', amount > 0);
      strip.style.setProperty('--pv-meter-level', `${Math.min(100, amount * 100)}%`);
      for (const input of all(`[data-pv-gain="${id}"]`)) {
        input.value = gain;
        input.setAttribute('aria-valuetext', `${decibels(gain)} dB`);
      }
      for (const value of all(`[data-pv-value="${id}"]`)) value.textContent = decibels(gain);
      const button = get(`[data-pv-mute="${id}"]`);
      button.setAttribute('aria-pressed', isMuted);
      button.querySelector('span').textContent = isMuted ? 'Muted' : 'Mute';
    }
    for (const button of all('[data-pv-route]')) {
      button.setAttribute('aria-pressed', state.routes[button.dataset.pvRoute].has(button.dataset.pvBus));
    }
  }

  function syncFlow() {
    for (const [index, app] of applications.entries()) {
      const assignment = state.assignments[app.id];
      const from = 24 + index * 56;
      const to = 24 + appInputs.findIndex(({ id }) => id === assignment) * 56;
      get(`[data-pv-app="${app.id}"]`).value = assignment;
      get(`[data-pv-flow="${app.id}"]`).setAttribute('d', `M0 ${from} C66 ${from}, 74 ${to}, 140 ${to}`);
    }
    for (const { id } of appInputs) {
      const count = Object.values(state.assignments).filter((assignment) => assignment === id).length;
      get(`[data-pv-app-count="${id}"]`).textContent = `${count} ${count === 1 ? 'app' : 'apps'}`;
    }
  }

  function syncDeck() {
    const micMuted = muted('mic', state);
    const routed = state.routes.mic.has('B2');
    const keys = {
      mic: [micMuted, micMuted ? 'Muted' : 'Live', true],
      route: [routed, routed ? 'B2 on' : 'B2 off', routed],
      game: [null, `${decibels(state.gain.game)} dB`, true],
      scene: [null, state.scene, true],
      brb: [state.brb, state.brb ? 'Away' : 'Ready', state.brb],
      record: [state.record, state.record ? 'Recording' : 'Stopped', state.record],
      duck: [state.duck, state.duck ? 'Ducking on' : 'Ducking off', state.duck],
      music: [state.mute.music, state.mute.music ? 'Muted' : 'Live', true],
    };
    for (const [id, [pressed, label, lit]] of Object.entries(keys)) {
      const key = get(`[data-pv-key="${id}"]`);
      if (pressed !== null) key.setAttribute('aria-pressed', pressed);
      key.classList.toggle('pv-lit', lit);
      key.classList.toggle('pv-key-muted', (id === 'mic' && micMuted) || (id === 'music' && state.mute.music));
      key.querySelector('strong').textContent = label;
    }
    get('[data-pv-scene]').textContent = `Scene · ${state.scene}`;
  }

  function sync() {
    syncMixer();
    syncFlow();
    syncDeck();
  }

  function toggleRoute(id, bus) {
    const routes = state.routes[id];
    if (routes.has(bus)) routes.delete(bus);
    else routes.add(bus);
  }

  function toggleMic() {
    if (state.brb) {
      state.brb = false;
      state.mute.mic = false;
    } else {
      state.mute.mic = !state.mute.mic;
    }
  }

  function activateKey(key) {
    switch (key) {
      case 'mic': toggleMic(); break;
      case 'route': toggleRoute('mic', 'B2'); break;
      case 'game': state.gain.game = Math.max(-48, state.gain.game - 3); break;
      case 'scene': {
        const gaming = state.scene !== 'Gaming';
        state.scene = gaming ? 'Gaming' : 'Chatting';
        state.gain.game = gaming ? -8 : -20;
        state.gain.chat = gaming ? -6 : -3;
        break;
      }
      case 'brb': state.brb = !state.brb; break;
      case 'record': state.record = !state.record; break;
      case 'duck': state.duck = !state.duck; break;
      case 'music': state.mute.music = !state.mute.music; break;
    }
  }

  root.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const { pvMode, pvMute, pvRoute, pvBus, pvKey } = button.dataset;
    if (pvMode) return switchMode(pvMode);
    if (button.hasAttribute('data-pv-reset')) {
      state = createState();
      get('.pv-routing-note').textContent = 'App assignments follow the virtual input you choose.';
    } else if (pvMute === 'mic') toggleMic();
    else if (pvMute) state.mute[pvMute] = !state.mute[pvMute];
    else if (pvRoute) toggleRoute(pvRoute, pvBus);
    else if (pvKey) activateKey(pvKey);
    else return;
    sync();
  });

  root.addEventListener('input', (event) => {
    const { pvGain } = event.target.dataset;
    if (!pvGain) return;
    state.gain[pvGain] = Number(event.target.value);
    syncMixer();
    syncDeck();
  });

  root.addEventListener('change', (event) => {
    const { pvApp } = event.target.dataset;
    if (!pvApp) return;
    state.assignments[pvApp] = event.target.value;
    const app = applications.find(({ id }) => id === pvApp);
    const input = channels.find(({ id }) => id === event.target.value);
    get('.pv-routing-note').textContent = `${app.label} now plays through ${input.label}.`;
    sync();
  });

  root.addEventListener('dblclick', (event) => {
    const { pvGain } = event.target.dataset;
    if (!pvGain) return;
    state.gain[pvGain] = 0;
    syncMixer();
    syncDeck();
  });

  root.addEventListener('keydown', (event) => {
    const index = tabs.indexOf(event.target);
    if (index < 0) return;
    let next;
    switch (event.key) {
      case 'ArrowRight': next = (index + 1) % tabs.length; break;
      case 'ArrowLeft': next = (index + tabs.length - 1) % tabs.length; break;
      case 'Home': next = 0; break;
      case 'End': next = tabs.length - 1; break;
      default: return;
    }
    event.preventDefault();
    switchMode(tabs[next].dataset.pvMode, true);
  });

  switchMode('mixer');
  sync();
}
