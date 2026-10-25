type SpeechDriver = Pick<SpeechSynthesis, 'cancel' | 'getVoices' | 'speak'>;

/** Browser speech can exist yet fail because its voice or audio device is unavailable. */
export function createSpeechPlayer(
  synthesis: SpeechDriver,
  makeUtterance: (message: string) => SpeechSynthesisUtterance,
  onFailure: () => void,
  getRate: () => number = () => 0.95,
) {
  let generation = 0;

  const stop = () => {
    generation += 1;
    try { synthesis.cancel(); } catch { /* Turning speech off must remain possible. */ }
  };

  const fail = (request: number) => {
    if (request !== generation) return;
    stop();
    onFailure();
  };

  const speak = (message: string) => {
    const request = ++generation;
    try {
      synthesis.cancel();
      const utterance = makeUtterance(message);
      utterance.lang = 'zh-CN';
      utterance.rate = getRate();
      const voice = synthesis.getVoices().find(item => item.lang.toLowerCase().startsWith('zh'));
      if (voice) utterance.voice = voice;
      utterance.onerror = event => {
        if (event.error !== 'canceled' && event.error !== 'interrupted') fail(request);
      };
      synthesis.speak(utterance);
    } catch {
      fail(request);
    }
  };

  return { speak, stop };
}
