/* 星点层 + 方案切换。
   一颗种子生成固定星图，截图和动画看到的是同一片天空。 */
(() => {
  const canvas = document.getElementById('stars')
  const ctx = canvas.getContext('2d')
  const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  const TAU = Math.PI * 2

  const CONFIG = {
    a: {
      seed: 1207,
      count: 780,
      alpha: 1,
      tint: '#dbe7ff',
      bright: '#cfefff',
      band: 0.8,
      bandY: 0.47,
      bandSlope: -0.3,
      bandSigma: 0.056,
      shooting: true
    },
    b: {
      seed: 3311,
      count: 340,
      alpha: 0.78,
      tint: '#dbe7ff',
      bright: '#cfefff',
      cluster: { x: 0.36, y: 0.22, sigma: 0.05, count: 90 },
      shooting: false
    },
    c: {
      seed: 9021,
      count: 620,
      alpha: 0.95,
      tint: '#d6f1f5',
      bright: '#c8fbff',
      cluster: { x: 0.34, y: 0.32, sigma: 0.045, count: 230 },
      shooting: true
    },
    d: {
      seed: 4407,
      count: 290,
      alpha: 0.62,
      tint: '#dbe3f4',
      bright: '#e4edff',
      shooting: false
    }
  }

  let width = 0
  let height = 0
  let dpr = 1
  let variant = 'a'
  let stars = []
  let shooting = []
  let shootTimer = 3200
  let raf = 0
  let last = 0
  let pointerX = 0
  let pointerY = 0
  let targetX = 0
  let targetY = 0
  let noShooting = false

  const mulberry32 = (seed) => {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  const gauss = (rnd) => {
    let u = 0
    let v = 0
    while (u === 0) u = rnd()
    while (v === 0) v = rnd()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v)
  }

  const resize = () => {
    width = window.innerWidth
    height = window.innerHeight
    dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    build()
  }

  const build = () => {
    const cfg = CONFIG[variant]
    const rnd = mulberry32(cfg.seed)
    const scale = Math.sqrt((width * height) / (1356 * 858))
    const count = Math.round(cfg.count * Math.max(0.6, Math.min(1.5, scale)))
    stars = []

    for (let i = 0; i < count; i++) {
      const inBand = cfg.band && rnd() < cfg.band
      let x = rnd()
      let y
      if (inBand) {
        y = cfg.bandY + (x - 0.5) * cfg.bandSlope + gauss(rnd) * cfg.bandSigma
        if (y < 0.02 || y > 0.98) y = rnd()
      } else {
        y = rnd()
      }

      const depth = inBand ? 0.42 + rnd() * 0.58 : rnd()
      stars.push({
        x,
        y,
        depth,
        r: depth < 0.7 ? 0.24 + rnd() * 0.5 : depth < 0.94 ? 0.6 + rnd() * 0.55 : 1 + rnd() * 0.65,
        alpha: (depth < 0.7 ? 0.18 + rnd() * 0.26 : depth < 0.94 ? 0.34 + rnd() * 0.42 : 0.58 + rnd() * 0.4) * cfg.alpha,
        phase: rnd() * TAU,
        twinkle: 0.35 + rnd() * 1.3,
        bright: depth > 0.965
      })
    }

    if (cfg.cluster) {
      const cl = cfg.cluster
      for (let i = 0; i < cl.count; i++) {
        const depth = 0.3 + rnd() * 0.7
        stars.push({
          x: cl.x + gauss(rnd) * cl.sigma,
          y: cl.y + gauss(rnd) * cl.sigma * 0.82,
          depth,
          r: 0.25 + rnd() * 0.55 + (depth > 0.9 ? 0.5 : 0),
          alpha: (0.2 + rnd() * 0.55) * cfg.alpha,
          phase: rnd() * TAU,
          twinkle: 0.4 + rnd() * 1.5,
          bright: depth > 0.975
        })
      }
    }
  }

  const draw = (now, parallax) => {
    const cfg = CONFIG[variant]
    ctx.clearRect(0, 0, width, height)

    for (const star of stars) {
      const ox = parallax ? pointerX * 0.012 * (0.3 + star.depth) : 0
      const oy = parallax ? pointerY * 9 * (0.3 + star.depth) : 0
      const x = ((((star.x + ox) % 1) + 1) % 1) * width
      const y = ((((star.y + oy) % 1) + 1) % 1) * height
      if (y > height + 2 || y < -2) continue
      const tw = 0.5 + 0.5 * Math.sin(now * 0.001 * star.twinkle + star.phase)
      ctx.globalAlpha = star.alpha * (0.5 + tw * 0.5)
      ctx.fillStyle = star.depth > 0.94 ? cfg.bright : cfg.tint
      ctx.beginPath()
      ctx.arc(x, y, star.r, 0, TAU)
      ctx.fill()

      if (star.bright) {
        ctx.globalAlpha *= 0.2
        ctx.strokeStyle = '#aeeaff'
        ctx.lineWidth = 0.7
        ctx.beginPath()
        ctx.moveTo(x - star.r * 5, y)
        ctx.lineTo(x + star.r * 5, y)
        ctx.moveTo(x, y - star.r * 5)
        ctx.lineTo(x, y + star.r * 5)
        ctx.stroke()
      }
    }
    ctx.globalAlpha = 1
  }

  const spawnShooting = () => {
    const fromLeft = Math.random() < 0.5
    shooting.push({
      x: fromLeft ? 40 + Math.random() * width * 0.5 : width * (0.35 + Math.random() * 0.45),
      y: 40 + Math.random() * height * 0.3,
      vx: fromLeft ? 4.6 + Math.random() * 3.2 : 3 + Math.random() * 2.6,
      vy: 1.6 + Math.random() * 1.6,
      life: 1,
      len: 70 + Math.random() * 80
    })
  }

  const drawShooting = (k) => {
    for (let i = shooting.length - 1; i >= 0; i--) {
      const s = shooting[i]
      s.x += s.vx * k
      s.y += s.vy * k
      s.life -= 0.011 * k
      if (s.life <= 0 || s.x > width + 220 || s.y > height + 100) {
        shooting.splice(i, 1)
        continue
      }
      const norm = Math.hypot(s.vx, s.vy) || 1
      const tx = s.x - (s.vx / norm) * s.len
      const ty = s.y - (s.vy / norm) * s.len
      const grad = ctx.createLinearGradient(s.x, s.y, tx, ty)
      grad.addColorStop(0, 'rgba(228, 248, 255, ' + (0.75 * s.life).toFixed(3) + ')')
      grad.addColorStop(0.3, 'rgba(163, 224, 255, ' + (0.28 * s.life).toFixed(3) + ')')
      grad.addColorStop(1, 'rgba(143, 231, 255, 0)')
      ctx.strokeStyle = grad
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(s.x, s.y)
      ctx.lineTo(tx, ty)
      ctx.stroke()
    }
  }

  const frame = (now) => {
    raf = requestAnimationFrame(frame)
    const elapsed = now - last
    if (elapsed < 40) return
    last = now
    const k = Math.min(2, elapsed / 16.6667)

    pointerX += (targetX - pointerX) * 0.045
    pointerY += (targetY - pointerY) * 0.045
    draw(now, true)

    if (CONFIG[variant].shooting && !noShooting) {
      shootTimer -= elapsed
      if (shootTimer <= 0) {
        shootTimer = 9000 + Math.random() * 11000
        spawnShooting()
      }
      drawShooting(k)
    }
  }

  const start = () => {
    cancelAnimationFrame(raf)
    last = performance.now()
    raf = requestAnimationFrame(frame)
  }

  const still = () => {
    cancelAnimationFrame(raf)
    raf = 0
    shooting = []
    draw(performance.now(), false)
  }

  const applyVariant = (v) => {
    if (!CONFIG[v]) return
    variant = v
    document.body.dataset.variant = v
    document.querySelectorAll('.vr-btn[data-v]').forEach((b) => b.classList.toggle('is-on', b.dataset.v === v))
    build()
    if (reduceQuery.matches) still()
    else {
      shootTimer = 3200 + Math.random() * 4000
      draw(performance.now(), false)
    }
  }

  const applyContent = (n) => {
    const key = String(n)
    if (!['0', '1', '2', '3', '4'].includes(key)) return
    document.body.dataset.content = key
    document.querySelectorAll('[data-content]').forEach((b) => b.classList.toggle('is-on', b.dataset.content === key))
  }

  const onResize = () => {
    resize()
    if (reduceQuery.matches) still()
  }

  const onPointerMove = (event) => {
    targetX = event.clientX / window.innerWidth - 0.5
    targetY = event.clientY / window.innerHeight - 0.5
  }

  const onReduceChange = () => {
    if (reduceQuery.matches) still()
    else start()
  }

  // 调试 / 截图入口
  window.setVariant = (v, clean) => {
    if (clean) {
      document.body.classList.add('clean')
      noShooting = true
      shooting = []
    }
    applyVariant(v)
  }
  window.setContent = applyContent

  const params = new URLSearchParams(location.search)
  if (params.get('clean') === '1') document.body.classList.add('clean')

  document.querySelectorAll('.vr-btn[data-v]').forEach((btn) => {
    btn.addEventListener('click', () => applyVariant(btn.dataset.v))
  })

  document.querySelectorAll('[data-content]').forEach((btn) => {
    btn.addEventListener('click', () => applyContent(btn.dataset.content))
  })

  window.addEventListener('keydown', (event) => {
    const map = { '1': 'a', '2': 'b', '3': 'c', '4': 'd' }
    if (map[event.key]) applyVariant(map[event.key])
  })

  resize()
  applyVariant(params.get('v') || 'a')
  applyContent(params.get('content') || '1')
  window.addEventListener('resize', onResize)
  window.addEventListener('pointermove', onPointerMove, { passive: true })
  if (reduceQuery.addEventListener) reduceQuery.addEventListener('change', onReduceChange)

  if (reduceQuery.matches) {
    still()
    const system = document.querySelector('.b-system')
    if (system && system.pauseAnimations) system.pauseAnimations()
  } else {
    start()
  }
})()
