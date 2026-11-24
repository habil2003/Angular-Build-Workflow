import { Component, OnDestroy, OnInit, NgZone, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';

interface TunerString {
  note: string;
  octave: number;
  number: number;
  frequency: number;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnInit, OnDestroy {
  readonly strings: TunerString[] = [
    { note: 'E', octave: 2, number: 6, frequency: 82.41 },
    { note: 'A', octave: 2, number: 5, frequency: 110.0 },
    { note: 'D', octave: 3, number: 4, frequency: 146.83 },
    { note: 'G', octave: 3, number: 3, frequency: 196.0 },
    { note: 'B', octave: 3, number: 2, frequency: 246.94 },
    { note: 'E', octave: 4, number: 1, frequency: 329.63 }
  ];

  selectedIndex = 0;
  cents = 0;
  autoMode = true;
  listening = false;
  a4 = 440;
  detectedFrequency: number | null = null;
  error: string | null = null;
  hasSignal = false;

  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private mediaStream: MediaStream | null = null;
  private rafId: number | null = null;
  private buffer = new Float32Array(2048);
  private smoothedCents: number | null = null;
  private displayedCents = 0;
  private silenceFrames = 0;
  private readonly silenceHold = 20;
  private readonly signalOn = 6;
  private readonly signalOff = 4;
  private signalFrames = 0;
  private dropFrames = 0;

  constructor(private zone: NgZone, private cdr: ChangeDetectorRef) {}

  readonly gauge = {
    cx: 171,
    cy: 170,
    r: 135,
    ticks: Array.from({ length: 21 }, (_, i) => -50 + i * 5)
  };

  get selected(): TunerString {
    return this.strings[this.selectedIndex];
  }

  get inTune(): boolean {
    return this.hasSignal && Math.abs(this.cents) <= 5;
  }

  get statusColor(): string {
    if (!this.hasSignal) return '#e8efea';
    return this.inTune ? 'var(--green)' : 'var(--amber)';
  }

  get statusText(): string {
    if (this.error) return this.error;
    if (!this.listening) return 'Tap mic to start';
    if (!this.hasSignal) return 'Play a string...';
    if (this.inTune) return 'In tune';
    return this.cents < 0 ? 'Flat — tighten the string' : 'Sharp — loosen the string';
  }

  get centsLabel(): string {
    if (!this.hasSignal) return '-- cents';
    const rounded = Math.round(this.cents);
    return rounded > 0 ? `+${rounded} cents` : `${rounded} cents`;
  }

  get frequencyLabel(): string {
    return this.detectedFrequency ? `${this.detectedFrequency.toFixed(2)} Hz` : '-- Hz';
  }

  get needleAngle(): number {
    const clamped = Math.max(-50, Math.min(50, this.displayedCents));
    return clamped * 1.8;
  }

  get arcPath(): string {
    return this.describeArc(this.gauge.cx, this.gauge.cy, this.gauge.r - 14, -9, 9);
  }

  async ngOnInit(): Promise<void> {}

  ngOnDestroy(): void {
    this.stopListening();
  }

  selectString(index: number): void {
    this.selectedIndex = index;
    this.smoothedCents = null;
    this.displayedCents = 0;
    this.cents = 0;
    this.hasSignal = false;
    this.detectedFrequency = null;
  }

  toggleMode(mode: 'auto' | 'manual'): void {
    this.autoMode = mode === 'auto';
    this.smoothedCents = null;
  }

  async startListening(): Promise<void> {
    if (this.listening) return;
    this.error = null;
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
      this.audioContext = new AudioContext();
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }
      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 2048;
      source.connect(this.analyser);
      this.buffer = new Float32Array(this.analyser.fftSize);
      this.listening = true;
      this.zone.runOutsideAngular(() => this.detectPitch());
    } catch (e) {
      this.error = 'Microphone access denied';
      this.listening = false;
      this.cdr.detectChanges();
    }
  }

  stopListening(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.mediaStream?.getTracks().forEach(t => t.stop());
    this.mediaStream = null;
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.analyser = null;
    this.listening = false;
    this.hasSignal = false;
  }

  private detectPitch(): void {
    if (!this.analyser || !this.audioContext) return;
    this.analyser.getFloatTimeDomainData(this.buffer as Float32Array<ArrayBuffer>);
    const freq = this.autoCorrelate(this.buffer, this.audioContext.sampleRate);

    if (freq > 0) {
      this.silenceFrames = 0;
      this.signalFrames++;
      this.dropFrames = 0;
      const nearest = this.findNearestString(freq);
      let targetIndex = this.selectedIndex;
      if (this.autoMode) {
        const currentCents = Math.abs(1200 * Math.log2(freq / this.strings[this.selectedIndex].frequency));
        const nearestCents = Math.abs(1200 * Math.log2(freq / this.strings[nearest.index].frequency));
        targetIndex = nearest.index !== this.selectedIndex && nearestCents < currentCents - 5 ? nearest.index : this.selectedIndex;
        if (!this.hasSignal) targetIndex = nearest.index;
      }
      const target = this.strings[targetIndex];
      const rawCents = 1200 * Math.log2(freq / target.frequency);
      const clamped = Math.max(-50, Math.min(50, rawCents));
      if (this.signalFrames >= this.signalOn) {
        if (this.smoothedCents === null) {
          this.smoothedCents = clamped;
          this.displayedCents = clamped;
      } else {
        this.smoothedCents = this.smoothedCents * 0.95 + clamped * 0.05;
      }
        this.detectedFrequency = freq;
        this.selectedIndex = targetIndex;
      }
    } else {
      this.silenceFrames++;
      this.dropFrames++;
      if (this.dropFrames >= this.signalOff) {
        this.signalFrames = 0;
      }
    }

    const active = this.signalFrames >= this.signalOn && this.silenceFrames <= this.silenceHold && this.smoothedCents !== null;
    const targetCents = active ? this.smoothedCents! : 0;
    const delta = targetCents - this.displayedCents;
    const maxStep = active ? 0.5 : 1.0;
    this.displayedCents += Math.max(-maxStep, Math.min(maxStep, delta));

    if (!active) {
      if (this.hasSignal) {
        this.zone.run(() => {
          this.hasSignal = false;
          this.smoothedCents = null;
          this.detectedFrequency = null;
          this.cents = 0;
          this.cdr.detectChanges();
        });
      } else if (Math.abs(this.displayedCents) > 0.5) {
        this.zone.run(() => this.cdr.detectChanges());
      }
    } else {
      this.zone.run(() => {
        this.hasSignal = true;
        this.cents = this.smoothedCents!;
        this.cdr.detectChanges();
      });
    }

    this.rafId = requestAnimationFrame(() => this.detectPitch());
  }

  private detectedFromCents(): number | null {
    if (this.smoothedCents === null) return null;
    const target = this.strings[this.selectedIndex];
    return target.frequency * Math.pow(2, this.smoothedCents / 1200);
  }

  private findNearestString(freq: number): { index: number; cents: number } {
    let bestIndex = 0;
    let bestCents = Infinity;
    for (let i = 0; i < this.strings.length; i++) {
      const c = Math.abs(1200 * Math.log2(freq / this.strings[i].frequency));
      if (c < bestCents) {
        bestCents = c;
        bestIndex = i;
      }
    }
    return { index: bestIndex, cents: bestCents };
  }

  private autoCorrelate(buf: Float32Array, sampleRate: number): number {
    const size = buf.length;
    let rms = 0;
    for (let i = 0; i < size; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / size);
    if (rms < 0.02) return -1;

    const maxLag = Math.floor(sampleRate / 60);
    const minLag = Math.floor(sampleRate / 1200);
    const n = Math.min(size, maxLag * 2);
    if (n < maxLag + 2) return -1;

    // normalized autocorrelation (faster/cleaner than full YIN for this size)
    const corr = new Float32Array(maxLag + 1);
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      let norm1 = 0;
      let norm2 = 0;
      for (let i = 0; i < n - lag; i++) {
        const a = buf[i];
        const b = buf[i + lag];
        sum += a * b;
        norm1 += a * a;
        norm2 += b * b;
      }
      corr[lag] = sum / (Math.sqrt(norm1 * norm2) || 1);
    }

    let bestLag = -1;
    let bestCorr = 0;
    for (let lag = minLag + 1; lag < maxLag; lag++) {
      const c = corr[lag];
      if (c > bestCorr && c > corr[lag - 1] && c >= corr[lag + 1]) {
        bestCorr = c;
        bestLag = lag;
      }
    }
    if (bestLag === -1 || bestCorr < 0.9) return -1;

    // parabolic interpolation
    const y1 = corr[bestLag - 1];
    const y2 = corr[bestLag];
    const y3 = corr[bestLag + 1];
    const denom = y1 - 2 * y2 + y3;
    const shift = denom !== 0 ? (0.5 * (y1 - y3)) / denom : 0;
    const period = bestLag + shift;
    const freq = sampleRate / period;
    if (freq < 60 || freq > 1200) return -1;
    return freq;
  }

  tickPos(tick: number, length: number): { x1: number; y1: number; x2: number; y2: number } {
    const angle = tick * 1.8 - 90;
    const rad = (angle * Math.PI) / 180;
    const outer = this.gauge.r;
    const inner = this.gauge.r - length;
    return {
      x1: this.gauge.cx + Math.cos(rad) * inner,
      y1: this.gauge.cy + Math.sin(rad) * inner,
      x2: this.gauge.cx + Math.cos(rad) * outer,
      y2: this.gauge.cy + Math.sin(rad) * outer
    };
  }

  tickLabelPos(tick: number): { x: number; y: number } {
    const angle = tick * 1.8 - 90;
    const rad = (angle * Math.PI) / 180;
    const r = this.gauge.r - 32;
    return {
      x: this.gauge.cx + Math.cos(rad) * r,
      y: this.gauge.cy + Math.sin(rad) * r + 4
    };
  }

  private polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  private describeArc(cx: number, cy: number, r: number, start: number, end: number): string {
    const startPt = this.polarToCartesian(cx, cy, r, end);
    const endPt = this.polarToCartesian(cx, cy, r, start);
    const largeArc = end - start <= 180 ? 0 : 1;
    return `M ${startPt.x} ${startPt.y} A ${r} ${r} 0 ${largeArc} 0 ${endPt.x} ${endPt.y}`;
  }
}
