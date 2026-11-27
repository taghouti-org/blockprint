// Shared header / footer / helpers for every page.
const LOGO = `<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 3 28 9.5v13L16 29 4 22.5v-13z" fill="#e8d5a3"/><path d="M16 3 28 9.5 16 16 4 9.5z" fill="#fff6dc"/><path d="M16 16v13L4 22.5v-13z" fill="#cdb67a"/><path d="M9 12.2v6.6M13 14.4v6.6M19 14.4v6.6M23 12.2v6.6" stroke="#1f6fd6" stroke-width="1.4"/></svg>`

function esc (s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }
async function api (url, opts = {}) {
  const r = await fetch(url, { credentials: 'same-origin', ...opts, headers: { ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } })
  const t = await r.text(); let j; try { j = JSON.parse(t) } catch { j = { error: t } }
  if (!r.ok) throw new Error(j.error || r.statusText)
  return j
}
const STYLE_LABEL = { tunisian: 'Tunisian', modern: 'Modern', classic: 'Classic wood' }

function header (active) {
  const h = document.createElement('header'); h.className = 'topbar'
  h.innerHTML = `<div class="wrap">
    <a class="brand" href="/">${LOGO}<span>Blockprint</span></a>
    <nav class="nav">
      <a href="/" class="${active === 'home' ? 'on' : ''}">Home</a>
      <a href="/city" class="${active === 'city' ? 'on' : ''}">The city</a>
      <a href="/showcases" class="${active === 'showcases' ? 'on' : ''}">Showcases</a>
      <a href="/create" class="${active === 'create' ? 'on' : ''}">Build yours</a>
      <span class="spacer"></span>
      <a href="/admin" class="${active === 'admin' ? 'on' : ''}" title="Admin">Admin</a>
    </nav></div>`
  document.body.prepend(h)
  const f = document.createElement('footer'); f.className = 'site blueprint'
  f.innerHTML = `<div class="wrap"><div><b style="color:#fff">Blockprint</b> · floor plans read by Claude, built block by block.</div>
    <div>3D explorer: <a style="color:#cfe0ff" href="https://github.com/zardoy/minecraft-web-client" target="_blank" rel="noopener">minecraft-web-client</a> (MIT) · not affiliated with Mojang or Microsoft.</div></div>`
  document.body.append(f)
}

function showcaseCard (s) {
  const live = s.online > 0 ? `<span class="live">${s.online} visiting now</span>` : `<span class="live off">quiet right now</span>`
  return `<article class="card">
    <a class="thumb blueprint" href="/s/${esc(s.id)}">
      ${s.featured ? '<span class="chip ribbon" style="background:#e8d5a3;color:#0c2340">★ Featured</span>' : ''}
      <img src="/api/showcases/${esc(s.id)}/files/iso.png" alt="${esc(s.title)} seen from the street" loading="lazy"></a>
    <div class="body">
      <h3>${esc(s.title)}</h3>
      <div class="by">by ${esc(s.author)}</div>
      <div class="row">
        ${s.style ? `<span class="chip style-${esc(s.style)}">${esc(STYLE_LABEL[s.style] || s.style)}</span>` : ''}
        ${s.stats ? `<span class="chip">${s.stats.levels} floor${s.stats.levels > 1 ? 's' : ''}</span><span class="chip">${s.stats.rooms} spaces</span>` : ''}
        ${live}
      </div>
      <div class="actions"><a class="btn small blue" href="/s/${esc(s.id)}">Explore</a><a class="btn small light" href="/city?house=${esc(s.id)}">On the city map</a></div>
    </div></article>`
}

// explorer name (shown above your head to other visitors)
function explorerName () {
  let n = localStorage.getItem('bp_name')
  if (!n || !/^[A-Za-z0-9_]{3,16}$/.test(n)) { n = 'Visitor' + Math.floor(1000 + Math.random() * 9000); localStorage.setItem('bp_name', n) }
  return n
}
