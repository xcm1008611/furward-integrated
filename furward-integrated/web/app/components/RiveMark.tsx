"use client";

import { useEffect, useRef, useState } from "react";
import type { Rive, StateMachineInput } from "@rive-app/canvas";

export type RiveMarkProps = {
  src: string;
  artboard?: string;
  stateMachine?: string;
  className?: string;
  scroll?: boolean;
  /** A named boolean input provided by the original Rive file. */
  colorInput?: string;
  /** A named boolean circuit input, such as "austin" or "monaco". */
  trackInput?: string;
};

/** Plays the original vector animation, with optional scroll-driven drawing. */
export default function RiveMark({ src, artboard, stateMachine, className = "", scroll = false, colorInput, trackInput }: RiveMarkProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [aspectRatio, setAspectRatio] = useState("3 / 1");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    let cancelled = false;
    let instance: Rive | undefined;
    let scrollInput: StateMachineInput | undefined;
    let loaded = false;
    let visible = false;
    let frame = 0;
    let pauseTimer: ReturnType<typeof setTimeout> | undefined;
    let progress = 0;
    let targetProgress = 0;
    let activeMachine = stateMachine;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    setStatus("loading");

    const cancelPause = () => {
      if (pauseTimer !== undefined) clearTimeout(pauseTimer);
      pauseTimer = undefined;
    };
    const pauseAfterPaint = () => {
      cancelPause();
      // Let the state machine evaluate the endpoint before freezing its frame.
      pauseTimer = setTimeout(() => { instance?.pause(); }, 120);
    };
    const documentVisible = () => document.visibilityState !== "hidden";
    const play = () => {
      if (!instance || !loaded) return;
      if (!instance.isPlaying) instance.play(activeMachine);
    };

    const readProgress = () => {
      const bounds = container.getBoundingClientRect();
      const viewport = window.innerHeight;
      // Original range: top bottom -> bottom top; numeric Rive input 0..1000.
      return Math.min(1, Math.max(0, (viewport - bounds.top) / (viewport + bounds.height)));
    };

    const updateScroll = () => {
      frame = 0;
      if (cancelled || !loaded || !scrollInput) return;
      targetProgress = media.matches ? 1 : readProgress();
      progress = media.matches ? targetProgress : progress + (targetProgress - progress) * 0.16;
      if (Math.abs(targetProgress - progress) < 0.0005) progress = targetProgress;
      scrollInput.value = progress * 1000;

      if (!visible || !documentVisible()) {
        instance?.pause();
        return;
      }
      cancelPause();
      play();
      if (media.matches || progress === targetProgress) pauseAfterPaint();
      else if (progress !== targetProgress) frame = requestAnimationFrame(updateScroll);
    };

    const requestScrollFrame = () => {
      if (!frame && loaded && scrollInput) frame = requestAnimationFrame(updateScroll);
    };

    const syncPlayback = () => {
      if (!loaded || !instance) return;
      cancelPause();
      if (!visible || !documentVisible()) {
        instance.pause();
        return;
      }
      if (scroll && scrollInput) {
        requestScrollFrame();
      } else {
        play();
        if (media.matches) pauseAfterPaint();
      }
    };

    const resize = () => {
      if (!loaded || !instance || cancelled) return;
      instance.resizeDrawingSurfaceToCanvas(Math.min(window.devicePixelRatio || 1, 2));
      if (scroll) requestScrollFrame();
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    const visibilityObserver = new IntersectionObserver(entries => {
      visible = entries[0]?.isIntersecting ?? false;
      syncPlayback();
    }, { threshold: 0, rootMargin: "0px 0px -5% 0px" });
    visibilityObserver.observe(container);
    document.addEventListener("visibilitychange", syncPlayback);
    media.addEventListener("change", syncPlayback);
    window.addEventListener("resize", resize, { passive: true });
    if (scroll) window.addEventListener("scroll", requestScrollFrame, { passive: true });

    void import("@rive-app/canvas").then(runtime => {
      if (cancelled) return;
      runtime.RuntimeLoader.setWasmUrl("/reference-motion/rive/runtime.wasm");
      instance = new runtime.Rive({
        src,
        canvas,
        artboard,
        stateMachine,
        autoplay: false,
        shouldDisableRiveListeners: true,
        layout: new runtime.Layout({ fit: runtime.Fit.Contain, alignment: runtime.Alignment.Center }),
        onLoad: () => {
          if (cancelled || !instance) return;
          loaded = true;
          activeMachine = stateMachine || instance.stateMachineNames[0];
          const inputs = (activeMachine ? instance.stateMachineInputs(activeMachine) : []) ?? [];
          scrollInput = inputs.find(input => input.name === "scroll");
          const chosenColor = colorInput || (src.includes("signature") ? "color_lime" : undefined);
          if (chosenColor) {
            inputs.filter(input => input.name.startsWith("color_") && input.type === runtime.StateMachineInputType.Boolean)
              .forEach(input => { input.value = input.name === chosenColor; });
          }
          if (trackInput) {
            const circuit = inputs.find(input => input.name === trackInput && input.type === runtime.StateMachineInputType.Boolean);
            if (circuit) circuit.value = true;
            else console.warn(`Rive circuit input was not found: ${trackInput}`);
          }
          const startInput = inputs.find(input => input.name === "play");
          if (startInput?.type === runtime.StateMachineInputType.Boolean) startInput.value = true;
          const bounds = instance.bounds;
          const width = bounds.maxX - bounds.minX;
          const height = bounds.maxY - bounds.minY;
          if (width > 0 && height > 0) setAspectRatio(`${width} / ${height}`);
          progress = media.matches ? 1 : readProgress();
          if (scrollInput && scroll) scrollInput.value = progress * 1000;
          resize();
          setStatus("ready");
          syncPlayback();
        },
        onLoadError: () => {
          if (!cancelled) setStatus("error");
          console.warn(`Rive asset could not be loaded: ${src}`);
        },
      });
    }).catch(error => {
      if (!cancelled) setStatus("error");
      console.warn("Rive renderer could not be initialized", error);
    });

    return () => {
      cancelled = true;
      cancelPause();
      if (frame) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      document.removeEventListener("visibilitychange", syncPlayback);
      media.removeEventListener("change", syncPlayback);
      window.removeEventListener("resize", resize);
      if (scroll) window.removeEventListener("scroll", requestScrollFrame);
      instance?.cleanup();
    };
  }, [src, artboard, stateMachine, scroll, colorInput, trackInput]);

  return <div ref={containerRef} className={className} data-rive-state={status} aria-hidden="true" style={{ position: "relative", width: "100%", aspectRatio, minHeight: 36 }}>
    <canvas ref={canvasRef} style={{ display: "block", position: "absolute", inset: 0, width: "100%", height: "100%" }} />
  </div>;
}
