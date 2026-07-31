// Provider-neutral voice layer.
//
// The interface below is what the rest of the UI talks to. Today it is backed by
// the browser's Web Speech API. Swapping in a hosted STT/TTS provider — or a
// future realtime multimodal voice API — means writing another object with the
// same shape and choosing it here; nothing in the command centre changes.
//
// WHERE YOUR AUDIO GOES — read this before assuming "no API key" means "local".
//
//   The Web Speech API needs no API key, but that is because the browser vendor
//   absorbs the cost, NOT because recognition is on-device:
//
//     * Chrome / Edge — audio is streamed to Google's speech servers and text
//       comes back. It leaves the machine.
//     * Safari — audio goes to Apple, unless the OS has on-device dictation
//       installed for the language, in which case it may stay local.
//     * Firefox — SpeechRecognition is not implemented; voice is unavailable and
//       the microphone button is disabled.
//
//   AGI-v1 itself never receives, stores or forwards audio: only the recognised
//   text is sent to /api/chat, exactly as if it had been typed. But this layer
//   cannot promise the audio never left the device, because in the common case
//   it did. If that matters, set VOICE_BACKEND=none and type.
//
// Deliberate constraints:
//   * Push-to-talk only. There is no always-listening mode, hidden or otherwise.
//   * Nothing is recorded or persisted by AGI-v1 — no audio is written to disk
//     or sent to the server at any point.
//   * If the microphone is unavailable or permission is refused, the UI says so
//     and text input keeps working — voice is never the only way in.

/**
 * @typedef {Object} VoiceBackend
 * @property {boolean} sttAvailable
 * @property {boolean} ttsAvailable
 * @property {() => Promise<void>} startListening
 * @property {() => void} stopListening
 * @property {(text: string) => void} speak
 * @property {() => void} stopSpeaking
 */

function createBrowserBackend({ onTranscript, onInterim, onState, onError }) {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition || null;
  const synth = window.speechSynthesis ?? null;

  let recognition = null;
  let listening = false;

  function buildRecognition() {
    const instance = new SpeechRecognition();
    instance.lang = navigator.language || 'en-US';
    // Push-to-talk: one utterance per press, no continuous capture.
    instance.continuous = false;
    instance.interimResults = true;
    instance.maxAlternatives = 1;

    instance.onresult = (event) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) final += result[0].transcript;
        else interim += result[0].transcript;
      }
      if (interim) onInterim?.(interim);
      if (final) {
        onState?.('transcribing');
        onTranscript?.(final.trim());
      }
    };

    instance.onerror = (event) => {
      listening = false;
      const message =
        event.error === 'not-allowed' || event.error === 'service-not-allowed'
          ? 'Microphone permission was refused. You can still type.'
          : event.error === 'no-speech'
            ? 'I did not hear anything.'
            : event.error === 'audio-capture'
              ? 'No microphone was found. You can still type.'
              : `Speech recognition failed (${event.error}). You can still type.`;
      onError?.(message);
      onState?.('idle');
    };

    instance.onend = () => {
      listening = false;
      onState?.('idle');
    };

    return instance;
  }

  return {
    sttAvailable: Boolean(SpeechRecognition),
    ttsAvailable: Boolean(synth),

    async startListening() {
      if (!SpeechRecognition) {
        onError?.('This browser has no speech recognition. You can still type.');
        return;
      }
      if (listening) return;
      // A fresh instance per press: reusing one across errors is unreliable
      // across browsers.
      recognition = buildRecognition();
      try {
        recognition.start();
        listening = true;
        onState?.('listening');
      } catch (err) {
        listening = false;
        onError?.(`Could not start the microphone: ${err.message}`);
        onState?.('idle');
      }
    },

    stopListening() {
      if (!recognition || !listening) return;
      try {
        recognition.stop();
      } catch {
        /* already stopping */
      }
      listening = false;
    },

    speak(text, onDone) {
      if (!synth || !text) {
        onDone?.();
        return;
      }
      synth.cancel();
      // Long replies are chunked by sentence: some browsers silently truncate a
      // single very long utterance, and chunking also lets a barge-in stop
      // sooner.
      const chunks = text.match(/[^.!?]+[.!?]*\s*/g)?.filter((s) => s.trim()) ?? [text];
      let index = 0;
      const speakNext = () => {
        if (index >= chunks.length) {
          onState?.('idle');
          onDone?.();
          return;
        }
        const utterance = new SpeechSynthesisUtterance(chunks[index++]);
        utterance.lang = navigator.language || 'en-US';
        utterance.rate = 1.02;
        if (index === 1) utterance.onstart = () => onState?.('speaking');
        utterance.onend = speakNext;
        utterance.onerror = () => {
          onState?.('idle');
          onDone?.();
        };
        synth.speak(utterance);
      };
      speakNext();
    },

    stopSpeaking() {
      synth?.cancel();
    },
  };
}

/**
 * Placeholder for a hosted provider. It reports itself unavailable rather than
 * pretending, so selecting a backend the server has not implemented degrades to
 * text instead of silently doing nothing.
 */
function createHostedBackend(name, { onError }) {
  const unavailable = () => {
    onError?.(
      `The "${name}" voice backend is configured but not implemented in this build. Type instead.`,
    );
  };
  return {
    sttAvailable: false,
    ttsAvailable: false,
    async startListening() {
      unavailable();
    },
    stopListening() {},
    speak() {},
    stopSpeaking() {},
  };
}

/**
 * @param {{backend?: string, onTranscript?: Function, onInterim?: Function,
 *          onState?: Function, onError?: Function}} options
 */
export function createVoice(options = {}) {
  const backendName = options.backend ?? 'browser';
  const backend =
    backendName === 'browser'
      ? createBrowserBackend(options)
      : backendName === 'none'
        ? createHostedBackend('none', options)
        : createHostedBackend(backendName, options);

  let speakingEnabled = backend.ttsAvailable;

  return {
    backendName,
    get sttAvailable() {
      return backend.sttAvailable;
    },
    get ttsAvailable() {
      return backend.ttsAvailable;
    },
    get speakingEnabled() {
      return speakingEnabled;
    },
    setSpeakingEnabled(value) {
      speakingEnabled = value && backend.ttsAvailable;
      if (!speakingEnabled) backend.stopSpeaking();
    },
    startListening: () => backend.startListening(),
    stopListening: () => backend.stopListening(),
    /**
     * Only speaks when spoken responses are switched on. `onDone` fires once
     * playback finishes (or immediately if speech is off), which is what lets
     * call mode know when it is safe to listen again without hearing itself.
     */
    speak(text, onDone) {
      if (speakingEnabled) backend.speak(text, onDone);
      else onDone?.();
    },
    stopSpeaking: () => backend.stopSpeaking(),
  };
}
