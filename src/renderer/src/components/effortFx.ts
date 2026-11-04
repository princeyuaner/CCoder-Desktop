/*
 * 思考深度弹层里的粒子层。
 *
 * 画布只活在弹层内部，尺寸跟着 .epick 走；颜色从 CSS 变量读，所以
 * 明暗主题 / 六档配色都只需要改样式。这里不碰 React 状态，组件只需要
 * 在档位变化时喊一声 burst()。
 */

type Rgb = [number, number, number]

interface Spark {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  decay: number
  size: number
  color: Rgb
  kind: 'spark' | 'ember'
  age: number
  phase: number
}

interface Wave {
  x: number
  y: number
  life: number
  decay: number
  maxX: number
  maxY: number
  color: Rgb
}

interface Arc {
  pts: { x: number; y: number }[]
  life: number
  decay: number
  color: Rgb
  width: number
}

export interface EffortFx {
  /** 档位变化时在轨道上打出一簇定向能量 */
  burst: (index: number, direction: number) => void
  /** 弹层打开时来一发小的，作为"上电" */
  intro: () => void
  dispose: () => void
}

interface Options {
  root: HTMLElement
  canvas: HTMLCanvasElement
  knob: HTMLElement
  count: number
}

const TAU = Math.PI * 2
const MAX_SPARKS = 260
const rand = (min: number, max: number): number => min + Math.random() * (max - min)

const rgba = (color: Rgb, alpha: number): string =>
  `rgba(${color[0]},${color[1]},${color[2]},${Math.max(0, Math.min(1, alpha))})`

function parseRgb(value: string, fallback: Rgb): Rgb {
  const parts = value.trim().split(/[\s,/]+/).map(Number)
  if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
    return [parts[0], parts[1], parts[2]]
  }
  return fallback
}

