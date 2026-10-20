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

  /** The origins the extension allows films from, written into the page by panel.ts. */
  const filmOrigins = (document.body.dataset.filmOrigins || '').split(' ').filter(Boolean);

  /** `raw` as a URL on an allowed film origin, or '' for anything else. */
  /** @param {unknown} raw */
  function filmUrl(raw) {
    try {
      const url = new URL(String(raw));
      return filmOrigins.includes(url.origin) ? url.href : '';
    } catch {
      return '';
    }
  }

  /** The film's URL, opened at its chapter with a media fragment. */
  function filmSource(film) {
    const video = filmUrl(film.video);
    const start = Number(film.start);
    return video && start > 0 ? `${video}#t=${start}` : video;
  }

  /** Tell the extension how the film fared, so a failure is logged, never silent. */
  /** @param {'loading' | 'ready' | 'error'} state @param {HTMLVideoElement} video */
  function report(state, video) {
    const error = video.error;
    vscode.postMessage({
      type: 'film',
      state,
      src: video.currentSrc || video.src,
      detail: error ? `MediaError ${error.code}: ${error.message}` : '',
    });
  }

  function filmElement(film) {
    const video = document.createElement('video');
    Object.assign(video, {
      controls: true,
      autoplay: true,
      muted: true,
      loop: true,
      playsInline: true,
    });
    video.crossOrigin = 'anonymous';
    video.poster = filmUrl(film.poster);
    video.src = filmSource(film);
    const captions = filmUrl(film.captions);
    if (captions) {
      video.append(
        Object.assign(document.createElement('track'), {
          kind: 'captions',
          srclang: 'en',
          label: 'English',
          src: captions,
          default: true,
        }),
      );
    }
    video.addEventListener('loadedmetadata', () => report('ready', video));
    video.addEventListener('error', () => {
      document.getElementById('offline').removeAttribute('hidden');
      report('error', video);
    });
    return video;
  }

  function renderFilm(current) {
    const source = current ? filmSource(current.film) : '';
    if (source === playing) return;
    playing = source;
    document.getElementById('offline').setAttribute('hidden', '');
    const video = current ? filmElement(current.film) : undefined;
    replaceChildren(document.getElementById('film'), video ? [video] : []);
    if (video) report('loading', video);
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
    // The extension's messages arrive from the webview's own origin; nothing else may drive it.
    if (event.origin !== window.origin) return;
    if (event.data && event.data.type === 'view') {
      renderLanguages(event.data.view);
      renderSteps(event.data.view);
      renderCurrent(event.data.view);
    }
  });

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('button') : null;
    if (!target) return;
    if (target.dataset.language)
      vscode.postMessage({ type: 'language', language: target.dataset.language });
    if (target.id === 'open-file') vscode.postMessage({ type: 'openFile' });
  });

  vscode.postMessage({ type: 'ready' });
})();
