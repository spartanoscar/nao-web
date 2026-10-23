// CMA-ES separable (sep-CMA-ES, Ros y Hansen 2008): estrategia evolutiva que en cada generación propone λ soluciones
// alrededor de una media, mide su costo y mueve la media y la "forma" de la búsqueda (una desviación por variable)
// hacia las mejores. Separable = covarianza diagonal: escala lineal con el número de variables (aquí ~70), sin
// descomponer matrices. Minimiza.

/** Generador normal estándar (Box-Muller) con semilla, para que una búsqueda se pueda repetir */
export function gaussian(seed: number): () => number {
  let s = seed >>> 0 || 1;
  const uniform = () => {
    // xorshift32
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return (s + 0.5) / 4294967296;
  };
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    const u = uniform();
    const v = uniform();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

export class SepCMA {
  readonly n: number;
  readonly lambda: number;
  private readonly mu: number;
  private readonly weights: number[];
  private readonly mueff: number;
  private readonly cs: number;
  private readonly ds: number;
  private readonly cc: number;
  private readonly c1: number;
  private readonly cmu: number;
  private readonly chiN: number;
  mean: number[];
  sigma: number;
  /** Desviación relativa por variable (raíz de la diagonal de C) */
  private d: number[];
  private pc: number[];
  private ps: number[];
  generation = 0;
  private readonly randn: () => number;
  private z: number[][] = [];

  constructor(mean: number[], sigma: number, { lambda, seed = 1 }: { lambda?: number; seed?: number } = {}) {
    const n = mean.length;
    this.n = n;
    this.lambda = lambda ?? 4 + Math.floor(3 * Math.log(n));
    this.mu = Math.floor(this.lambda / 2);
    const raw = Array.from({ length: this.mu }, (_, i) => Math.log(this.mu + 0.5) - Math.log(i + 1));
    const sum = raw.reduce((a, b) => a + b, 0);
    this.weights = raw.map((w) => w / sum);
    this.mueff = 1 / this.weights.reduce((a, w) => a + w * w, 0);
    this.cs = (this.mueff + 2) / (n + this.mueff + 5);
    this.ds = 1 + 2 * Math.max(0, Math.sqrt((this.mueff - 1) / (n + 1)) - 1) + this.cs;
    this.cc = (4 + this.mueff / n) / (n + 4 + (2 * this.mueff) / n);
    // Separable: tasas de aprendizaje de la covarianza multiplicadas por (n + 2) / 3
    const scale = (n + 2) / 3;
    this.c1 = Math.min(1, (scale * 2) / ((n + 1.3) ** 2 + this.mueff));
    this.cmu = Math.min(1 - this.c1, (scale * 2 * (this.mueff - 2 + 1 / this.mueff)) / ((n + 2) ** 2 + this.mueff));
    this.chiN = Math.sqrt(n) * (1 - 1 / (4 * n) + 1 / (21 * n * n));
    this.mean = [...mean];
    this.sigma = sigma;
    this.d = Array(n).fill(1);
    this.pc = Array(n).fill(0);
    this.ps = Array(n).fill(0);
    this.randn = gaussian(seed);
  }

  /** λ soluciones nuevas para evaluar */
  ask(): number[][] {
    this.z = Array.from({ length: this.lambda }, () => Array.from({ length: this.n }, () => this.randn()));
    return this.z.map((z) => z.map((zi, i) => this.mean[i] + this.sigma * this.d[i] * zi));
  }

  /** Costos de las soluciones del último ask, en el mismo orden */
  tell(costs: number[]): void {
    const order = costs.map((c, i) => [c, i] as const).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
    const n = this.n;
    // Paso medio en el espacio z (normalizado) y en el de las variables
    const zw = Array(n).fill(0);
    for (let k = 0; k < this.mu; k++) {
      const z = this.z[order[k]];
      for (let i = 0; i < n; i++) zw[i] += this.weights[k] * z[i];
    }
    for (let i = 0; i < n; i++) this.mean[i] += this.sigma * this.d[i] * zw[i];
    // Caminos de evolución
    const csq = Math.sqrt(this.cs * (2 - this.cs) * this.mueff);
    for (let i = 0; i < n; i++) this.ps[i] = (1 - this.cs) * this.ps[i] + csq * zw[i];
    const psNorm = Math.hypot(...this.ps);
    const hsig = psNorm / Math.sqrt(1 - (1 - this.cs) ** (2 * (this.generation + 1))) / this.chiN < 1.4 + 2 / (n + 1) ? 1 : 0;
    const ccq = Math.sqrt(this.cc * (2 - this.cc) * this.mueff);
    for (let i = 0; i < n; i++) this.pc[i] = (1 - this.cc) * this.pc[i] + hsig * ccq * this.d[i] * zw[i];
    // Covarianza diagonal: rango 1 (camino) + rango μ (las mejores)
    for (let i = 0; i < n; i++) {
      let rankMu = 0;
      for (let k = 0; k < this.mu; k++) {
        const y = this.d[i] * this.z[order[k]][i];
        rankMu += this.weights[k] * y * y;
      }
      const c = this.d[i] ** 2;
      const next =
        (1 - this.c1 - this.cmu) * c + this.c1 * (this.pc[i] ** 2 + (1 - hsig) * this.cc * (2 - this.cc) * c) + this.cmu * rankMu;
      this.d[i] = Math.sqrt(Math.max(next, 1e-20));
    }
    this.sigma *= Math.exp((this.cs / this.ds) * (psNorm / this.chiN - 1));
    this.generation++;
  }
}
