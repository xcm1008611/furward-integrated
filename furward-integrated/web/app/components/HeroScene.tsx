'use client';

/* eslint-disable @next/next/no-img-element -- The instant fallback intentionally shares the exact local texture URLs and proportions used by WebGL. */

import { useEffect, useRef } from 'react';
import type { BufferGeometry, Material, Mesh, Object3D, Texture, WebGLRenderer, WebGLRenderTarget } from 'three';
import type { ImageSlot } from '@/lib/content';
import styles from './HeroScene.module.css';

export type HeroSceneProps = {
  portrait?: ImageSlot;
  helmetImage?: ImageSlot;
  helmet: boolean;
  onReady?: (ready: boolean) => void;
};

const ORIGINAL_PORTRAIT = '/reference/hero-diffuse.webp';
const MODEL_IMAGES = new Set(['/reference/footer-helmet.webp', '/reference/portrait-helmet.webp']);
const expoInOut = (value: number) => value <= 0 ? 0 : value >= 1 ? 1 : value < .5 ? Math.pow(2, 20 * value - 10) / 2 : (2 - Math.pow(2, -20 * value + 10)) / 2;

const portraitVertex = /* glsl */`
  uniform sampler2D uDepth;
  uniform float uDepthAmount;
  uniform vec2 uCrop;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec3 displaced = position;
    displaced.z += texture2D(uDepth, uv + uCrop).r * uDepthAmount;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`;
const portraitFragment = /* glsl */`
  uniform sampler2D uImage;
  uniform sampler2D uAlpha;
  uniform sampler2D uShadow;
  uniform float uOriginal;
  uniform float uHelmet;
  uniform vec2 uCrop;
  varying vec2 vUv;
  void main() {
    vec2 imageUv = vUv + uCrop;
    if (imageUv.x < 0.0 || imageUv.x > 1.0 || imageUv.y < 0.0 || imageUv.y > 1.0) discard;
    vec4 colour = texture2D(uImage, imageUv);
    if (uOriginal > 0.5) {
      colour.rgb = mix(colour.rgb, texture2D(uShadow, imageUv).rgb, uHelmet);
      colour.a *= texture2D(uAlpha, imageUv).r;
    }
    if (colour.a < 0.01) discard;
    gl_FragColor = colour;
    #include <colorspace_fragment>
  }
`;
const revealUniforms = /* glsl */`
  uniform vec2 uHeroResolution;
  uniform float uHeroReveal;
  uniform vec3 uHeroTrail[8];
  float heroReveal() {
    vec2 screenUv = gl_FragCoord.xy / uHeroResolution;
    float curvedY = screenUv.y + sin(screenUv.x * 3.14159265) * sin(uHeroReveal * 3.14159265) * 0.2;
    float reveal = smoothstep(1.0 - uHeroReveal - 0.008, 1.0 - uHeroReveal + 0.008, curvedY);
    if (uHeroReveal < 0.001) reveal = 0.0;
    if (uHeroReveal > 0.999) reveal = 1.0;
    for (int i = 0; i < 8; i++) {
      vec2 offset = screenUv - uHeroTrail[i].xy;
      offset.x *= uHeroResolution.x / uHeroResolution.y;
      float spot = (1.0 - smoothstep(0.015, 0.105, length(offset))) * uHeroTrail[i].z;
      reveal = max(reveal, spot);
    }
    return reveal;
  }
`;

/** A depth-displaced photograph and the reference's real, locally hosted helmet.
 * The fallback remains visible until the first complete WebGL frame is painted.
 */
