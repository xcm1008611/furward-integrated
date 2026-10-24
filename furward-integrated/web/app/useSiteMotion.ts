'use client';
import { useEffect, type RefObject } from 'react';

export function useSiteMotion(root: RefObject<HTMLElement | null>, revision: unknown) {
  useEffect(() => {
    let disposed = false;
    let clean = () => {};
    Promise.all([import('gsap'), import('gsap/ScrollTrigger'), import('lenis')]).then(([{ gsap }, { ScrollTrigger }, { default: Lenis }]) => {
      if (disposed || !root.current) return;
      gsap.registerPlugin(ScrollTrigger);
      const element = root.current;
      const media = gsap.matchMedia();
      let lenis: InstanceType<typeof Lenis> | undefined;
      let ticker: ((time: number) => void) | undefined;
      media.add('(prefers-reduced-motion: no-preference)', () => {
        const ctx = gsap.context(() => {
          element.classList.add('motion-active');
          const has = (selector:string) => Boolean(element.querySelector(selector));
          const hero=element.querySelector<HTMLElement>('.hero');
          if(hero) {
            gsap.to('.fw-hero-scene',{yPercent:12,scale:1.06,opacity:.1,ease:'none',scrollTrigger:{trigger:hero,start:'top top',end:'bottom top',scrub:.6}});
            gsap.to('.fw-hero-copy,.fw-hero-side',{y:-45,opacity:0,ease:'none',scrollTrigger:{trigger:hero,start:'top top',end:'65% top',scrub:.5}});
          }
          if (has('.shop-section')) gsap.fromTo('.shop-section',{clipPath:'ellipse(100% 5% at 50% 0%)'},{clipPath:'ellipse(130% 140% at 50% 0%)',ease:'none',scrollTrigger:{trigger:'.shop-section',start:'top bottom',end:'top 10%',scrub:.7}});
          if (has('.hero-brand,.hero-bottom')) gsap.from('.hero-brand,.hero-bottom', { y: 18, opacity: 0, duration: 1.1, stagger: .08, ease: 'expo.out', clearProps: 'transform,opacity' });
          if (has('.hero .contours')) gsap.to('.hero .contours', { yPercent: 12, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true }});
          if (has('.message-line-one')) gsap.fromTo('.message-line-one', {xPercent: -12}, {xPercent: 10, ease:'none', scrollTrigger:{trigger:'.message-section',start:'top bottom',end:'bottom top',scrub:1}});
          if (has('.message-line-two')) gsap.fromTo('.message-line-two', {xPercent: 10}, {xPercent: -12, ease:'none', scrollTrigger:{trigger:'.message-section',start:'top bottom',end:'bottom top',scrub:1}});
          if (has('.fw-message-mark')) gsap.from('.fw-message-mark',{scale:.55,rotation:-18,opacity:0,duration:1.2,ease:'expo.out',scrollTrigger:{trigger:'.message-section',start:'top 65%',once:true}});
          if (has('.manifesto-word')) gsap.from('.manifesto-word', {opacity:.28,yPercent:35,stagger:.035,duration:.6,ease:'power3.out',scrollTrigger:{trigger:'.manifesto-copy',start:'top 80%',end:'bottom 80%',scrub:.6}});
          gsap.utils.toArray<HTMLElement>('[data-reveal]').forEach(item => {
            gsap.from(item, { y: 36, opacity: 0, duration:.85, ease:'power3.out', scrollTrigger:{trigger:item,start:'top 93%',once:true}, clearProps:'transform,opacity' });
          });
          if (has('.track-person-on')) gsap.fromTo('.track-person-on',{xPercent:-22},{xPercent:0,ease:'none',scrollTrigger:{trigger:'.track-section',start:'top bottom',end:'center center',scrub:1}});
          if (has('.track-person-off')) gsap.fromTo('.track-person-off',{xPercent:22},{xPercent:0,ease:'none',scrollTrigger:{trigger:'.track-section',start:'top bottom',end:'center center',scrub:1}});
          if (has('.track-copy-on')) gsap.fromTo('.track-copy-on',{xPercent:-15},{xPercent:0,ease:'none',scrollTrigger:{trigger:'.track-section',start:'top bottom',end:'center center',scrub:1}});
          if (has('.track-copy-off')) gsap.fromTo('.track-copy-off',{xPercent:15},{xPercent:0,ease:'none',scrollTrigger:{trigger:'.track-section',start:'top bottom',end:'center center',scrub:1}});
          if (has('.helmet-window-frame')) gsap.fromTo('.helmet-window-frame',{clipPath:'inset(15% 22% 15% 22% round 35%)',scale:.92},{clipPath:'inset(0% 0% 0% 0% round 0%)',scale:1,ease:'none',scrollTrigger:{trigger:'.helmet-window',start:'top 80%',end:'center center',scrub:.6}});
          gsap.utils.toArray<HTMLElement>('.helmet-card').forEach((card,i) => gsap.fromTo(card,{y:(i%4)*45},{y:0,ease:'none',scrollTrigger:{trigger:'.helmet-grid',start:'top bottom',end:'bottom top',scrub:1}}));
          gsap.utils.toArray<HTMLElement>('.shop-photo').forEach((photo,i)=>gsap.fromTo(photo,{y:50+i*20,rotation:i%2?-7:7},{y:-50,rotation:i%2?3:-3,ease:'none',scrollTrigger:{trigger:'.shop-section',start:'top bottom',end:'bottom top',scrub:1}}));
          gsap.utils.toArray<HTMLElement>('.social-card').forEach((card,i,all)=>gsap.fromTo(card,{rotation:0,x:0,y:80},{rotation:(i-(all.length-1)/2)*10,x:(i-(all.length-1)/2)*16,y:Math.abs(i-(all.length-1)/2)*22,ease:'power2.out',scrollTrigger:{trigger:'.social-fan',start:'top 90%',end:'top 35%',scrub:.6}}));
          if (has('.footer-helmet')) gsap.fromTo('.footer-helmet',{y:100,rotation:-18},{y:0,rotation:0,ease:'none',scrollTrigger:{trigger:'.site-footer',start:'top bottom',end:'bottom bottom',scrub:1}});
        }, element);
        if(window.matchMedia('(pointer:fine)').matches) {
          lenis = new Lenis({lerp:.12, smoothWheel:true, anchors:true, prevent:node=>Boolean(node.closest('.menu-panel,.helmet-modal,[data-lenis-prevent]'))});
          lenis.on('scroll', ScrollTrigger.update);
          ticker = time => lenis?.raf(time*1000);
          gsap.ticker.add(ticker);
        }
        return () => {element.classList.remove('motion-active');ctx.revert(); if(ticker)gsap.ticker.remove(ticker);lenis?.destroy();};
      });
      media.add('(min-width: 1001px) and (prefers-reduced-motion: no-preference)', () => {
        const track = element.querySelector<HTMLElement>('.story-track');
        const container = element.querySelector<HTMLElement>('.story-section');
        if (!track || !container) return;
        const tween = gsap.to(track,{x:()=>-Math.max(0,track.scrollWidth-window.innerWidth),ease:'none',scrollTrigger:{trigger:container,start:'top top',end:'bottom bottom',scrub:1,invalidateOnRefresh:true}});
        return () => {tween.scrollTrigger?.kill();tween.kill();gsap.set(track,{clearProps:'transform'});};
      });
      const refresh = () => {if(!disposed)ScrollTrigger.refresh();};
      document.fonts.ready.then(refresh);
      const images = [...element.querySelectorAll('img')];
      images.forEach(img=>{if(!img.complete)img.addEventListener('load',refresh,{once:true});});
      const timer=window.setTimeout(refresh,350);
      clean=()=>{clearTimeout(timer);images.forEach(img=>img.removeEventListener('load',refresh));media.revert();};
    }).catch(()=>{/* The complete static page remains available if an optional motion module cannot load. */});
    return ()=>{disposed=true;clean();};
  },[root,revision]);
}
