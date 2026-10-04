/**
 * Turns dropped files into RGBA frames, entirely in the browser.
 *   still image (jpg/png/webp/bmp)       -> 1 frame
 *   animated GIF / WebP / APNG           -> all frames with durations (ImageDecoder API)
 *   video (mp4/webm/mov)                 -> frames sampled at `fps`
 *   several images                       -> a frame sequence, natural-sorted by name
 */
export type SourceKind = 'image' | 'animated' | 'video' | 'sequence';

export interface Decoded {
  kind: SourceKind;
  name: string;
  frames: ImageData[];
  /** Per-frame display time in ms. */
  durations: number[];
  width: number;
  height: number;
  note?: string;
}

const MAX_IMAGE = 1536;
const MAX_VIDEO = 512;
const MAX_FRAMES = 120;
/** Longest stretch of video read at once: MAX_FRAMES at 24 fps. Longer clips are trimmed first. */
export const MAX_VIDEO_SECONDS = 5;

export const isVideo = (f: File) => f.type.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/i.test(f.name);
export const isPixelizable = (f: File) => isVideo(f) || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(f.name) || f.type.startsWith('image/');

function grab(src: CanvasImageSource, w: number, h: number, max: number): ImageData {
  const s = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return ctx.getImageData(0, 0, c.width, c.height);
}

async function decodeStill(file: File): Promise<ImageData> {
  const bmp = await createImageBitmap(file);
  try { return grab(bmp, bmp.width, bmp.height, MAX_IMAGE); } finally { bmp.close(); }
}

async function decodeAnimated(file: File): Promise<{ frames: ImageData[]; durations: number[] } | null> {
  if (!('ImageDecoder' in window)) return null;
  const type = file.type || (/\.gif$/i.test(file.name) ? 'image/gif' : /\.webp$/i.test(file.name) ? 'image/webp' : 'image/png');
  if (!(await ImageDecoder.isTypeSupported(type))) return null;
  const dec = new ImageDecoder({ data: file.stream(), type });
  try {
    await dec.tracks.ready;
    const track = dec.tracks.selectedTrack;
    if (!track || track.frameCount <= 1) return null;
    await dec.completed;
    const frames: ImageData[] = [], durations: number[] = [];
    for (let i = 0; i < Math.min(track.frameCount, MAX_FRAMES); i++) {
      const { image } = await dec.decode({ frameIndex: i });
      frames.push(grab(image, image.displayWidth, image.displayHeight, MAX_IMAGE));
      // GIFs with 0/10ms delays play at ~100ms in browsers; mirror that
      const ms = (image.duration ?? 100_000) / 1000;
      durations.push(ms < 20 ? 100 : ms);
      image.close();
    }
    return { frames, durations };
  } finally { dec.close(); }
}

/** Length of a video file in seconds (metadata only, no decoding). */
export async function videoDuration(file: File): Promise<number> {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.preload = 'metadata'; v.muted = true; v.src = url;
  try {
    await new Promise<void>((res, rej) => { v.onloadedmetadata = () => res(); v.onerror = () => rej(new Error('This browser cannot read that video (try MP4/H.264 or WebM)')); });
    return Number.isFinite(v.duration) ? v.duration : 0;
  } finally { URL.revokeObjectURL(url); v.removeAttribute('src'); }
}

/** Grabs frames into `fps` time slots while the video plays (from `start`); missed slots stay empty. */
function playCapture(video: HTMLVideoElement, fps: number, want: number, start = 0): Promise<(ImageData | undefined)[]> {
  const slots: (ImageData | undefined)[] = new Array(want);
  type RVFC = (cb: (now: number, meta: { mediaTime: number }) => void) => number;
  const rvfc = (video as unknown as { requestVideoFrameCallback?: RVFC }).requestVideoFrameCallback?.bind(video);
  if (!rvfc) return Promise.resolve(slots);
  return new Promise(resolve => {
    let done = false, idle: ReturnType<typeof setTimeout>;
    const finish = () => { if (done) return; done = true; clearTimeout(idle); video.pause(); video.onended = null; resolve(slots); };
    const arm = () => { clearTimeout(idle); idle = setTimeout(finish, 2500); }; // stalled: fall back to seeking
    const onFrame = (_now: number, meta: { mediaTime: number }) => {
      if (done) return;
      const i = Math.round((meta.mediaTime - start) * fps);
      if (i >= 0 && i < want && !slots[i]) slots[i] = grab(video, video.videoWidth, video.videoHeight, MAX_VIDEO);
      if (i >= want - 1) return finish();
      arm();
      rvfc(onFrame);
    };
    video.onended = finish;
    video.currentTime = start;
    video.playbackRate = 1; // 2x drops about half the frames (each grab takes ~15 ms), and those then need seeking
    rvfc(onFrame);
    arm();
    video.play().catch(finish);
  });
}

