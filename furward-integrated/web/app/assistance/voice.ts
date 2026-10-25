'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type RecognitionResult = { isFinal: boolean; 0: { transcript: string } };
type RecognitionEvent = { resultIndex: number; results: ArrayLike<RecognitionResult> };
type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type RecognitionConstructor = new () => Recognition;

const ERRORS: Record<string, string> = {
  'not-allowed': '没有获得麦克风权限。请在浏览器设置中允许麦克风，或使用下方输入框和输入法的语音键。',
  'service-not-allowed': '浏览器暂不允许语音识别。请使用下方输入框和输入法的语音键。',
  'no-speech': '没有听到声音，请靠近手机再说一次。',
  'audio-capture': '没有找到可用的麦克风。',
  network: '语音识别需要联网，请检查网络后再试。',
};

export type VoiceSupport = 'checking' | 'ready' | 'insecure' | 'unsupported';

/** Browser speech recognition; microphones are only exposed on HTTPS or localhost. */
export function useVoiceInput(onFinal: (text: string) => void) {
  const [support, setSupport] = useState<VoiceSupport>('checking');
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState('');
  const recognition = useRef<Recognition | null>(null);
  const finalRef = useRef(onFinal);
  useEffect(() => { finalRef.current = onFinal; }, [onFinal]);

  useEffect(() => {
    const scope = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
    const Constructor = scope.SpeechRecognition || scope.webkitSpeechRecognition;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Browser capability is only known after mount.
    setSupport(!window.isSecureContext ? 'insecure' : Constructor ? 'ready' : 'unsupported');
    return () => recognition.current?.abort();
  }, []);

  const start = useCallback(() => {
    const scope = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
    const Constructor = scope.SpeechRecognition || scope.webkitSpeechRecognition;
    if (!Constructor || listening) return;
    const instance = new Constructor();
    instance.lang = 'zh-CN';
    instance.interimResults = true;
    instance.continuous = false;
    instance.maxAlternatives = 1;
    let delivered = false;
    instance.onresult = event => {
      let text = '';
      let final = false;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        text += event.results[i][0].transcript;
        final ||= event.results[i].isFinal;
      }
      setInterim(text);
      if (final && text.trim() && !delivered) { delivered = true; finalRef.current(text.trim()); }
    };
    instance.onerror = event => { if (event.error !== 'aborted') setError(ERRORS[event.error] || '语音识别没有成功，请再试一次。'); };
    instance.onend = () => { setListening(false); recognition.current = null; };
    recognition.current = instance;
    setError('');
    setInterim('');
    try {
      instance.start();
      setListening(true);
    } catch {
      setError('语音识别没有启动，请再试一次。');
      recognition.current = null;
    }
  }, [listening]);

  const stop = useCallback(() => recognition.current?.stop(), []);

  return { support, listening, interim, error, start, stop };
}
