import { useEffect, useRef } from 'react'
import * as THREE from 'three'

export type OrbState = 'idle' | 'listening' | 'thinking' | 'executing' | 'speaking' | 'error'

interface ParticleOrbProps {
  state: OrbState
  /** 麦克风电平；回应状态另外带有缓慢的视觉脉冲，不假装是输出音频频谱。 */
  level: number
}

// position 存储流线参数，GPU 每帧求出空间坐标。几何数据不需要逐帧上传。
const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uFlow;
  uniform float uLevel;
  uniform float uListen;
  uniform float uThink;
  uniform float uExecute;
  uniform float uSpeak;
  uniform float uError;
  uniform float uScale;
  attribute vec3 aSeed;
  attribute float aKind;
  varying vec3 vColor;
  varying float vAlpha;
  const float TAU = 6.28318530718;

  mat2 turn(float a) { return mat2(cos(a), sin(a), -sin(a), cos(a)); }

  void main() {
    vec3 p;
    float alpha = 1.0;
    float size = 1.0;
    float spark = 0.0;
    float wave = sin(uTime * 1.3);
    float response = uSpeak * (0.5 + 0.5 * sin(uTime * 3.2));
    float energy = uLevel * uListen + response * 0.22;

    if (aKind < 0.5) {
      // 对称的能量壳体：用偶数纬度谐波，避免顶部收尖、底部下坠造成草莓轮廓。
      float phi = position.y;
      float theta = position.x + uFlow * 0.10;
      theta += sin(phi * 3.1 + uTime * 0.22) * 0.24;
      theta += sin(phi * 7.0 - uTime * 0.17) * 0.08;
      float equator = pow(sin(phi), 0.9);
      float field = sin(theta * 2.0 + phi * 4.0 + uTime * 0.38) * equator;
      float folds = cos(theta * 4.0 - phi * 2.0 - uTime * 0.25) * equator;
      float radial = 1.0 + field * 0.13 + folds * 0.045;
      radial += sin(theta * 6.0 + phi * 3.0 + uTime * 0.3) * equator * 0.018;
      float r = position.z * radial;
      float pulse = pow(0.5 + 0.5 * sin(theta * 6.0 - uTime * 2.2), 5.0) * equator;
      r *= 1.0 + wave * 0.014 + energy * (0.075 + pulse * 0.12) - uThink * 0.035 - uError * 0.04;
      p = r * vec3(sin(phi) * cos(theta), cos(phi), sin(phi) * sin(theta));
      p.y += (sin(theta * 2.0 + phi * 5.0 - uTime * 0.32) * 0.10
           + cos(theta * 4.0 - phi * 3.0) * 0.045) * equator;
      p.x += sin(phi * 3.0 + uTime * 0.18) * equator * 0.035;
      p *= vec3(1.06, 1.02, 1.04);
      // 聆听：纵向伸展并随音量聚拢，外部的环波向中心汇入。
      p *= vec3(1.0 - uListen * 0.10, 1.0 + uListen * 0.12, 1.0);
      p *= 1.0 - uListen * uLevel * 0.10;
      // 思考：整团重组为扭转环流，轮廓与聆听球体完全不同。
      float major = position.x + uFlow * 0.32;
      float minor = phi * 2.0 + uFlow * 0.9 + position.x * 2.0;
      float tube = 0.26 + 0.025 * sin(major * 3.0 + uTime * 0.5);
      vec3 torus = vec3((0.76 + tube * cos(minor)) * cos(major),
                       (0.76 + tube * cos(minor)) * sin(major), tube * sin(minor));
      torus.yz = turn(0.38 + sin(uTime * 0.4) * 0.12) * torus.yz;
      p = mix(p, torus, uThink);
      // 执行：核心收拢，保留轨道空间；扫描光带沿核心上下运行。
      p *= 1.0 - uExecute * 0.28;
      float scan = exp(-pow((p.y - sin(uTime * 1.8) * 0.8) * 10.0, 2.0));
      p *= 1.0 + uSpeak * (0.05 + 0.07 * sin(uTime * 3.2 - phi * 2.0));
      alpha = 0.95 + uExecute * scan * 0.45;
      size = 2.70 + energy * 0.25;
    } else if (aKind < 1.5) {
      // 轨道上数束亮点带渐隐尾迹，轨道倾角不同，因此有真实的前后穿插。
      float tail = position.x;
      float orbit = position.y;
      float direction = mod(orbit, 2.0) < 0.5 ? 1.0 : -1.0;
      float angle = uFlow * (0.38 + orbit * 0.035) * direction + orbit * 2.1 - tail * mix(1.8, TAU, uExecute);
      float r = position.z * (1.0 + energy * 0.025 - uThink * 0.12);
      p = vec3(cos(angle) * r, sin(angle) * r, 0.0);
      p.yz = turn(0.65 + orbit * 0.47) * p.yz;
      p.xy = turn(orbit * 1.18) * p.xy;
      p += (aSeed - 0.5) * 0.012;
      alpha = pow(1.0 - tail, 1.7) * (0.95 + uThink * 0.35);
      alpha = mix(alpha, 0.23 + pow(1.0 - tail, 5.0) * 1.4, uExecute);
      // 待机只展示参考图的曲面。轨道作为状态反馈，在工作时出现。
      alpha *= uExecute + uThink * 0.28;
      size = 1.7 + pow(1.0 - tail, 12.0) * 3.8;
      spark = pow(1.0 - tail, 8.0);
    } else {
      // 三组环波：听的时候向内汇聚，说的时候向外传播，执行时上下扫描。
      float phase = fract(uTime * 0.38 + position.y / 3.0);
      float angle = position.x;
      float radius = mix(1.40, 0.65, phase);
      radius = mix(radius, 0.65 + phase * 0.75, uSpeak);
      p = vec3(cos(angle) * radius, sin(angle) * radius, 0.0);
      p.yz = turn(0.22) * p.yz;
      vec3 scanner = vec3(cos(angle) * 1.05, (phase - 0.5) * 1.9, sin(angle) * 1.05);
      p = mix(p, scanner, uExecute);
      float envelope = sin(phase * 3.14159265);
      alpha = envelope * (uListen * (0.16 + uLevel * 0.22) + uSpeak * 0.25 + uExecute * 0.7);
      size = 1.8 + aSeed.x * 0.7;
      spark = uExecute * 0.6;
    }

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float nearSide = smoothstep(-0.55, 0.65, (modelViewMatrix * vec4(normalize(p), 0.0)).z);
    vec3 cyan = vec3(0.36, 0.84, 1.0);
    vec3 blue = vec3(0.18, 0.56, 0.98);
    vec3 violet = vec3(0.75, 0.39, 0.96);
    // 颜色在三维曲面中连续交织，而不是按屏幕高度分层。
    // 使用笛卡尔坐标避免 atan 经度接缝，也避免逐点随机色破坏连续色带。
    vec3 surface = normalize(p);
    float drift = uTime * 0.09;
    float foldField = sin(dot(surface, vec3(2.8, -1.6, 2.1)) + drift);
    float ribbon = sin(dot(surface, vec3(-3.0, 2.4, 1.5)) + foldField * 1.35 - drift);
    float returnFlow = sin(dot(surface, vec3(1.7, 3.1, -2.6)) - foldField * 0.85 + 1.4);
    float edge = 1.0 - smoothstep(0.20, 0.90, nearSide);
    // 蓝色为底，紫色沿局部回折出现，青色勾勒另一组弯曲亮带。
    float violetBand = smoothstep(0.48, 0.90, ribbon) * (0.65 + edge * 0.35);
    float cyanBand = smoothstep(0.38, 0.92, returnFlow) * (0.75 + edge * 0.25);
    vColor = mix(blue, violet, violetBand * 0.94);
    vColor = mix(vColor, cyan, cyanBand * 0.86);
    // 工作状态保留混色，仅提高色带/轨道能量，避免整团被统一染成紫或绿。
    vColor = mix(vColor, violet, uThink * violetBand * 0.18);
    vColor = mix(vColor, cyan, uExecute * (0.10 + spark * 0.34));
    vColor = mix(vColor, vec3(0.60, 0.88, 1.0), spark * 0.25 + uSpeak * 0.12);
    vColor = mix(vColor, vec3(1.0, 0.36, 0.23), uError * 0.85);
    // 密集边缘降低叠加能量，保留青紫色；正面单点仍然清晰。
    vAlpha = alpha * mix(0.04, 0.86, nearSide) * (1.0 - edge * 0.25);
    gl_PointSize = clamp(size * uScale * (4.25 / -mv.z), 1.0, 12.0 * uScale);
  }