async function decodeVideo(file: File, fps: number, maxSeconds: number, start = 0, end = Infinity): Promise<{ frames: ImageData[]; durations: number[] }> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.preload = 'auto'; video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('This browser cannot decode that video (try MP4/H.264 or WebM in Chrome/Edge)'));
    });
    const from = Math.max(0, Math.min(start, (video.duration || 0) - 0.05));
    const dur = Math.max(0.05, Math.min((video.duration || 0), end) - from);
    const want0 = Math.min(MAX_FRAMES, Math.max(1, Math.floor(Math.min(dur, maxSeconds) * fps)));
    const want = want0;
    // Fast path: play the clip (muted) and grab each frame as it is presented. Seeking frame
    // by frame costs a decode per frame and took about a minute for a 5 s clip.
    const slots: (ImageData | undefined)[] = await playCapture(video, fps, want, from).catch(() => new Array(want));
    // anything the playback skipped (busy tab, slow machine) is fetched by seeking
    for (let i = 0; i < want; i++) {
      if (slots[i]) continue;
      await new Promise<void>(resolve => { video.onseeked = () => resolve(); video.currentTime = Math.min(from + i / fps, Math.max(0, video.duration - 0.001)); });
      slots[i] = grab(video, video.videoWidth, video.videoHeight, MAX_VIDEO);
    }
    const frames = slots as ImageData[];
    return { frames, durations: frames.map(() => 1000 / fps) };
  } finally { URL.revokeObjectURL(url); video.removeAttribute('src'); }
}

export async function decodeFiles(files: File[], video: { fps?: number; maxSeconds?: number; start?: number; end?: number } = {}): Promise<Decoded> {
  const usable = files.filter(isPixelizable);
  if (!usable.length) throw new Error('No image or video files');

  if (usable.length > 1) {
    const sorted = [...usable].filter(f => !isVideo(f)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const frames = [];
    for (const f of sorted.slice(0, MAX_FRAMES)) frames.push(await decodeStill(f));
    const w = Math.max(...frames.map(f => f.width)), h = Math.max(...frames.map(f => f.height));
    return { kind: 'sequence', name: sorted[0].name.replace(/[_\-\s]*\d*\.\w+$/, ''), frames, durations: frames.map(() => 100), width: w, height: h };
  }

  const file = usable[0];
  const name = file.name.replace(/\.\w+$/, '');
  if (isVideo(file)) {
    const v = await decodeVideo(file, video.fps ?? 24, video.maxSeconds ?? MAX_VIDEO_SECONDS, video.start ?? 0, video.end ?? Infinity);
    if (!v.frames.length) throw new Error('No frames decoded from video');
    return { kind: 'video', name, ...v, width: v.frames[0].width, height: v.frames[0].height };
  }
  if (/\.(gif|webp|png)$/i.test(file.name)) {
    try {
      const a = await decodeAnimated(file);
      if (a) return { kind: 'animated', name, ...a, width: a.frames[0].width, height: a.frames[0].height };
    } catch { /* fall through to a still */ }
  }
  const still = await decodeStill(file);
  const note = /\.gif$/i.test(file.name) && !('ImageDecoder' in window) ? 'This browser has no ImageDecoder; only the first GIF frame was read (use Chrome or Edge).' : undefined;
  return { kind: 'image', name, frames: [still], durations: [100], width: still.width, height: still.height, note };
}
