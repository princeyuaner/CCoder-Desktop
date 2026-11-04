import { useEffect, useRef } from 'react'
import type { AmbientTheme } from '@shared/settings'

/*
 * 氛围主题的背景层。
 *
 * 只在 settings.theme 属于 AMBIENT_THEMES 时挂载；App 内容整体抬到它上面，
 * 所以这里可以放心用 fixed 全屏铺底。光晕 / 极光 / 虹彩走 CSS，
 * 火星 / 浮游生物 / 樱瓣走 canvas —— 粒子上百个，用 DOM 会拖慢主线程。
 *
 * 全部尊重 prefers-reduced-motion：开启减少动态时 canvas 直接不启动，
 * CSS 动画也由 ambient.css 末尾统一停掉，只留静态柔光。
 */

const TAU = Math.PI * 2
const rand = (min: number, max: number): number => min + Math.random() * (max - min)

type ParticleTheme = 'ember' | 'abyss' | 'sakura'

function isParticleTheme(theme: AmbientTheme): theme is ParticleTheme {
  return theme === 'ember' || theme === 'abyss' || theme === 'sakura'
}

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  size: number
  alpha: number
  phase: number
  spin: number
  rot: number
}

/** 每个主题的粒子数量基线；按窗口面积缩放，但不过分稠密 */
const PARTICLE_BASE: Record<ParticleTheme, number> = {
  ember: 82,
  abyss: 110,
  sakura: 52
}

function makeParticle(theme: ParticleTheme, initial: boolean): Particle {
  if (theme === 'ember') {
    return {
      x: Math.random(),
      y: initial ? Math.random() * 1.12 : 1.02 + Math.random() * 0.06,
      vx: rand(-0.008, 0.008),
      vy: rand(-0.17, -0.06),
      size: rand(0.8, 2.2),
      alpha: rand(0.24, 0.9),
      phase: Math.random() * TAU,
      spin: 0,
      rot: 0
    }
  }

  if (theme === 'abyss') {
    return {
      x: Math.random(),
      y: initial ? Math.random() * 1.1 : 1.02 + Math.random() * 0.08,
      vx: rand(-0.0025, 0.0025),
      vy: rand(-0.014, -0.004),
      size: rand(0.5, 1.7),
      alpha: rand(0.2, 0.85),
      phase: Math.random() * TAU,
      spin: 0,
      rot: 0
    }
  }

  return {
    x: Math.random(),
    y: initial ? Math.random() * 1.12 - 0.12 : -0.06 - Math.random() * 0.06,
    vx: rand(-0.006, 0.006),
    vy: rand(0.035, 0.08),
    size: rand(2.2, 4.8),
    alpha: rand(0.32, 0.9),
    phase: Math.random() * TAU,
    spin: rand(-1.4, 1.4),
    rot: Math.random() * TAU
  }
}

/** 主题专属的静态光层。粒子层由 canvas 负责 */
function Layers({ theme }: { theme: AmbientTheme }): JSX.Element | null {
  if (theme === 'aurora') {
    return (
      <>
        <div className="amb-aurora a1" />
        <div className="amb-aurora a2" />
        <div className="amb-aurora a3" />
        <div className="amb-aurora-streaks" />
        <div className="amb-aurora-floor" />
      </>
    )
  }
  if (theme === 'ember') {
    return (
      <>
        <div className="amb-ember-glow" />
        <div className="amb-ember-haze" />
      </>
    )
  }
  if (theme === 'abyss') {
    return (
      <>
        <div className="amb-abyss-beam" />
        <div className="amb-abyss-glow" />
        <div className="amb-abyss-floor" />
      </>
    )
  }
  if (theme === 'sakura') {
    return (
      <>
        <div className="amb-sakura-moon" />
        <div className="amb-sakura-glow g1" />
        <div className="amb-sakura-glow g2" />
      </>
    )
  }
  if (theme === 'prism') {
    return (
      <>
        <div className="amb-prism-blob b1" />
        <div className="amb-prism-blob b2" />
        <div className="amb-prism-sheen" />
        <div className="amb-prism-edge" />
      </>
    )
  }
  if (theme === 'glacier') {
    return (
      <>
        <div className="amb-glacier-band b1" />
        <div className="amb-glacier-band b2" />
        <div className="amb-glacier-floor" />
        <div className="amb-glacier-streak" />
      </>
    )
  }
  return null
}