export function createEffortFx({ root, canvas, knob, count }: Options): EffortFx {
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return { burst: () => {}, intro: () => {}, dispose: () => {} }
  }

  const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  let levelCount = Math.max(2, count)
  let width = 1
  let height = 1
  let running = false
  let disposed = false
  let frameId = 0
  let lastFrame = performance.now()
  let emberTimer = 0
  let arcTimer = 0

  const sparks: Spark[] = []
  const waves: Wave[] = []
  const arcs: Arc[] = []

  const palette = (): { a: Rgb; b: Rgb } => {
    const styles = getComputedStyle(root)
    return {
      a: parseRgb(styles.getPropertyValue('--eff-a-rgb'), [167, 139, 250]),
      b: parseRgb(styles.getPropertyValue('--eff-b-rgb'), [192, 132, 252])
    }
  }

  const levelIndex = (): number => {
    const n = Number(root.dataset.effortIndex)
    return Number.isFinite(n) ? Math.max(0, Math.min(levelCount - 1, n)) : 0
  }

  const resize = (): void => {
    const rect = canvas.getBoundingClientRect()
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    width = Math.max(1, rect.width)
    height = Math.max(1, rect.height)
    const pxW = Math.round(width * dpr)
    const pxH = Math.round(height * dpr)
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW
      canvas.height = pxH
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  /** 轨道上的目标点，用百分比算，不依赖滑块的过渡状态 */
  const railPoint = (index: number): { x: number; y: number } => {
    const canvasRect = canvas.getBoundingClientRect()
    const rail = root.querySelector<HTMLElement>('.erail')
    if (!rail) {
      const knobRect = knob.getBoundingClientRect()
      return {
        x: knobRect.left - canvasRect.left + knobRect.width / 2,
        y: knobRect.top - canvasRect.top + knobRect.height / 2
      }
    }
    const rect = rail.getBoundingClientRect()
    const ratio = levelCount <= 1 ? 0 : index / (levelCount - 1)
    return {
      x: rect.left - canvasRect.left + rect.width * ratio,
      y: rect.top - canvasRect.top + rect.height / 2
    }
  }

  const currentKnobPoint = (): { x: number; y: number } => {
    const canvasRect = canvas.getBoundingClientRect()
    const knobRect = knob.getBoundingClientRect()
    return {
      x: knobRect.left - canvasRect.left + knobRect.width / 2,
      y: knobRect.top - canvasRect.top + knobRect.height / 2
    }
  }

  const pushSpark = (spark: Spark): void => {
    sparks.push(spark)
    if (sparks.length > MAX_SPARKS) sparks.splice(0, sparks.length - MAX_SPARKS)
  }

  const spawnEmber = (x: number, y: number): void => {
    const colors = palette()
    pushSpark({
      x: x + rand(-7, 7),
      y: y + rand(-5, 5),
      vx: rand(-0.22, 0.22),
      vy: rand(-1.15, -0.32),
      life: 1,
      decay: rand(0.007, 0.014),
      size: rand(0.5, 1.35),
      color: Math.random() < 0.5 ? colors.a : colors.b,
      kind: 'ember',
      age: 0,
      phase: Math.random() * TAU
    })
  }

  const addArc = (center: { x: number; y: number }): void => {
    const colors = palette()
    const angle = Math.random() * TAU
    const start = rand(3, 10)
    const length = rand(16, 42) + levelIndex() * 3
    const sx = center.x + Math.cos(angle) * start
    const sy = center.y + Math.sin(angle) * start
    const ex = center.x + Math.cos(angle) * length
    const ey = center.y + Math.sin(angle) * length
    const pts: Arc['pts'] = []

    for (let i = 0; i <= 5; i++) {
      const t = i / 5
      const wobble = i === 0 || i === 5 ? 0 : rand(-1, 1) * (12 * (1 - t) + 4)
      pts.push({
        x: sx + (ex - sx) * t + wobble,
        y: sy + (ey - sy) * t + rand(-5, 5)
      })
    }

    arcs.push({
      pts,
      life: 1,
      decay: rand(0.1, 0.17),
      color: Math.random() < 0.7 ? colors.a : colors.b,
      width: rand(0.6, 1.5)
    })
    if (arcs.length > 12) arcs.shift()
  }

  const spawnBurst = (
    x: number,
    y: number,
    direction: number,
    small: boolean
  ): void => {
    const colors = palette()
    const lv = levelIndex()
    const dir = direction === 0 ? (Math.random() < 0.5 ? -1 : 1) : direction
    const total = small ? 20 : 30 + lv * 9

    for (let i = 0; i < total; i++) {
      const streak = Math.random() < 0.7
      const speed = rand(0.7, 4.2) * (0.82 + lv * 0.08) * (small ? 0.7 : 1)
      let vx = 0
      let vy = 0

      if (streak) {
        const angle = rand(-0.48, 0.48)
        vx = Math.cos(angle) * speed * dir + rand(-0.25, 0.25)
        vy = Math.sin(angle) * speed * 0.24
      } else {
        const angle = Math.random() * TAU
        vx = Math.cos(angle) * speed * 0.66
        vy = Math.sin(angle) * speed * 0.45
      }

      pushSpark({
        x: x + rand(-5, 5),
        y: y + rand(-4, 4),
        vx,
        vy: vy - 0.1,
        life: 1,
        decay: rand(0.012, 0.027),
        size: rand(0.55, 2),
        color: Math.random() < 0.13 ? [255, 255, 255] : Math.random() < 0.5 ? colors.a : colors.b,
        kind: 'spark',
        age: 0,
        phase: 0
      })
    }

    waves.push({
      x,
      y,
      life: 1,
      decay: small ? 0.04 : 0.028,
      maxX: (small ? 36 : 64) + lv * 15,
      maxY: (small ? 10 : 15) + lv * 3.2,
      color: colors.a
    })

    if (!small && lv >= 3) {
      waves.push({
        x,
        y,
        life: 1,
        decay: 0.016,
        maxX: 96 + lv * 15,
        maxY: 24 + lv * 4,
        color: colors.b
      })
      addArc({ x, y })
    }
  }

  const emitAmbient = (k: number): void => {
    emberTimer += k * 16.667
    const interval = Math.max(72, 300 - levelIndex() * 42)
    if (emberTimer >= interval) {
      emberTimer = 0
      const point = currentKnobPoint()
      spawnEmber(point.x, point.y)
      if (levelIndex() >= 3) spawnEmber(point.x, point.y)
    }

    arcTimer += k * 16.667
    const lv = levelIndex()
    if (lv >= 3 && arcTimer >= (lv >= 5 ? 100 : 190)) {
      arcTimer = 0
      addArc(currentKnobPoint())
    }
  }

  const draw = (k: number): void => {
    ctx.clearRect(0, 0, width, height)
    if (width < 2 || height < 2) return

    const light = document.documentElement.dataset.scheme === 'light'
    ctx.globalCompositeOperation = light ? 'source-over' : 'lighter'

    for (let i = waves.length - 1; i >= 0; i--) {
      const wave = waves[i]
      wave.life -= wave.decay * k
      if (wave.life <= 0) {
        waves.splice(i, 1)
        continue
      }
      const progress = 1 - wave.life
      const spread = 1 - Math.pow(1 - progress, 2.2)
      const rx = 6 + wave.maxX * spread
      const ry = 3 + wave.maxY * spread
      fxCtxEllipse(ctx, wave, rx, ry)
    }
    ctx.shadowBlur = 0

    for (let i = arcs.length - 1; i >= 0; i--) {
      const arc = arcs[i]
      arc.life -= arc.decay * k
      if (arc.life <= 0) {
        arcs.splice(i, 1)
        continue
      }
      const alpha = Math.pow(arc.life, 1.4)
      ctx.beginPath()
      arc.pts.forEach((pt, index) => {
        if (index === 0) ctx.moveTo(pt.x, pt.y)
        else ctx.lineTo(pt.x, pt.y)
      })
      ctx.strokeStyle = rgba(arc.color, alpha * 0.85)
      ctx.lineWidth = arc.width * (0.5 + arc.life)
      ctx.shadowColor = rgba(arc.color, 0.9)
      ctx.shadowBlur = 12
      ctx.stroke()
      ctx.strokeStyle = rgba([255, 255, 255], alpha * 0.55)
      ctx.lineWidth = Math.max(0.4, arc.width * 0.4)
      ctx.shadowBlur = 0
      ctx.stroke()
    }
    ctx.shadowBlur = 0

    for (let i = sparks.length - 1; i >= 0; i--) {
      const spark = sparks[i]
      spark.age += k
      spark.x += spark.vx * k
      spark.y += spark.vy * k

      if (spark.kind === 'spark') {
        spark.vx *= Math.pow(0.982, k)
        spark.vy = spark.vy * Math.pow(0.982, k) + 0.024 * k
      } else {
        spark.vy -= 0.0034 * k
        spark.x += Math.sin(spark.age * 0.12 + spark.phase) * 0.18 * k
      }

      spark.life -= spark.decay * k
      if (spark.life <= 0) {
        sparks.splice(i, 1)
        continue
      }

      const alpha = Math.max(0, Math.min(1, spark.life))

      if (spark.kind === 'spark' && alpha > 0.3) {
        ctx.strokeStyle = rgba(spark.color, alpha * 0.28)
        ctx.lineWidth = Math.max(0.5, spark.size * 0.65)
        ctx.beginPath()
        ctx.moveTo(spark.x - spark.vx * 2, spark.y - spark.vy * 2)
        ctx.lineTo(spark.x, spark.y)
        ctx.stroke()
      }

      ctx.fillStyle = rgba(spark.color, alpha * 0.1)
      ctx.beginPath()
      ctx.arc(spark.x, spark.y, spark.size * 3.1, 0, TAU)
      ctx.fill()

      ctx.fillStyle = rgba(spark.color, alpha)
      ctx.beginPath()
      ctx.arc(spark.x, spark.y, spark.size, 0, TAU)
      ctx.fill()
    }

    ctx.globalCompositeOperation = 'source-over'
  }

  function fxCtxEllipse(
    context: CanvasRenderingContext2D,
    wave: Wave,
    rx: number,
    ry: number
  ): void {
    const alpha = wave.life * wave.life * 0.8
    context.strokeStyle = rgba(wave.color, alpha)
    context.lineWidth = 0.5 + 2 * wave.life
    context.shadowColor = rgba(wave.color, 0.9)
    context.shadowBlur = 14
    context.beginPath()
    context.ellipse(wave.x, wave.y, rx, ry, 0, 0, TAU)
    context.stroke()
  }

  const frame = (now: number): void => {
    if (!running) return
    frameId = requestAnimationFrame(frame)
    if (reduceQuery.matches || document.hidden) {
      lastFrame = now
      return
    }
    const dt = Math.min(48, now - lastFrame)
    lastFrame = now
    const k = dt / 16.667
    emitAmbient(k)
    draw(k)
  }

  const start = (): void => {
    if (running || reduceQuery.matches) return
    running = true
    lastFrame = performance.now()
    frameId = requestAnimationFrame(frame)
  }

  const stopLoop = (): void => {
    running = false
    cancelAnimationFrame(frameId)
    frameId = 0
    ctx.clearRect(0, 0, width, height)
  }

  const onReduceChange = (): void => {
    if (reduceQuery.matches) stopLoop()
    else start()
  }

  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(root)
  resize()
  reduceQuery.addEventListener('change', onReduceChange)
  start()

  return {
    burst(index, direction) {
      if (disposed || reduceQuery.matches) return
      levelCount = Math.max(2, count)
      resize()
      const point = railPoint(index)
      spawnBurst(point.x, point.y, direction, false)
    },
    intro() {
      if (disposed || reduceQuery.matches) return
      resize()
      const point = railPoint(levelIndex())
      spawnBurst(point.x, point.y, 1, true)
    },
    dispose() {
      disposed = true
      stopLoop()
      resizeObserver.disconnect()
      reduceQuery.removeEventListener('change', onReduceChange)
      sparks.length = 0
      waves.length = 0
      arcs.length = 0
    }
  }
}