export default function HeroScene({ portrait, helmetImage, helmet, onReady }: HeroSceneProps) {
  const host = useRef<HTMLDivElement>(null);
  const invalidate = useRef<(() => void) | null>(null);
  const latest = useRef({ helmet, onReady, portrait, helmetImage });
  useEffect(() => { latest.current = { helmet, onReady, portrait, helmetImage }; invalidate.current?.(); }, [helmet, onReady, portrait, helmetImage]);
  const portraitSrc = portrait?.src ?? ORIGINAL_PORTRAIT;
  const helmetSrc = helmetImage?.src ?? '/reference/footer-helmet.webp';
  const original = portraitSrc === ORIGINAL_PORTRAIT;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    let frame = 0;
    let renderer: WebGLRenderer | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let intersectionObserver: IntersectionObserver | undefined;
    let destroyDraco: (() => void) | undefined;
    let removeListeners = () => {};
    const textures = new Set<Texture>();
    const materials = new Set<Material>();
    const geometries = new Set<BufferGeometry>();
    const renderTargets = new Set<WebGLRenderTarget>();
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    element.dataset.status = 'loading';
    latest.current.onReady?.(false);
    // Loading or disabled WebGL must never leave the page behind a loader.
    const readyTimeout = window.setTimeout(() => { if (!disposed) latest.current.onReady?.(true); }, 9000);

    const disposeObject = (object: Object3D) => {
      object.traverse(child => {
        const mesh = child as Mesh;
        if (mesh.geometry) geometries.add(mesh.geometry);
        if (mesh.material) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
      });
    };
    const ensureAlive = () => { if (disposed) throw new DOMException('Scene unmounted', 'AbortError'); };

    async function start() {
      const THREE = await import('three');
      ensureAlive();
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
      renderer.setClearColor(0x000000, 0);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.15;
      renderer.autoClear = false;
      renderer.domElement.className = styles.canvas;
      renderer.domElement.setAttribute('aria-hidden', 'true');
      element!.appendChild(renderer.domElement);

      const portraitScene = new THREE.Scene();
      const helmetScene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(15, 1, .1, 1000);
      const pointer = new THREE.Vector2();
      const easedPointer = new THREE.Vector2();
      const trail = Array.from({ length: 8 }, () => new THREE.Vector3(-5, -5, 0));
      const reveal = { value: latest.current.helmet ? 1 : 0 };
      const resolution = { value: new THREE.Vector2(1, 1) };
      const revealState = { from: reveal.value, to: reveal.value, started: performance.now(), duration: 1500 };
      const loader = new THREE.TextureLoader();
      let visible = true;
      let contextUnavailable = false;
      let reduced = mediaQuery.matches;
      let bounds = element!.getBoundingClientRect();
      let layoutWidth = element!.clientWidth;
      let trailIndex = 0;
      let lastTrailAt = 0;
      let lastTime = performance.now();

      const loadTexture = async (src: string, colour = false, model = false) => {
        const texture = await loader.loadAsync(src);
        if (disposed) { texture.dispose(); ensureAlive(); }
        texture.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        texture.flipY = !model;
        texture.anisotropy = Math.min(renderer!.capabilities.getMaxAnisotropy(), 8);
        textures.add(texture);
        return texture;
      };
      const imagePromise = loadTexture(portraitSrc, true);
      const [imageTexture, alphaTexture, depthTexture, shadowTexture] = await Promise.all([
        imagePromise,
        original ? loadTexture('/reference/hero-alpha.webp') : imagePromise,
        original ? loadTexture('/reference/hero-depth.webp') : imagePromise,
        original ? loadTexture('/reference-motion/head-shadow.webp', true).catch(() => imagePromise) : imagePromise,
      ]);
      ensureAlive();
      const portraitMaterial = new THREE.ShaderMaterial({
        uniforms: {
          uImage: { value: imageTexture }, uAlpha: { value: alphaTexture }, uDepth: { value: depthTexture },
          uShadow: { value: shadowTexture }, uOriginal: { value: original ? 1 : 0 },
          uDepthAmount: { value: original ? .25 : 0 }, uHelmet: reveal, uCrop: { value: new THREE.Vector2() },
        },
        vertexShader: portraitVertex, fragmentShader: portraitFragment,
        transparent: true, depthWrite: true, toneMapped: false,
      });
      materials.add(portraitMaterial);
      const portraitGeometry = new THREE.PlaneGeometry(1, 1, original ? 128 : 1, original ? 128 : 1);
      geometries.add(portraitGeometry);
      const portraitMesh = new THREE.Mesh(portraitGeometry, portraitMaterial);
      portraitScene.add(portraitMesh);
      const helmetGroup = new THREE.Group();
      helmetScene.add(helmetGroup);

      const addReveal = (material: Material) => {
        material.transparent = true;
        material.onBeforeCompile = shader => {
          shader.uniforms.uHeroResolution = resolution;
          shader.uniforms.uHeroReveal = reveal;
          shader.uniforms.uHeroTrail = { value: trail };
          shader.fragmentShader = revealUniforms + shader.fragmentShader;
          shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', `
            diffuseColor.a *= heroReveal();
            if (diffuseColor.a < 0.005) discard;
            #include <alphatest_fragment>
          `);
        };
        material.customProgramCacheKey = () => 'lando-hero-arc-and-trail-v1';
        materials.add(material);
      };

      let isModel = MODEL_IMAGES.has(helmetSrc);
      const loadHelmetPlane = async () => {
        const texture = await loadTexture(helmetSrc, true);
        ensureAlive();
        const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false, side: THREE.DoubleSide });
        addReveal(material);
        const geometry = new THREE.PlaneGeometry(1, 1);
        geometries.add(geometry);
        const mesh = new THREE.Mesh(geometry, material);
        const dimensions = texture.image as { width: number; height: number };
        const ratio = dimensions.width / dimensions.height;
        mesh.scale.set(Math.min(ratio, 1), Math.min(1 / ratio, 1), 1);
        helmetGroup.add(mesh);
        isModel = false;
      };
      if (isModel) {
        try {
          const [{ GLTFLoader }, { DRACOLoader }, { HDRLoader }] = await Promise.all([
            import('three/examples/jsm/loaders/GLTFLoader.js'),
            import('three/examples/jsm/loaders/DRACOLoader.js'),
            import('three/examples/jsm/loaders/HDRLoader.js'),
          ]);
          ensureAlive();
          const draco = new DRACOLoader().setDecoderPath('/reference-motion/draco/');
          draco.setWorkerLimit(1);
          destroyDraco = () => draco.dispose();
          const gltfLoader = new GLTFLoader().setDRACOLoader(draco);
          const [gltf, base, normal, roughness, metalness, glassBase, glassNormal, glassRoughness, matcap] = await Promise.all([
            gltfLoader.loadAsync('/reference-motion/helmet.glb').then(gltf => {
              disposeObject(gltf.scene);
              if (disposed) {
                for (const geometry of geometries) geometry.dispose();
                for (const material of materials) material.dispose();
                ensureAlive();
              }
              return gltf;
            }),
            loadTexture('/reference-motion/helmet-lime.webp', true, true),
            loadTexture('/reference-motion/helmet-normal.webp', false, true),
            loadTexture('/reference-motion/helmet-roughness.webp', false, true),
            loadTexture('/reference-motion/helmet-metallic.webp', false, true),
            loadTexture('/reference-motion/glass-base.webp', true, true),
            loadTexture('/reference-motion/glass-normal.webp', false, true),
            loadTexture('/reference-motion/glass-roughness.webp', false, true),
            loadTexture('/reference-motion/plastic-matcap.webp', true, true),
          ]);
          if (disposed) { disposeObject(gltf.scene); for (const geometry of geometries) geometry.dispose(); for (const material of materials) material.dispose(); ensureAlive(); }
          const shell = new THREE.MeshPhysicalMaterial({ map: base, normalMap: normal, roughnessMap: roughness, metalnessMap: metalness, metalness: 1, roughness: .12, envMapIntensity: 2.1, clearcoat: .5, clearcoatRoughness: .2 });
          const visor = new THREE.MeshPhysicalMaterial({ map: glassBase, normalMap: glassNormal, roughnessMap: glassRoughness, metalnessMap: metalness, metalness: 1, roughness: .2, envMapIntensity: 1.5, clearcoat: 1 });
          const plastic = new THREE.MeshMatcapMaterial({ matcap, color: 0x34382c, opacity: .45, side: THREE.DoubleSide });
          for (const material of [shell, visor, plastic]) addReveal(material);
          gltf.scene.traverse(child => {
            const mesh = child as Mesh;
            if (!mesh.isMesh) return;
            geometries.add(mesh.geometry);
            for (const old of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) old.dispose();
            mesh.material = mesh.name === 'glass' ? visor : mesh.name === 'plastic' ? plastic : shell;
            mesh.frustumCulled = false;
          });
          gltf.scene.scale.set(6.9, 6.9, 7.1);
          helmetGroup.add(gltf.scene);
          const hemisphere = new THREE.HemisphereLight(0xffffff, 0x656950, 2);
          const key = new THREE.DirectionalLight(0xffffff, 2.3); key.position.set(-2, 3, 5);
          const fill = new THREE.DirectionalLight(0xd6e6ff, 1.5); fill.position.set(3, 1, 3);
          helmetScene.add(hemisphere, key, fill);
          // A real HDR studio environment gives the visor and curved shell their reflections.
          try {
            const hdr = await new HDRLoader().loadAsync('/reference-motion/hdr-light.hdr');
            if (disposed) { hdr.dispose(); ensureAlive(); }
            const generator = new THREE.PMREMGenerator(renderer!);
            const environment = generator.fromEquirectangular(hdr);
            renderTargets.add(environment);
            helmetScene.environment = environment.texture;
            hdr.dispose(); generator.dispose();
          } catch (error) { if (disposed) throw error; /* Directional lighting remains a usable fallback. */ }
          draco.dispose(); destroyDraco = undefined;
        } catch (error) {
          if (disposed) throw error;
          destroyDraco?.(); destroyDraco = undefined;
          console.warn('3D helmet unavailable; using the selected image.', error);
          helmetGroup.clear();
          await loadHelmetPlane();
        }
      } else await loadHelmetPlane();
      ensureAlive();

      const resize = () => {
        if (disposed || !renderer) return;
        bounds = element!.getBoundingClientRect();
        // ScrollTrigger scales/translates the parent into the following section.
        // Keep the drawing buffer tied to layout dimensions, not transformed bounds.
        const width = Math.max(1, element!.clientWidth), height = Math.max(1, element!.clientHeight);
        layoutWidth = width;
        const mobile = width <= 700;
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 1.75));
        renderer.setSize(width, height, false);
        renderer.getDrawingBufferSize(resolution.value);
        camera.aspect = width / height;
        camera.position.z = mobile ? 3.75 : 3;
        camera.updateProjectionMatrix();
        portraitMesh.position.y = mobile ? -.05 : 0;
        helmetGroup.position.y = isModel ? mobile ? 0 : .05 : mobile ? -.05 : 0;
        if (!original) {
          const dimensions = imageTexture.image as { width: number; height: number };
          const ratio = dimensions.width / dimensions.height;
          const viewportHeight = 2 * Math.tan(THREE.MathUtils.degToRad(7.5)) * camera.position.z;
          const fitHeight = Math.min(viewportHeight, viewportHeight * camera.aspect / ratio);
          portraitMesh.scale.set(fitHeight * ratio, fitHeight, 1);
          portraitMesh.position.y = 0;
        }
        schedule();
      };
      const onPointerMove = (event: PointerEvent) => {
        if (reduced || !visible || event.pointerType === 'touch') return;
        bounds = element!.getBoundingClientRect();
        const x = (event.clientX - bounds.left) / bounds.width;
        const y = (event.clientY - bounds.top) / bounds.height;
        if (x < 0 || x > 1 || y < 0 || y > 1) { pointer.set(0, 0); schedule(); return; }
        pointer.set((x - .5) * 2, (y - .5) * 2);
        if (performance.now() - lastTrailAt > 42 && y > .13 && y < .88 && x > .2 && x < .8) {
          trail[trailIndex].set(x, 1 - y, .95);
          trailIndex = (trailIndex + 1) % trail.length;
          lastTrailAt = performance.now();
        }
        schedule();
      };
      const resetPointer = () => { pointer.set(0, 0); schedule(); };
      const onReduced = () => { reduced = mediaQuery.matches; if (reduced) { pointer.set(0, 0); for (const point of trail) point.z = 0; } schedule(); };
      const onVisibility = () => { if (document.hidden) { cancelAnimationFrame(frame); frame = 0; } else schedule(); };
      const contextLost = (event: Event) => {
        event.preventDefault();
        contextUnavailable = true;
        element!.dataset.status = 'fallback';
        cancelAnimationFrame(frame); frame = 0;
        latest.current.onReady?.(true);
      };
      const contextRestored = () => { contextUnavailable = false; element!.dataset.status = 'ready'; schedule(); };
      function schedule() {
        if (!disposed && !contextUnavailable && !frame && visible && !document.hidden) frame = requestAnimationFrame(draw);
      }
      function draw(time: number) {
        frame = 0;
        if (disposed || !renderer) return;
        const delta = Math.min((time - lastTime) / 1000, .05); lastTime = time;
        const target = latest.current.helmet ? 1 : 0;
        if (target !== revealState.to) {
          revealState.from = reveal.value; revealState.to = target; revealState.started = time;
          revealState.duration = target ? 1500 : 1000;
        }
        const progress = reduced ? 1 : Math.min((time - revealState.started) / revealState.duration, 1);
        reveal.value = THREE.MathUtils.lerp(revealState.from, revealState.to, expoInOut(progress));
        easedPointer.lerp(pointer, reduced ? 1 : 1 - Math.exp(-4.5 * delta));
        const motionX = reduced ? 0 : easedPointer.x, motionY = reduced ? 0 : easedPointer.y;
        portraitMesh.rotation.set(-motionY * .075, motionX * .075, 0);
        helmetGroup.rotation.set((isModel ? Math.PI * .06 : 0) - motionY * .05, motionX * .05, 0);
        if (!isModel) {
          helmetGroup.position.x = ((latest.current.helmetImage?.positionX ?? 50) - 50) * .0015;
          helmetGroup.position.y = (layoutWidth <= 700 ? -.05 : 0) - ((latest.current.helmetImage?.positionY ?? 50) - 50) * .0015;
        }
        camera.position.x = motionX * .02; camera.position.y = -motionY * .02;
        const crop = latest.current.portrait;
        portraitMaterial.uniforms.uCrop.value.set(((crop?.positionX ?? 50) - 50) * .002, -((crop?.positionY ?? 50) - 50) * .002);
        for (const point of trail) point.z = Math.max(0, point.z - delta * .85);
        renderer.clear();
        renderer.render(portraitScene, camera);
        renderer.clearDepth();
        renderer.render(helmetScene, camera);
        // Keep drawing only while this hero is on screen; no animation runs below the fold.
        if (!reduced) schedule();
      }
      invalidate.current = schedule;
      // The transparent scene wrapper cannot receive pointer events. Listening to
      // the window also preserves tracking as this same canvas moves between sections.
      window.addEventListener('pointermove', onPointerMove, { passive: true });
      window.addEventListener('blur', resetPointer);
      mediaQuery.addEventListener('change', onReduced);
      document.addEventListener('visibilitychange', onVisibility);
      renderer.domElement.addEventListener('webglcontextlost', contextLost);
      renderer.domElement.addEventListener('webglcontextrestored', contextRestored);
      removeListeners = () => {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('blur', resetPointer);
        mediaQuery.removeEventListener('change', onReduced);
        document.removeEventListener('visibilitychange', onVisibility);
        renderer?.domElement.removeEventListener('webglcontextlost', contextLost);
        renderer?.domElement.removeEventListener('webglcontextrestored', contextRestored);
      };
      resizeObserver = new ResizeObserver(resize); resizeObserver.observe(element!);
      intersectionObserver = new IntersectionObserver(entries => {
        visible = entries[0]?.isIntersecting ?? true;
        if (visible) schedule(); else { cancelAnimationFrame(frame); frame = 0; }
      }, { rootMargin: '80px' });
      intersectionObserver.observe(element!);
      resize();
      cancelAnimationFrame(frame); frame = 0;
      draw(performance.now());
      element!.dataset.status = 'ready';
      element!.dataset.renderer = isModel ? 'depth-portrait-and-gltf' : 'depth-portrait-and-image';
      window.clearTimeout(readyTimeout);
      latest.current.onReady?.(true);
    }

    start().catch(error => {
      if (disposed) return;
      console.warn('Hero WebGL unavailable; showing the selected photographs.', error);
      element.dataset.status = 'fallback';
      window.clearTimeout(readyTimeout);
      latest.current.onReady?.(true);
    });
    return () => {
      disposed = true;
      invalidate.current = null;
      window.clearTimeout(readyTimeout);
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect(); intersectionObserver?.disconnect();
      removeListeners(); destroyDraco?.();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      for (const texture of textures) texture.dispose();
      for (const target of renderTargets) target.dispose();
      renderer?.dispose(); renderer?.forceContextLoss(); renderer?.domElement.remove();
    };
  }, [portraitSrc, helmetSrc, original]);

  return <div ref={host} className={styles.root} data-helmet={helmet} aria-hidden="true">
    <div className={styles.fallback}>
      <img src={portraitSrc} alt="" className={`${styles.portrait} ${original ? styles.original : styles.custom}`} style={{ objectPosition: `${portrait?.positionX ?? 50}% ${portrait?.positionY ?? 50}%` }} decoding="async" fetchPriority="high" />
      <img src={helmetSrc} alt="" className={styles.helmet} style={{ objectPosition: `${helmetImage?.positionX ?? 50}% ${helmetImage?.positionY ?? 50}%` }} decoding="async" />
    </div>
  </div>;
}
