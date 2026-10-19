const $ = (id) => document.getElementById(id);
const toggle = $('toggle'), providerSel = $('provider'), keyInput = $('key'), modelInput = $('model'), status = $('status');

const KEY_HINT = { claude: 'sk-ant-...', openai: 'sk-...', gemini: 'AIza...', openrouter: 'sk-or-...' };
const DEFAULT_MODEL = { claude: 'claude-opus-5-5' };

function say(text, isError = false) {
  status.textContent = text;
  status.classList.toggle('error', isError);
}

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ? new URL(tab.url) : null;
  const host = url && /^https?:$/.test(url.protocol) ? url.hostname : null;
  const { sites = {}, provider = 'claude' } = await chrome.storage.local.get(['sites', 'provider']);

  const { readers = {} } = await chrome.storage.local.get('readers');
  if (!host) {
    toggle.disabled = $('pick').disabled = $('auto').disabled = true;
    say('Open a comic page to turn translation on.');
  } else {
    $('host').textContent = host;
    toggle.checked = !!sites[host];
    $('area').textContent = readers[host] ? 'picked area' : 'auto-detect';
    $('auto').disabled = !readers[host];
  }
  providerSel.value = provider;
  await showProvider();

  // Let the page highlight areas under the mouse; the click saves it for this site.
  $('pick').addEventListener('click', async () => {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'pick' });
      window.close();
    } catch {
      say('Reload the page once, then try again.', true);
    }
  });

  $('auto').addEventListener('click', async () => {
    const { readers = {} } = await chrome.storage.local.get('readers');
    delete readers[host];
    await chrome.storage.local.set({ readers });
    $('area').textContent = 'auto-detect';
    $('auto').disabled = true;
  });

  toggle.addEventListener('change', async () => {
    const { sites = {} } = await chrome.storage.local.get('sites');
    if (toggle.checked) sites[host] = true;
    else delete sites[host];
    await chrome.storage.local.set({ sites });
    say(toggle.checked && !keyInput.value.trim() ? 'Add your API key below to start.' : '');
  });

  providerSel.addEventListener('change', async () => {
    await chrome.storage.local.set({ provider: providerSel.value });
    await showProvider();
  });

  keyInput.addEventListener('change', async () => {
    await saveField('keys', keyInput.value.trim());
    say('Key saved in this browser.');
    loadModels();
  });

  modelInput.addEventListener('change', async () => {
    await saveField('models', modelInput.value.trim());
    say('Model saved.');
  });
})();

async function showProvider() {
  const p = providerSel.value;
  const { keys = {}, models = {} } = await chrome.storage.local.get(['keys', 'models']);
  keyInput.value = keys[p] || '';
  keyInput.placeholder = KEY_HINT[p];
  modelInput.value = models[p] || DEFAULT_MODEL[p] || '';
  modelInput.placeholder = 'Pick from the list';
  $('models').replaceChildren();
  say('');
  if (keyInput.value || p === 'openrouter') loadModels();
}

async function saveField(field, value) {
  const store = (await chrome.storage.local.get(field))[field] || {};
  store[providerSel.value] = value;
  await chrome.storage.local.set({ [field]: store });
}

// Fill the model dropdown from the provider's own model list.
async function loadModels() {
  const provider = providerSel.value;
  const reply = await chrome.runtime.sendMessage({ type: 'models', provider, key: keyInput.value.trim() });
  if (provider !== providerSel.value) return;
  if (reply?.error) return say(reply.error, true);
  $('models').replaceChildren(...reply.map((id) => Object.assign(document.createElement('option'), { value: id })));
  if (!modelInput.value) say(`${reply.length} models found. Pick one that accepts images.`);
}
