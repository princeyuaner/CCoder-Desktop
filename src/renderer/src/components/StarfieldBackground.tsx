import { useEffect, useRef } from 'react'

/*
 * 星野主题的背景层。
 *
 * 只在 settings.theme === 'starfield' 时挂载；App 内容整体抬到它上面，
 * 所以这里可以放心用 fixed 全屏画布，不需要给每个页面单独铺背景。
 * 星点走 canvas，星云 / 行星 / 轨道 / 暗角走 CSS，两者都尊重
 * prefers-reduced-motion。
 */
export function StarfieldBackground(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
    const TAU = Math.PI * 2
    const rand = (min: number, max: number): number => min + Math.random() * (max - min)

    interface Star {
      x: number
      y: number
      depth: number
      r: number
      alpha: number
      phase: number
      twinkle: number
      bright: boolean
    }

    interface Shooting {
      x: number
      y: number
      vx: number
      vy: number
      life: number
      len: number
    }

    let width = 0
    let height = 0
    let dpr = 1
    let stars: Star[] = []
    let shooting: Shooting[] = []
    let shootTimer = 2800
    let last = performance.now()
    let raf = 0
    let running = false
    let pointerX = 0
    let pointerY = 0
    let targetX = 0
    let targetY = 0

    const makeStars = (): void => {
      /*
       * 极光帷幕版：主星场之外，再撒一团疏散星团（左中偏上，避开侧栏）。
       * 星团用高斯分布，密度往中心收，不然会散成一片均匀噪点。
       */
      const count = Math.min(560, Math.max(240, Math.round((width * height) / 2300)))

      const gauss = (): number => {
        let u = 0
        let v = 0
        while (u === 0) u = Math.random()
        while (v === 0) v = Math.random()
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v)
      }

      const makeStar = (x: number, y: number, clustered = false): Star => {
        const depth = clustered ? 0.3 + Math.random() * 0.68 : Math.random()
        return {
          x,
          y,
          depth,
          r: depth < 0.7 ? rand(0.25, 0.75) : depth < 0.94 ? rand(0.65, 1.15) : rand(1, 1.6),
          alpha:
            (depth < 0.7 ? rand(0.2, 0.46) : depth < 0.94 ? rand(0.36, 0.74) : rand(0.6, 0.96)) *
            (clustered ? 1.06 : 1),
          phase: Math.random() * TAU,
          twinkle: rand(0.4, 1.6),
          bright: depth > 0.962
        }
      }

      stars = Array.from({ length: count }, () => makeStar(Math.random(), Math.random()))

      const clusterCount = Math.round(count * 0.36)
      for (let i = 0; i < clusterCount; i++) {
        const x = 0.34 + gauss() * 0.045
        const y = 0.32 + gauss() * 0.037
        if (x < 0 || x > 1 || y < 0 || y > 1) continue
        stars.push(makeStar(x, y, true))
      }
    }

    const resize = (): void => {
      width = window.innerWidth
      height = window.innerHeight
      dpr = Math.min(2, window.devicePixelRatio || 1)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      makeStars()
    }

    const drawStars = (now: number, parallax: boolean): void => {
      ctx.clearRect(0, 0, width, height)
      for (const star of stars) {
        const offsetX = parallax ? pointerX * 0.016 * (0.3 + star.depth) : 0
        const offsetY = parallax ? pointerY * 12 * (0.3 + star.depth) : 0
        const x = (((star.x + offsetX) % 1) + 1) % 1 * width
        const y = star.y * height + offsetY
        const twinkle = 0.5 + 0.5 * Math.sin(now * 0.001 * star.twinkle + star.phase)
        ctx.globalAlpha = star.alpha * (0.52 + twinkle * 0.48)
        ctx.fillStyle = star.depth > 0.94 ? '#c8fbff' : '#d5f2f7'
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

    const spawnShooting = (): void => {
      const fromLeft = Math.random() < 0.55
      shooting.push({
        x: fromLeft ? rand(0, width * 0.56) : rand(width * 0.3, width * 0.84),
        y: rand(40, height * 0.32),
        vx: fromLeft ? rand(5.2, 8.4) : rand(3.4, 6.2),
        vy: rand(1.8, 3.4),
        life: 1,
        len: rand(80, 160)
      })
    }

    const drawShooting = (k: number): void => {
      for (let i = shooting.length - 1; i >= 0; i--) {
        const s = shooting[i]
        s.x += s.vx * k
        s.y += s.vy * k
        s.life -= 0.012 * k
        if (s.life <= 0 || s.x > width + 260 || s.y > height + 120) {
          shooting.splice(i, 1)
          continue
        }
        const norm = Math.hypot(s.vx, s.vy) || 1
        const tx = s.x - (s.vx / norm) * s.len
        const ty = s.y - (s.vy / norm) * s.len
        const grad = ctx.createLinearGradient(s.x, s.y, tx, ty)
        grad.addColorStop(0, 'rgba(225, 247, 255, ' + (0.8 * s.life).toFixed(3) + ')')
        grad.addColorStop(0.25, 'rgba(163, 224, 255, ' + (0.32 * s.life).toFixed(3) + ')')
        grad.addColorStop(1, 'rgba(143, 231, 255, 0)')
        ctx.strokeStyle = grad
        ctx.lineWidth = 1.1
        ctx.beginPath()
        ctx.moveTo(s.x, s.y)
        ctx.lineTo(tx, ty)
        ctx.stroke()
      }
    }

    const frame = (now: number): void => {
      if (!running) return
      raf = requestAnimationFrame(frame)
      const elapsed = now - last
      if (elapsed < 33) return
      last = now
      const dt = Math.min(80, elapsed)
      const k = dt / 16.6667
      if (document.hidden) return

      pointerX += (targetX - pointerX) * 0.045
      pointerY += (targetY - pointerY) * 0.045
      drawStars(now, true)

      shootTimer -= dt
      if (shootTimer <= 0) {
        shootTimer = rand(9000, 15000)
        spawnShooting()
      }
      drawShooting(k)
    }

    const start = (): void => {
      if (running || reduce.matches) return
      running = true
      last = performance.now()
      raf = requestAnimationFrame(frame)
    }

    const stop = (): void => {
      running = false
      cancelAnimationFrame(raf)
      raf = 0
    }

    const staticFrame = (): void => {
      drawStars(performance.now(), false)
    }

    const onResize = (): void => {
      resize()
      if (reduce.matches) staticFrame()
    }

    const onPointerMove = (event: PointerEvent): void => {
      targetX = event.clientX / window.innerWidth - 0.5
      targetY = event.clientY / window.innerHeight - 0.5
    }

    const onReduceChange = (): void => {
      if (reduce.matches) {
        stop()
        shooting = []
        staticFrame()
      } else {
        start()
      }
    }

    resize()
    window.addEventListener('resize', onResize)
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    reduce.addEventListener('change', onReduceChange)
    if (reduce.matches) staticFrame()
    else start()

    return () => {
      stop()
      window.removeEventListener('resize', onResize)
      window.removeEventListener('pointermove', onPointerMove)
      reduce.removeEventListener('change', onReduceChange)
    }
  }, [])

  return (
    <div className="sf-backdrop" aria-hidden="true">
      <div className="sf-sky">
        <span className="sf-aurora sf-aurora--l" />
        <span className="sf-aurora sf-aurora--r" />
        <span className="sf-aurora sf-aurora--m" />
        <span className="sf-streaks" />
        <span className="sf-horizon" />
      </div>

      <canvas ref={canvasRef} className="sf-canvas" />

      <div className="sf-curtains">
        <svg viewBox="0 0 1356 858" preserveAspectRatio="xMidYMid slice">
          <defs>
            <linearGradient id="sfAuroraMint" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#7fe0bc" stopOpacity="0" />
              <stop offset="0.16" stopColor="#a6f7d6" stopOpacity="0.6" />
              <stop offset="0.52" stopColor="#5fd8c4" stopOpacity="0.3" />
              <stop offset="1" stopColor="#3aa8b8" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="sfAuroraViolet" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#bdaaff" stopOpacity="0" />
              <stop offset="0.18" stopColor="#c3b2ff" stopOpacity="0.52" />
              <stop offset="0.56" stopColor="#8f7cf0" stopOpacity="0.26" />
              <stop offset="1" stopColor="#6a5bd0" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="sfAuroraCyan" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#8fe7ff" stopOpacity="0" />
              <stop offset="0.22" stopColor="#b6f2ff" stopOpacity="0.4" />
              <stop offset="0.62" stopColor="#66cfe0" stopOpacity="0.18" />
              <stop offset="1" stopColor="#4aa6c0" stopOpacity="0" />
            </linearGradient>
            <filter id="sfAuroraSoft" x="-40%" y="-20%" width="180%" height="140%">
              <feGaussianBlur stdDeviation="20" />
            </filter>
            <filter id="sfAuroraTight" x="-40%" y="-20%" width="180%" height="140%">
              <feGaussianBlur stdDeviation="5" />
            </filter>
          </defs>

          <g fill="none" strokeLinecap="round" filter="url(#sfAuroraSoft)" opacity="0.68">
            <path
              d="M 352 -60 C 300 120 402 260 350 470 C 318 600 372 700 338 900"
              stroke="url(#sfAuroraMint)"
              strokeWidth="100"
            />
            <path
              d="M 452 -60 C 414 140 486 300 446 520 C 420 660 470 760 448 900"
              stroke="url(#sfAuroraCyan)"
              strokeWidth="36"
              opacity="0.7"
            />
            <path
              d="M 1198 -60 C 1146 160 1248 340 1196 560 C 1166 700 1218 780 1198 920"
              stroke="url(#sfAuroraViolet)"
              strokeWidth="116"
              opacity="0.78"
            />
            <path
              d="M 1108 -60 C 1070 140 1148 320 1100 540 C 1072 680 1120 780 1104 900"
              stroke="url(#sfAuroraCyan)"
              strokeWidth="32"
              opacity="0.55"
            />
            <path
              d="M 782 -60 C 760 180 812 380 786 600 C 770 720 792 800 782 900"
              stroke="url(#sfAuroraCyan)"
              strokeWidth="48"
              opacity="0.32"
            />
          </g>

          <g fill="none" strokeLinecap="round" filter="url(#sfAuroraTight)" opacity="0.32">
            <path
              d="M 388 -40 C 342 140 444 280 392 492 C 364 620 412 720 382 900"
              stroke="url(#sfAuroraMint)"
              strokeWidth="2.4"
            />
            <path
              d="M 418 -40 C 372 160 468 300 420 510 C 392 640 440 740 414 900"
              stroke="url(#sfAuroraCyan)"
              strokeWidth="1.6"
              opacity="0.8"
            />
            <path
              d="M 1234 -40 C 1182 180 1282 360 1230 580 C 1202 710 1248 800 1230 920"
              stroke="url(#sfAuroraViolet)"
              strokeWidth="2.6"
            />
            <path
              d="M 1160 -40 C 1112 160 1208 340 1156 560 C 1128 690 1176 790 1158 900"
              stroke="url(#sfAuroraCyan)"
              strokeWidth="1.4"
              opacity="0.7"
            />
          </g>

          <ellipse
            cx="678"
            cy="930"
            rx="840"
            ry="230"
            fill="none"
            stroke="url(#sfAuroraCyan)"
            strokeWidth="112"
            filter="url(#sfAuroraSoft)"
            opacity="0.34"
          />
        </svg>
      </div>

      <span className="sf-cluster" />
      <span className="sf-mist" />
      <span className="sf-grain" />
      <span className="sf-vignette" />
    </div>
  )
}
