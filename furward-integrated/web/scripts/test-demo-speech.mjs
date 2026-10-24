import assert from 'node:assert/strict';
import test from 'node:test';
import { createSpeechPlayer } from '../app/experience/speech.ts';

function setup() {
  const utterances = [];
  const voices = [{ lang: 'en-US' }, { lang: 'zh-CN' }];
  let failures = 0;
  let cancellations = 0;
  const driver = {
    cancel() { cancellations += 1; },
    getVoices() { return voices; },
    speak(utterance) { utterances.push(utterance); },
  };
  const player = createSpeechPlayer(driver, text => ({ text }), () => { failures += 1; });
  return { player, driver, utterances, voices, get failures() { return failures; }, get cancellations() { return cancellations; } };
}

test('normal speech selects Chinese and keeps the requested text', () => {
  const rig = setup();
  rig.player.speak('已停下');
  assert.equal(rig.utterances[0].text, '已停下');
  assert.equal(rig.utterances[0].lang, 'zh-CN');
  assert.equal(rig.utterances[0].voice, rig.voices[1]);
  assert.equal(rig.failures, 0);
});

test('voice/audio failures notify once and allow an explicit retry', () => {
  for (const error of ['voice-unavailable', 'audio-busy', 'synthesis-failed', 'not-allowed']) {
    const rig = setup();
    rig.player.speak('开始引导');
    rig.utterances[0].onerror({ error });
    rig.utterances[0].onerror({ error });
    assert.equal(rig.failures, 1, error);
    rig.player.speak('再次尝试');
    assert.equal(rig.utterances[1].text, '再次尝试');
    assert.equal(rig.failures, 1);
  }
});

test('canceled/interrupted events do not report a failure', () => {
  const rig = setup();
  rig.player.speak('上一句');
  for (const error of ['canceled', 'interrupted']) rig.utterances[0].onerror({ error });
  assert.equal(rig.failures, 0);
});

test('late errors from replaced or stopped speech cannot disable a later attempt', () => {
  const rig = setup();
  rig.player.speak('上一句');
  rig.player.speak('下一句');
  rig.utterances[0].onerror({ error: 'synthesis-failed' });
  rig.player.stop();
  rig.utterances[1].onerror({ error: 'voice-unavailable' });
  assert.equal(rig.failures, 0);
});

test('synchronous browser API failures use the same text fallback', () => {
  for (const method of ['cancel', 'getVoices', 'speak']) {
    const rig = setup();
    rig.driver[method] = () => { throw new Error(`${method} unavailable`); };
    assert.doesNotThrow(() => rig.player.speak('保留文字'));
    assert.equal(rig.failures, 1, method);
    assert.doesNotThrow(() => rig.player.stop());
  }
  let failures = 0;
  const rig = setup();
  const player = createSpeechPlayer(rig.driver, () => { throw new Error('Utterance unavailable'); }, () => { failures += 1; });
  assert.doesNotThrow(() => player.speak('保留文字'));
  assert.equal(failures, 1);
});
