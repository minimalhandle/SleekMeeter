import { featureGroups, themes } from './content.js';
import { initPreview } from './preview.js';

const themeOptions = document.querySelector('#theme-options');
const themeImage = document.querySelector('#theme-image');
const themeCaption = document.querySelector('#theme-caption');
const themeIndex = document.querySelector('#theme-index');

themes.forEach(([id, name, color], index) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'theme-option';
  button.setAttribute('aria-pressed', String(index === 0));

  const swatch = document.createElement('span');
  swatch.className = 'theme-swatch';
  swatch.style.setProperty('--swatch', color);
  swatch.setAttribute('aria-hidden', 'true');
  button.append(swatch, name);

  button.addEventListener('click', () => {
    themeOptions.querySelector('[aria-pressed="true"]').setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-pressed', 'true');
    themeImage.src = `./assets/themes/${id}.webp`;
    themeImage.alt = `Sleekmeeter in the ${name} theme`;
    themeCaption.textContent = name;
    themeIndex.textContent = `${String(index + 1).padStart(2, '0')} / ${themes.length}`;
  });

  themeOptions.append(button);
});

const filters = document.querySelector('#feature-filters');
const search = document.querySelector('#feature-search');
const list = document.querySelector('#feature-list');
const count = document.querySelector('#feature-count');
let activeGroup = 'all';

const filterLabels = [
  ['all', 'All'], ['mixer', 'Mixer'], ['routing', 'Apps & devices'], ['sound', 'Sound'],
  ['stream', 'Streaming'], ['controls', 'Remote'], ['workspace', 'Appearance'], ['setup', 'Setup'],
];

for (const [id, label] of filterLabels) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.dataset.group = id;
  button.setAttribute('aria-pressed', String(id === activeGroup));
  button.addEventListener('click', () => selectGroup(id));
  filters.append(button);
}

function selectGroup(id) {
  activeGroup = id;
  for (const button of filters.children) {
    button.setAttribute('aria-pressed', String(button.dataset.group === activeGroup));
  }
  renderFeatures();
}

function createFeatureGroup(group, matches, open) {
  const details = document.createElement('details');
  details.className = 'catalog-group';
  details.open = open;
  const summary = document.createElement('summary');
  const groupCount = document.createElement('span');
  groupCount.className = 'catalog-group-count';
  groupCount.textContent = matches.length;
  summary.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-plus"/></svg>';
  summary.prepend(group.name, groupCount);

  const items = document.createElement('ul');
  items.className = 'catalog-items';
  for (const [title, description, requirement] of matches) {
    const li = document.createElement('li');
    const heading = document.createElement('h3');
    const body = document.createElement('p');
    heading.textContent = title;
    body.textContent = description;
    li.append(heading, body);
    if (requirement) {
      const badge = document.createElement('span');
      badge.className = 'feature-badge';
      badge.textContent = requirement;
      li.append(badge);
    }
    items.append(li);
  }
  details.append(summary, items);
  return details;
}

function renderFeatures() {
  const terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const groups = featureGroups.filter(group => activeGroup === 'all' || group.id === activeGroup);
  const results = [];
  let total = 0;

  for (const group of groups) {
    const matches = group.items.filter(item => {
      const text = [group.name, ...item].join(' ').toLowerCase();
      return terms.every(term => text.includes(term));
    });
    if (matches.length === 0) continue;
    results.push(createFeatureGroup(group, matches, results.length === 0 || terms.length > 0));
    total += matches.length;
  }

  count.textContent = `${total} ${total === 1 ? 'feature' : 'features'}`;
  if (total === 0) {
    const empty = document.createElement('p');
    empty.className = 'catalog-empty';
    empty.textContent = 'No features match your search. Try a different term or choose another category.';
    results.push(empty);
  }
  list.replaceChildren(...results);
}

search.addEventListener('input', renderFeatures);
for (const link of document.querySelectorAll('[data-feature-category]')) {
  link.addEventListener('click', () => {
    search.value = '';
    selectGroup(link.dataset.featureCategory);
  });
}
renderFeatures();

initPreview(document.querySelector('#app-preview'));
