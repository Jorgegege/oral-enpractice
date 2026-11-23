// 本地轻量神经语音包 Worker：Transformers.js + MMS TTS eng (q8, 约36MB)
// 模型走 hf-mirror 下载，首次下载后由浏览器 Cache API 缓存，之后离线可用。
// 消息 in : {type:'init'} / {type:'synthesize', id, text}
//      out: {type:'progress'|'ready'|'audio'|'error', ...}
// 与高音质档 tts-worker.js 协议一致，主线程无需区分。

let TF = null;
let synth = null;
let loading = null;

async function loadLib() {
  if (TF) return TF;
  const urls = [
    'https://esm.sh/@huggingface/transformers@3.7.2',
    'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2/+esm',
  ];
  let lastErr = null;
  for (const u of urls) {
    try { TF = await import(/* @vite-ignore */ u); return TF; }
    catch (e) { lastErr = e; postMessage({ type: 'progress', status: 'cdn-fail', file: u }); }
  }
  throw lastErr || new Error('语音引擎加载失败');
}

async function loadEngine() {
  if (synth) return synth;
  if (loading) return loading;
  loading = (async () => {
    const lib = await loadLib();
    lib.env.allowLocalModels = false;
    lib.env.useBrowserCache = true;
    lib.env.remoteHost = 'https://hf-mirror.com/';
    synth = await lib.pipeline('text-to-speech', 'Xenova/mms-tts-eng', {
      dtype: 'q8',
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
    return synth;
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
      const s = await loadEngine();
      const out = await s(String(d.text || ''));
      const pcm = out.audio;
      postMessage({ type: 'audio', id: d.id, sr: out.sampling_rate || 16000, pcm }, [pcm.buffer]);
    } catch (e) {
      postMessage({ type: 'error', phase: 'synth', id: d.id, msg: String((e && e.message) || e) });
    }
  }
};
