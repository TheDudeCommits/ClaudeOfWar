/**
 * HUD and settings. DOM rather than in-scene geometry: crisp at any resolution,
 * costs no GPU time, and the render target is already the bottleneck.
 *
 * ART_BIBLE §12.12 lists "UI that looks like default engine UI" as an instant
 * fail, so the bars are angular and etched rather than rounded rectangles, and
 * the palette is the same desaturated gold/steel as the world.
 */

const CSS = `
#hud{position:fixed;inset:0;pointer-events:none;z-index:5;
  font:500 12px/1.3 ui-sans-serif,-apple-system,'SF Pro Text',system-ui,sans-serif;
  color:#d8d2c6;text-shadow:0 1px 3px #000a;-webkit-font-smoothing:antialiased}
#hud .bars{position:absolute;left:34px;bottom:34px;width:290px}
#hud .bar{position:relative;height:13px;margin-bottom:7px;
  background:linear-gradient(#0d1014cc,#05070acc);
  border:1px solid #2b2f36;
  clip-path:polygon(7px 0,100% 0,calc(100% - 7px) 100%,0 100%)}
#hud .bar > i{position:absolute;inset:1px;transform-origin:left;transition:transform .12s linear;display:block}
#hud .hp > i{background:linear-gradient(180deg,#e8555a,#8e2226)}
#hud .rage > i{background:linear-gradient(180deg,#f0c04a,#a4711a)}
#hud .stam{height:5px}
#hud .stam > i{background:linear-gradient(180deg,#9fb6c9,#4a5a68)}
#hud .lbl{font-size:9.5px;letter-spacing:2.4px;text-transform:uppercase;color:#8a8577;margin-bottom:4px}
#hud .enemy{position:absolute;left:50%;top:52px;transform:translateX(-50%);width:230px;text-align:center;
  opacity:0;transition:opacity .25s}
#hud .enemy.on{opacity:1}
#hud .enemy .bar{height:7px}
#hud .enemy .bar > i{background:linear-gradient(180deg,#cfd6de,#6a7480)}
#hud .name{font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#b9b2a2;margin-bottom:5px}
#hud .hint{position:absolute;right:30px;bottom:30px;text-align:right;color:#7d786c;font-size:11px;line-height:1.7}
#hud .hint b{color:#c8c0ae;font-weight:600}
#hud .center{position:absolute;inset:0;display:grid;place-items:center;font-size:34px;
  letter-spacing:10px;text-transform:uppercase;color:#e6dcc6;opacity:0;transition:opacity .5s}
#hud .center.on{opacity:1}

#settings{position:fixed;inset:0;z-index:9;background:#05070ae8;backdrop-filter:blur(9px);
  display:none;place-items:center;pointer-events:auto}
#settings.on{display:grid}
#settings .panel{width:min(560px,92vw);border:1px solid #2c313a;background:#0a0d12f2;padding:30px 32px}
#settings h2{margin:0 0 4px;font:600 15px/1.2 ui-sans-serif,system-ui;letter-spacing:5px;
  text-transform:uppercase;color:#e0d7c4}
#settings .sub{color:#7d786c;font-size:11.5px;margin-bottom:22px}
#settings .opt{display:flex;gap:14px;align-items:flex-start;padding:15px 16px;margin-bottom:10px;
  border:1px solid #2a2f38;cursor:pointer;background:#0d1117;transition:border-color .15s,background .15s}
#settings .opt:hover{border-color:#4a525e;background:#111722}
#settings .opt.sel{border-color:#c9a227;background:#15140f}
#settings .opt .dot{width:11px;height:11px;margin-top:3px;border:1px solid #6a6252;flex:none;
  transform:rotate(45deg)}
#settings .opt.sel .dot{background:#c9a227;border-color:#c9a227}
#settings .opt h3{margin:0 0 3px;font:600 13px/1.2 ui-sans-serif,system-ui;color:#ded5c2;letter-spacing:.6px}
#settings .opt p{margin:0;font-size:11.5px;color:#847e70;line-height:1.55}
#settings .close{margin-top:18px;width:100%;padding:11px;background:#151b24;border:1px solid #333a45;
  color:#ccc4b2;font:600 11px/1 ui-sans-serif,system-ui;letter-spacing:3px;text-transform:uppercase;cursor:pointer}
#settings .close:hover{background:#1d2530;border-color:#4a525e}
#settings .note{margin-top:13px;font-size:10.5px;color:#6b665c;line-height:1.6}
`;

