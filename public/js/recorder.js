/**
 * 录音封装：基于 MediaRecorder，支持开始/暂停/继续/删除，最终产出单个音频 Blob
 * 兼容安卓 Chrome（webm/opus）与 iOS Safari（mp4）
 */
function pickMime() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

class Recorder {
  constructor() {
    this.mr = null;
    this.stream = null;
    this.chunks = [];
    this.mime = "";
    this.state = "idle"; // idle | recording | paused
    this.recordedMs = 0;
    this._segStart = 0;
  }

  async ensure() {
    if (this.mr) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("当前浏览器不支持录音，请使用系统自带的最新浏览器");
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.mime = pickMime();
    this.mr = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime } : undefined);
    this.mr.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
  }

  async start() {
    await this.ensure();
    this.reset();
    this.mr.start(250);
    this.state = "recording";
    this._segStart = Date.now();
  }

  pause() {
    if (this.state !== "recording") return;
    this.mr.pause();
    this.recordedMs += Date.now() - this._segStart;
    this.state = "paused";
  }

  resume() {
    if (this.state !== "paused") return;
    this.mr.resume();
    this._segStart = Date.now();
    this.state = "recording";
  }

  toggle() {
    if (this.state === "recording") this.pause();
    else if (this.state === "paused") this.resume();
  }

  /** 实际已录制时长（毫秒，暂停不计） */
  durationMs() {
    let ms = this.recordedMs;
    if (this.state === "recording") ms += Date.now() - this._segStart;
    return ms;
  }

  hasContent() {
    return this.chunks.length > 0 || this.durationMs() > 300;
  }

  /** 停止并返回合并后的单个 Blob */
  stopBlob() {
    return new Promise((resolve) => {
      const finish = () => {
        if (this.state === "recording") this.recordedMs += Date.now() - this._segStart;
        const type = this.mr ? this.mr.mimeType : this.mime;
        resolve(new Blob(this.chunks, { type: type || "audio/webm" }));
      };
      if (this.mr && this.mr.state !== "inactive") {
        this.mr.onstop = () => finish();
        this.mr.stop();
      } else {
        finish();
      }
    });
  }

  reset() {
    this.chunks = [];
    this.recordedMs = 0;
    this._segStart = 0;
  }

  /** 删除录音：清空已录内容，回到空闲 */
  delete() {
    if (this.mr && this.mr.state !== "inactive") this.mr.stop();
    this.reset();
    this.state = "idle";
  }

  releaseMic() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.mr = null;
    this.stream = null;
  }
}

window.Recorder = Recorder;
