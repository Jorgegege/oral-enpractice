// 本地神经语音包 Worker：kokoro-js 浏览器构建 + hf-mirror 镜像
// 模型走 hf-mirror 下载，首次下载后由浏览器 Cache API 缓存，之后离线可用。
// 消息 in : {type:'init'} / {type:'synthesize', id, text, voice, speed}
//      out: {type:'progress'|'ready'|'audio'|'error', ...}

let TTS = null;
let loading = null;

const VOICES = new Set([
  'af_heart','af_alloy','af_aoede','af_bella','af_jessica','af_kore','af_nicole',
  'af_nova','af_river','af_sarah','af_sky','am_adam','am_echo','am_eric',
  'am_fenrir','am_liam','am_michael','am_onyx','am_puck','am_santa',
  'bf_emma','bf_isabella','bf_alice','bf_lily','bm_george','bm_lewis','bm_daniel','bm_fable'
]);

async function loadEngine() {
  if (TTS) return TTS;
  if (loading) return loading;
  loading = (async () => {
    let mod;
    try {
      mod = await import(/* @vite-ignore */ './kokoro.web.js');
    } catch (e) {
      // 备用 CDN（若本地文件加载失败）
      mod = await import(/* @vite-ignore */ 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js');
    }
    // 构建内已把下载域名替换为 hf-mirror；这里再确保 env 配置
    try {
      const env = mod.__env;
      if (env) {
        env.remoteHost = 'https://hf-mirror.com/';
        env.allowRemoteModels = true;
        env.useBrowserCache = true;
      }
    } catch (e) {}
    TTS = await mod.KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (p) => {
        if (p.status === 'progress' || p.status === 'done') {
          postMessage({
            type: 'progress',
            file: p.file || '',
            progress: typeof p.progress === 'number' ? p.progress : (p.status === 'done' ? 100 : 0),
          });
        }
      },
    });
    return TTS;
  })().catch((e) => { loading = null; throw e; });
  return loading;
}

self.onmessage = async (ev) => {
  const d = ev.data || {};
  if (d.type === 'init') {
    try { await loadEngine(); postMessage({ type: 'ready' }); }
    catch (e) { postMessage({ type: 'error', phase: 'init', msg: String((e && e.message) || e) }); }
    return;
  }
  if (d.type === 'synthesize') {
    try {
      const tts = await loadEngine();
      const voice = VOICES.has(d.voice) ? d.voice : 'af_heart';
      const speed = Math.max(0.5, Math.min(1.5, Number(d.speed) || 1));
      const out = await tts.generate(String(d.text || ''), { voice, speed });
      const pcm = out.audio;
      postMessage({ type: 'audio', id: d.id, sr: out.sampling_rate || 24000, pcm }, [pcm.buffer]);
    } catch (e) {
      postMessage({ type: 'error', phase: 'synth', id: d.id, msg: String((e && e.message) || e) });
    }
  }
};
