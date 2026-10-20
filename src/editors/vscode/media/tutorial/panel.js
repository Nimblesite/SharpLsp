// The tutorial panel's webview script. Implements [TUTORIAL-PANEL]: it renders
// each PanelView the extension posts, in place, and swaps the film only when
// the current step's film changes, so a tick never restarts the playing film.
// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  /** @type {string} */
  let playing = '';

  /** @param {string} tag @param {string} text @param {string} [className] */
  function element(tag, text, className) {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  /** @param {HTMLElement} root @param {Node[]} children */
  function replaceChildren(root, children) {
    root.replaceChildren(...children);
  }

  function renderLanguages(view) {
    const buttons = view.languages.map((language) => {
      const button = element('button', `${language.label} ${language.done}/${language.total}`);
      button.dataset.language = language.kind;
      button.setAttribute('aria-pressed', String(language.selected));
      return button;
    });
    replaceChildren(document.getElementById('languages'), buttons);
  }

  function renderSteps(view) {
    const items = view.steps.map((step) => {
      const item = element('li', `${step.done ? '✓' : '○'} ${step.title}`, 'step');
      item.dataset.done = String(step.done);
      if (step.current) item.setAttribute('aria-current', 'step');
      return item;
    });
    replaceChildren(document.getElementById('steps'), items);
  }

  function filmElement(film) {
    const video = document.createElement('video');
    Object.assign(video, { controls: true, autoplay: true, muted: true, loop: true, playsInline: true });
    video.crossOrigin = 'anonymous';
    video.poster = film.poster;
    video.src = film.webm;
    if (film.captions) {
      video.append(Object.assign(document.createElement('track'), { kind: 'captions', srclang: 'en', label: 'English', src: film.captions, default: true }));
    }
    video.addEventListener('error', () => document.getElementById('offline').removeAttribute('hidden'));
    return video;
  }

  function renderFilm(current) {
    const webm = current ? current.film.webm : '';
    if (webm === playing) return;
    playing = webm;
    document.getElementById('offline').setAttribute('hidden', '');
    replaceChildren(document.getElementById('film'), current ? [filmElement(current.film)] : []);
  }

  function renderCurrent(view) {
    const current = view.current;
    document.getElementById('title').textContent = current ? current.title : 'All done';
    document.getElementById('instruction').textContent = current
      ? current.instruction
      : 'You have carried out every step in the live editor.';
    document.getElementById('open-file').hidden = !(current && current.opensFile);
    renderFilm(current);
  }

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'view') {
      renderLanguages(event.data.view);
      renderSteps(event.data.view);
      renderCurrent(event.data.view);
    }
  });

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('button') : null;
    if (!target) return;
    if (target.dataset.language) vscode.postMessage({ type: 'language', language: target.dataset.language });
    if (target.id === 'open-file') vscode.postMessage({ type: 'openFile' });
  });

  vscode.postMessage({ type: 'ready' });
})();