export const QUALITY_MODES = {
  medium: {
    name: 'Performance',
    desc: 'Renders at 80% and upscales, half-resolution ambient occlusion. '
        + 'Holds 30+ FPS on a cold MacBook Air M2; expect it to dip under '
        + 'sustained load, since the machine is fanless and throttles.',
  },
  high: {
    name: 'Fidelity',
    desc: 'Native resolution, full-resolution ambient occlusion, wider bloom '
        + 'and a larger depth-of-field kernel. Measurably sharper — and '
        + 'measurably below 30 FPS on an M2 Air. Prioritises image quality.',
  },
};

export function currentQuality() {
  const url = new URLSearchParams(location.search).get('q');
  if (url && QUALITY_MODES[url]) return url;
  const saved = localStorage.getItem('cow.quality');
  return QUALITY_MODES[saved] ? saved : 'medium';
}

export class HUD {
  constructor() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const hud = document.createElement('div');
    hud.id = 'hud';
    hud.innerHTML = `
      <div class="bars">
        <div class="lbl">Vitality</div>
        <div class="bar hp"><i style="transform:scaleX(1)"></i></div>
        <div class="bar rage"><i style="transform:scaleX(0)"></i></div>
        <div class="bar stam"><i style="transform:scaleX(1)"></i></div>
      </div>
      <div class="enemy">
        <div class="name">Draugr</div>
        <div class="bar"><i style="transform:scaleX(1)"></i></div>
      </div>
      <div class="hint">
        <b>WASD</b> move &nbsp; <b>LMB</b> attack<br>
        <b>SPACE</b> dodge &nbsp; <b>RMB</b> guard<br>
        <b>ESC</b> settings
      </div>
      <div class="center"></div>`;
    document.body.appendChild(hud);

    const set = document.createElement('div');
    set.id = 'settings';
    set.innerHTML = `
      <div class="panel">
        <h2>Settings</h2>
        <div class="sub">Graphics quality</div>
        ${Object.entries(QUALITY_MODES).map(([k, v]) => `
          <div class="opt" data-q="${k}">
            <div class="dot"></div>
            <div><h3>${v.name}</h3><p>${v.desc}</p></div>
          </div>`).join('')}
        <button class="close">Resume</button>
        <div class="note">Changing quality reloads the game.</div>
      </div>`;
    document.body.appendChild(set);

    this.el = {
      hp: hud.querySelector('.hp > i'),
      rage: hud.querySelector('.rage > i'),
      stam: hud.querySelector('.stam > i'),
      enemy: hud.querySelector('.enemy'),
      enemyBar: hud.querySelector('.enemy .bar > i'),
      center: hud.querySelector('.center'),
      settings: set,
    };

    const cur = currentQuality();
    set.querySelectorAll('.opt').forEach((o) => {
      if (o.dataset.q === cur) o.classList.add('sel');
      o.addEventListener('click', () => {
        const q = o.dataset.q;
        localStorage.setItem('cow.quality', q);
        const u = new URL(location.href);
        u.searchParams.set('q', q);
        location.href = u.toString();
      });
    });
    set.querySelector('.close').addEventListener('click', () => this.toggle(false));
    addEventListener('keydown', (e) => {
      if (e.code === 'Escape') this.toggle();
    });
  }

  toggle(on) {
    const next = on === undefined ? !this.el.settings.classList.contains('on') : on;
    this.el.settings.classList.toggle('on', next);
    return next;
  }
  get open() { return this.el.settings.classList.contains('on'); }

  update(player, target) {
    this.el.hp.style.transform = `scaleX(${Math.max(0, player.hp / player.maxHp)})`;
    this.el.rage.style.transform = `scaleX(${player.rage / 100})`;
    this.el.stam.style.transform = `scaleX(${player.stamina / 100})`;
    const show = target && !target.dead;
    this.el.enemy.classList.toggle('on', !!show);
    if (show) this.el.enemyBar.style.transform = `scaleX(${Math.max(0, target.hp / target.maxHp)})`;
  }

  banner(text) {
    this.el.center.textContent = text;
    this.el.center.classList.toggle('on', !!text);
  }
}