`

const fragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    // 大部分面积为实心圆点，只在边缘抗锯齿，保留参考图清晰的点距。
    float core = 1.0 - smoothstep(0.70, 1.0, d);
    gl_FragColor = vec4(vColor, core * vAlpha);
  }
`

export function ParticleOrb({ state, level }: ParticleOrbProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const propsRef = useRef({ state, level })
  const redrawRef = useRef<(() => void) | null>(null)
  propsRef.current = { state, level }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const lowPower = (navigator.hardwareConcurrency || 8) <= 4
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: !lowPower, powerPreference: 'low-power' })
    } catch {
      host.dataset.fallback = 'true'
      return
    }
    delete host.dataset.fallback
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, lowPower ? 1.25 : 2))
    renderer.setClearColor(0x000000, 0)
    host.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(43, 1, 0.1, 30)
    camera.position.z = 3.85
    const group = new THREE.Group()
    group.rotation.set(-0.18, 0, -0.16)
    scene.add(group)

    const lanes = lowPower ? 96 : 144
    const perLane = lowPower ? 64 : 96
    const trailLength = lowPower ? 90 : 160
    const ringCount = lowPower ? 240 : 420
    const waveStart = lanes * perLane + 6 * trailLength
    const count = waveStart + 3 * ringCount
    const positions = new Float32Array(count * 3)
    const seeds = new Float32Array(count * 3)
    const kinds = new Float32Array(count)
    // 固定种子使热更新、尺寸对比和状态检查看到同一个粒子结构。
    let seed = 72341
    const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 4294967296
    }
    for (let i = 0; i < count; i += 1) {
      const offset = i * 3
      seeds.set([random(), random(), random()], offset)
      if (i < lanes * perLane) {
        const lane = Math.floor(i / perLane)
        const along = (i % perLane + 0.5) / perLane
        positions.set([
          lane / lanes * Math.PI * 2,
          along * Math.PI,
          1.04
        ], offset)
      } else if (i < lanes * perLane + 6 * trailLength) {
        const index = i - lanes * perLane
        kinds[i] = 1
        positions.set([index % trailLength / trailLength, Math.floor(index / trailLength), 1.24 + Math.floor(index / trailLength) * 0.025], offset)
      } else {
        const index = i - waveStart
        kinds[i] = 2
        positions.set([index % ringCount / ringCount * Math.PI * 2, Math.floor(index / ringCount), 0], offset)
      }
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3))
    geometry.setAttribute('aKind', new THREE.BufferAttribute(kinds, 1))
    const uniforms = {
      uTime: { value: 0 }, uFlow: { value: 0 }, uLevel: { value: 0 },
      uListen: { value: 0 }, uThink: { value: 0 }, uExecute: { value: 0 }, uSpeak: { value: 0 },
      uError: { value: 0 }, uScale: { value: 1 }
    }
    const material = new THREE.ShaderMaterial({
      vertexShader, fragmentShader, uniforms, transparent: true,
      // 透明曲面不写深度，背面不会遮黑正面；叠加能量在着色器中限制。
      depthWrite: false, blending: THREE.AdditiveBlending
    })
    const points = new THREE.Points(geometry, material)
    // 参数坐标不代表最终包围盒。
    points.frustumCulled = false
    group.add(points)

    let frame = 0
    let previousTime = performance.now()
    let lost = false
    let disposed = false
    const pointer = new THREE.Vector2()
    const draw = (now: number): void => {
      frame = 0
      if (disposed || lost || document.hidden) return
      const dt = Math.min(Math.max((now - previousTime) / 1000, 0), 0.05)
      previousTime = now
      const reduced = motion.matches
      const blend = reduced ? 1 : 1 - Math.exp(-dt * 5)
      const current = propsRef.current
      const levelTarget = Number.isFinite(current.level) ? Math.min(1, Math.max(0, current.level) / 0.42) : 0
      uniforms.uLevel.value += (levelTarget - uniforms.uLevel.value) * (1 - Math.exp(-dt * 10))
      uniforms.uListen.value += ((current.state === 'listening' ? 1 : 0) - uniforms.uListen.value) * blend
      uniforms.uThink.value += ((current.state === 'thinking' ? 1 : 0) - uniforms.uThink.value) * blend
      uniforms.uExecute.value += ((current.state === 'executing' ? 1 : 0) - uniforms.uExecute.value) * blend
      uniforms.uSpeak.value += ((current.state === 'speaking' ? 1 : 0) - uniforms.uSpeak.value) * blend
      uniforms.uError.value += ((current.state === 'error' ? 1 : 0) - uniforms.uError.value) * blend
      if (!reduced) {
        uniforms.uTime.value += dt
        // 积分速度，切换思考状态时轨道相位连续，不会突然跳位。
        uniforms.uFlow.value += dt * (0.7 + uniforms.uThink.value * 1.4 + uniforms.uExecute.value * 2.8 + uniforms.uSpeak.value * 0.3)
        group.rotation.x += (-0.18 + pointer.y * 0.13 - group.rotation.x) * blend
        group.rotation.y += (pointer.x * 0.18 - group.rotation.y) * blend
      }
      renderer.render(scene, camera)
      if (!reduced) frame = requestAnimationFrame(draw)
    }
    const refresh = (): void => {
      cancelAnimationFrame(frame)
      previousTime = performance.now() - 16
      draw(performance.now())
    }
    redrawRef.current = () => { if (motion.matches) refresh() }
    const resize = (): void => {
      const { width, height } = host.getBoundingClientRect()
      if (!width || !height) return
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      uniforms.uScale.value = renderer.getPixelRatio() * Math.min(width, height) / 480
      refresh()
    }
    const onPointer = (event: PointerEvent): void => {
      const bounds = host.getBoundingClientRect()
      pointer.set((event.clientX - bounds.left) / bounds.width - 0.5, (event.clientY - bounds.top) / bounds.height - 0.5)
    }
    const onLeave = (): void => { pointer.set(0, 0) }
    const onVisibility = (): void => {
      if (document.hidden) cancelAnimationFrame(frame)
      else refresh()
    }
    const onLost = (event: Event): void => {
      event.preventDefault()
      lost = true
      cancelAnimationFrame(frame)
      host.dataset.fallback = 'true'
    }
    const onRestored = (): void => { lost = false; delete host.dataset.fallback; resize() }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    motion.addEventListener('change', refresh)
    document.addEventListener('visibilitychange', onVisibility)
    host.addEventListener('pointermove', onPointer)
    host.addEventListener('pointerleave', onLeave)
    renderer.domElement.addEventListener('webglcontextlost', onLost)
    renderer.domElement.addEventListener('webglcontextrestored', onRestored)
    resize()

    return () => {
      disposed = true
      redrawRef.current = null
      cancelAnimationFrame(frame)
      observer.disconnect()
      motion.removeEventListener('change', refresh)
      document.removeEventListener('visibilitychange', onVisibility)
      host.removeEventListener('pointermove', onPointer)
      host.removeEventListener('pointerleave', onLeave)
      renderer.domElement.removeEventListener('webglcontextlost', onLost)
      renderer.domElement.removeEventListener('webglcontextrestored', onRestored)
      geometry.dispose()
      material.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])

  useEffect(() => { redrawRef.current?.() }, [state])

  return <div className="orb" ref={hostRef} data-state={state} aria-hidden="true">
    <span className="orb-fallback-label">Annie</span>
  </div>
}
