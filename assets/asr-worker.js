// 本地英文语音识别 Worker：Transformers.js + Whisper tiny.en (q8)
// 全程在浏览器内推理，不依赖 Google 服务；模型首次下载后由浏览器缓存。
// 消息：in  {type:'init'} / {type:'transcribe', id, pcm:Float32Array(16k mono)}
//       out {type:'progress'|'ready'|'result'|'error', ...}

let TF = null;
let asr = null;
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
  throw lastErr || new Error('识别引擎加载失败');
}

async function init() {
  if (asr) return true;
  if (loading) return loading;
  loading = (async () => {
    const lib = await loadLib();
    lib.env.allowLocalModels = false;
    lib.env.useBrowserCache = true;
    lib.env.remoteHost = 'https://hf-mirror.com';
    asr = await lib.pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
      dtype: 'q8',
      progress_callback: (p) => {
        postMessage({
          type: 'progress',
          status: p.status || '',
          file: p.file || '',
          progress: typeof p.progress === 'number' ? p.progress : null,
        });
      },
    });
    postMessage({ type: 'ready' });
    return true;
  })();
  try { return await loading; }
  catch (e) {
    loading = null;
    postMessage({ type: 'error', phase: 'init', msg: String((e && e.message) || e) });
    throw e;
  }
}

self.onmessage = async (e) => {
  const d = e.data || {};
  if (d.type === 'init') {
    try { await init(); } catch (err) {}
    return;
  }
  if (d.type === 'transcribe') {
    const id = d.id;
    try {
      await init();
      const out = await asr(d.pcm, { language: 'english', task: 'transcribe' });
      postMessage({ type: 'result', id, text: String((out && out.text) || '').trim() });
    } catch (err) {
      postMessage({ type: 'error', phase: 'transcribe', id, msg: String((err && err.message) || err) });
    }
  }
};