export function AmbientBackground({ theme }: { theme: AmbientTheme }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!isParticleTheme(theme)) return
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    let width = 0
    let height = 0
    let dpr = 1
    let particles: Particle[] = []
    let raf = 0
    let running = false
    let last = performance.now()

    const resize = (): void => {
      width = window.innerWidth
      height = window.innerHeight
      dpr = Math.min(2, window.devicePixelRatio || 1)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const makeAll = (): void => {
      const scale = Math.min(1.35, (width * height) / (1440 * 900))
      const count = Math.max(26, Math.round(PARTICLE_BASE[theme] * scale))
      particles = Array.from({ length: count }, () => makeParticle(theme, true))
    }

    const resetParticle = (p: Particle, index: number): void => {
      const next = makeParticle(theme, false)
      particles[index] = { ...next, x: next.x, phase: p.phase + rand(0, 1.4) }
    }

    const tick = (now: number): void => {
      if (!running) return
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      ctx.clearRect(0, 0, width, height)

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i]

        if (theme === 'ember') {
          p.x += (p.vx + Math.sin(now * 0.0009 + p.phase) * 0.008) * dt
          p.y += p.vy * dt
          if (p.y < -0.06 || p.x < -0.06 || p.x > 1.06) {
            resetParticle(p, i)
            continue
          }
          const x = p.x * width
          const y = p.y * height
          const twinkle = 0.55 + 0.45 * Math.sin(now * 0.004 + p.phase)
          ctx.globalAlpha = p.alpha * 0.3 * twinkle
          ctx.fillStyle = '#ff7a2a'
          ctx.beginPath()
          ctx.arc(x, y, p.size * 3.4, 0, TAU)
          ctx.fill()
          ctx.globalAlpha = p.alpha * (0.55 + twinkle * 0.45)
          ctx.fillStyle = '#ffc27a'
          ctx.beginPath()
          ctx.arc(x, y, p.size, 0, TAU)
          ctx.fill()
          continue
        }

        if (theme === 'abyss') {
          p.x += (p.vx + Math.sin(now * 0.0005 + p.phase) * 0.0016) * dt
          p.y += p.vy * dt
          if (p.y < -0.06 || p.x < -0.04 || p.x > 1.04) {
            resetParticle(p, i)
            continue
          }
          const x = p.x * width
          const y = p.y * height
          const twinkle = 0.5 + 0.5 * Math.sin(now * 0.0014 + p.phase)
          const alpha = p.alpha * (0.32 + twinkle * 0.68)
          ctx.globalAlpha = alpha * 0.22
          ctx.fillStyle = '#38e8ff'
          ctx.beginPath()
          ctx.arc(x, y, p.size * 3.2, 0, TAU)
          ctx.fill()
          ctx.globalAlpha = alpha
          ctx.fillStyle = '#a9f7ff'
          ctx.beginPath()
          ctx.arc(x, y, p.size, 0, TAU)
          ctx.fill()
          continue
        }

        // sakura
        p.x += (p.vx + Math.sin(now * 0.0011 + p.phase) * 0.012) * dt
        p.y += p.vy * dt
        p.rot += p.spin * dt
        if (p.y > 1.08 || p.x < -0.1 || p.x > 1.1) {
          resetParticle(p, i)
          continue
        }
        const x = p.x * width
        const y = p.y * height
        ctx.save()
        ctx.translate(x, y)
        ctx.rotate(p.rot)
        ctx.globalAlpha = p.alpha * (0.72 + 0.28 * Math.sin(now * 0.0016 + p.phase))
        ctx.fillStyle = '#ff8fbe'
        ctx.beginPath()
        ctx.ellipse(0, 0, p.size, p.size * 0.62, 0, 0, TAU)
        ctx.fill()
        ctx.globalAlpha *= 0.5
        ctx.fillStyle = '#ffe3ef'
        ctx.beginPath()
        ctx.ellipse(-p.size * 0.2, -p.size * 0.16, p.size * 0.36, p.size * 0.2, 0, 0, TAU)
        ctx.fill()
        ctx.restore()
      }

      raf = requestAnimationFrame(tick)
    }

    const start = (): void => {
      if (running) return
      running = true
      last = performance.now()
      raf = requestAnimationFrame(tick)
    }

    const stop = (): void => {
      running = false
      if (raf) cancelAnimationFrame(raf)
      raf = 0
    }

    const onVisibility = (): void => {
      if (document.hidden) stop()
      else start()
    }

    const onResize = (): void => {
      resize()
      makeAll()
    }

    resize()
    makeAll()
    start()
    window.addEventListener('resize', onResize)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      stop()
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [theme])

  return (
    <div className={`ambient ambient--${theme}`} aria-hidden="true">
      <Layers theme={theme} />
      {isParticleTheme(theme) && <canvas ref={canvasRef} className="ambient__canvas" />}
    </div>
  )
}
