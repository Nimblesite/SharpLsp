// Implements [WEB-DESIGN-MEDIA]. A lesson's slides, drawn from t alone. LESSON
// (injected by lesson.mjs) holds each slide's content and its timing: when it
// starts and ends, when each of its narration lines starts, and the real
// footage it plays. A slide's items appear as the line that names them is spoken.
'use strict';

const LESSON = window.LESSON;
const FPS = 30;
const $ = (id) => document.getElementById(id);
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const ease = {
  out: (p) => 1 - (1 - p) ** 3,
  back: (p) => 1 + 2.4 * (p - 1) ** 3 + 1.4 * (p - 1) ** 2,
};
const ENTER = 0.42;
const EXIT = 0.28;
const REVEAL = 0.5;

/** The time an item appears: its line's start (or just after the cut), cascading by its `index` among that line's items. */
const cue = (slide, line, index) => (slide.lines[line] ?? slide.start + 0.35) + 0.12 * index;
/** Each item's place among the items its own line reveals. */
const ranks = (list) => list.map((item, i) => list.slice(0, i).filter((other) => other.line === item.line).length);
const at = (slide, line, index) => `class="item" data-at="${cue(slide, line, index).toFixed(3)}"`;
const heading = (slide) =>
  `<div class="kicker item" data-at="${slide.start.toFixed(3)}">${slide.kicker ?? ''}</div><h2 class="heading item wipe" data-at="${(slide.start + 0.08).toFixed(3)}">${slide.heading ?? ''}</h2>`;

const layouts = {
  title: (s) => `<div class="kicker item" data-at="${s.start}">${s.kicker}</div>
    <h1 class="title item wipe" data-at="${s.start + 0.15}">${s.title}</h1>
    <p class="sub" ${at(s, s.subLine, 1)}>${s.sub}</p>
    <div class="chips">${s.chips.map((chip, i) => `<div ${at(s, s.chipsLine, i + 2)}>${chip}</div>`).join('')}</div>`,
  points: (s) => `${heading(s)}${s.sub ? `<p class="sub" ${at(s, s.subLine, 0)}>${s.sub}</p>` : ''}
    <div class="rows">${s.rows.map((r, i) => `<div class="row" ${at(s, r.line, ranks(s.rows)[i])}><span class="k">${r.k}</span><span class="v">${r.v}</span><span class="w">${r.w ?? ''}</span></div>`).join('')}</div>`,
  keys: (s) => `${heading(s)}<div class="keys">${s.keys.map((k, i) => `<div class="keyset${k.hot ? ' hot' : ''}" ${at(s, k.line, ranks(s.keys)[i])}>
    <div class="os">${k.os}</div><div class="caps">${k.caps.map((c) => (c === '+' ? '<span>+</span>' : `<div class="cap">${c}</div>`)).join('')}</div></div>`).join('')}</div>
    ${s.sub ? `<p class="sub" ${at(s, s.subLine, 0)}>${s.sub}</p>` : ''}`,
  footage: (s) => `${heading(s)}<div class="screen item" data-at="${s.start + 0.2}"><div class="bar"><i style="background:var(--red)"></i><i style="background:var(--orange)"></i><i style="background:var(--green)"></i><span>${s.footage.label}</span><em>Real footage · VS Code</em></div>
    <img class="frame" alt="">${s.footage.speed > 1 ? `<div class="speed">${s.footage.speed}× speed</div>` : ''}</div>
    <div class="notes">${s.notes.map((n, i) => `<div class="note" ${at(s, n.line, ranks(s.notes)[i])}><span class="n">${i + 1}</span><span>${n.text}</span></div>`).join('')}</div>`,
  cards: (s) => `${heading(s)}<div class="cards">${s.cards.map((c, i) => `<div class="card" ${at(s, c.line, ranks(s.cards)[i])}><code>${c.code}</code><p>${c.text}</p></div>`).join('')}</div>`,
  code: (s) => `${heading(s)}<div class="pair">${s.panes.map((p, i) => `<div class="code" ${at(s, p.line, ranks(s.panes)[i])}><div class="label">${p.label}</div>
    <pre>${p.code.map((l) => `<div${l.mark ? ` class="${l.mark}"` : ''}>${l.text || ' '}</div>`).join('')}</pre></div>`).join('')}</div>
    ${s.caption ? `<p class="caption" ${at(s, s.captionLine, 0)}>${s.caption}</p>` : ''}`,
  flow: (s) => `${heading(s)}<div class="flow">${s.stages.map((g, i) => `<div class="stage" ${at(s, g.line, ranks(s.stages)[i])}><div class="n">${String(i + 1).padStart(2, '0')}</div><h3>${g.title}</h3><p>${g.text}</p></div>`).join('')}</div>
    ${s.sub ? `<p class="sub" ${at(s, s.subLine, 0)}>${s.sub}</p>` : ''}`,
  recap: (s) => `${heading(s)}<div class="recap">${s.items.map((r, i) => `<div ${at(s, r.line, ranks(s.items)[i])}><span>${i + 1}</span>${r.text}</div>`).join('')}</div>
    <div class="url item" data-at="${cue(s, s.urlLine, 0)}">${s.url}</div>`,
};

/** Build every slide once; renderFrame only moves and shows them. */
function build() {
  $('logo').src = LESSON.logo;
  $('series').textContent = LESSON.series;
  for (const slide of LESSON.slides) {
    const node = document.createElement('section');
    node.className = `slide ${slide.layout}-slide`;
    node.innerHTML = layouts[slide.layout](slide);
    $('slides').append(node);
    slide.node = node;
    slide.items = [...node.querySelectorAll('.item')].map((el) => ({ el, at: Number(el.dataset.at) }));
    slide.frame = node.querySelector('.frame');
  }
  for (const slide of LESSON.slides.slice(1)) $('progress').insertAdjacentHTML('beforeend', `<b style="left:${(slide.start / LESSON.duration) * 100}%"></b>`);
}

/** The slide's own entrance and exit: in from the right, out to the left. */
function place(slide, t) {
  const shown = t >= slide.start && t < slide.end;
  slide.node.style.visibility = shown ? 'visible' : 'hidden';
  if (!shown) return false;
  const enter = ease.out(clamp((t - slide.start) / ENTER));
  const exit = slide === LESSON.slides.at(-1) ? 0 : ease.out(clamp((t - (slide.end - EXIT)) / EXIT));
  slide.node.style.opacity = String(Math.min(enter, 1 - exit));
  slide.node.style.transform = `translateX(${(1 - enter) * 90 - exit * 70}px)`;
  return true;
}

/** Each item springs up as its line starts; a heading wipes in left to right. */
function reveal(slide, t) {
  for (const { el, at: start } of slide.items) {
    const p = clamp((t - start) / REVEAL);
    el.style.opacity = String(clamp((t - start) / (REVEAL / 2)));
    el.style.transform = `translateY(${(1 - ease.back(p)) * 34}px)`;
    if (el.classList.contains('wipe')) el.style.clipPath = `inset(-20% ${(1 - ease.out(p)) * 100}% -20% 0)`;
  }
}

const pending = [];

/** The footage frame for t: real time from the slide's cut plus its delay, held on its last frame. */
function footage(slide, t) {
  if (!slide.frame) return;
  const { base, frames, delay } = slide.footage;
  const index = clamp(Math.floor((t - slide.start - delay) * FPS) + 1, 1, frames);
  const src = `${base}/${String(index).padStart(5, '0')}.jpg`;
  if (slide.frame.dataset.src === src) return;
  slide.frame.dataset.src = src;
  slide.frame.src = src;
  pending.push(slide.frame.decode().catch(() => undefined));
}

/** The glow breathes on the score's beat while the drums play. */
function pulse(t) {
  const playing = t >= LESSON.drums && t < LESSON.resolve;
  const kick = playing ? Math.exp(-((t - LESSON.drums) % LESSON.beat) / 0.16) : 0;
  $('glow').style.opacity = String(0.62 + 0.38 * kick);
  $('glow').style.transform = `scale(${1 + 0.035 * kick})`;
}

window.FILM_DURATION = LESSON.duration;
build();

window.renderFrame = (t) => {
  pending.length = 0;
  const index = LESSON.slides.findIndex((slide) => place(slide, t));
  for (const slide of LESSON.slides) if (slide.node.style.visibility === 'visible') reveal(slide, t), footage(slide, t);
  pulse(t);
  $('fill').style.width = `${(t / LESSON.duration) * 100}%`;
  $('count').textContent = `${String(index + 1).padStart(2, '0')} / ${String(LESSON.slides.length).padStart(2, '0')}`;
  return Promise.all(pending).then(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
};
