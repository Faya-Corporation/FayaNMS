/**
 * Capacity forecast v3 — deterministic ridge regression (Phase 15-c).
 *
 * A self-contained, dependency-free ML tier for the capacity forecast,
 * additive over the v2 client-side model (linear trend × weekly season
 * factor). Everything in this module is PURE and DETERMINISTIC:
 *
 *   - no Date.now / Math.random / timers — the window data is input;
 *   - weights initialize at zeros, batch gradient descent with a FIXED
 *     iteration count and a FIXED learning rate, no shuffling — the
 *     optimization trace is identical for identical inputs, so identical
 *     inputs → byte-identical outputs (proven by the route's determinism
 *     gate);
 *   - features are standardized on the training split only (no leakage).
 *
 * Design (frozen hyperparameters):
 *
 *   features (buildFeatures)   5 columns: intercept, normalized trend
 *                              (days since window start), weekly sin(2πt/7),
 *                              weekly cos(2πt/7), weekend flag (UTC Sat/Sun)
 *   standardization            z-score per feature + target on the
 *                              TRAINING split (population σ, guard σ < 1e-12
 *                              → treated as constant)
 *   objective                  mean squared error + λ‖w‖² (λ = RIDGE_LAMBDA,
 *                              intercept/bias unpenalized)
 *   solver                     batch gradient descent, learning rate
 *                              GD_LEARNING_RATE, exactly GD_ITERATIONS
 *                              iterations, init zeros — for standardized
 *                              inputs the Hessian is bounded (eigenvalues
 *                              ≤ 2·(4 + λ) ≈ 9), so η = 0.1 is stable and
 *                              the 0.9^300 ≈ 1e-14 contraction fully
 *                              converges: deterministic by construction
 *   split                      last 25% of the chronological series is the
 *                              backtest (validation) window, the rest trains
 *   metrics                    MAE, RMSE, MAPE (zero denominators guarded),
 *                              R² (constant-validation guarded) — computed
 *                              on the backtest window only
 *
 * Blend rule with v2: ridge-v3 is the point-forecast engine; the 80%
 * confidence band keeps v2's residual-σ derivation (population σ of
 * actual − fitted, floored at 0.5% of the mean level) recomputed around
 * the v3 points (see perf-capacity-view.tsx).
 */

const DAY_MS = 86_400_000;

/** Ridge penalty applied to the standardized (non-intercept) weights. */
export const RIDGE_LAMBDA = 0.5;
/** Fixed batch-gradient-descent learning rate (standardized space). */
export const GD_LEARNING_RATE = 0.1;
/** Fixed iteration count — convergence is deterministic by construction. */
export const GD_ITERATIONS = 300;
/** Minimum daily points for a meaningful train/backtest split. */
export const CAPACITY_MODEL_MIN_POINTS = 10;
/** Fraction of the chronological series reserved for the backtest window. */
const VALIDATION_FRACTION = 0.25;

/** Standardized-space weight names, order matches the non-intercept features. */
export const CAPACITY_FEATURE_NAMES = [
  "trend",
  "weeklySin",
  "weeklyCos",
  "weekend",
] as const;
export type CapacityFeatureName = (typeof CAPACITY_FEATURE_NAMES)[number];

export interface CapacitySeriesPoint {
  /** Epoch ms (UTC). */
  ts: number;
  value: number;
}

/**
 * Raw (unstandardized) feature row for one timestamp:
 * [1, days-since-window-start, sin(2πd/7), cos(2πd/7), weekend] — 5 features
 * including the intercept column. The weekday uses UTC (getUTCDay) so the
 * mapping is locale/timezone-free.
 */
export function buildFeatures(
  ts: number,
  windowStartTs: number
): [number, number, number, number, number] {
  const days = (ts - windowStartTs) / DAY_MS;
  const weekday = new Date(ts).getUTCDay(); // 0 = Sunday … 6 = Saturday
  return [
    1, // intercept column (never standardized or penalized)
    days, // normalized trend: days since window start
    Math.sin((2 * Math.PI * days) / 7), // weekly seasonality (quadrature I)
    Math.cos((2 * Math.PI * days) / 7), // weekly seasonality (quadrature II)
    weekday === 0 || weekday === 6 ? 1 : 0, // weekend flag
  ];
}

export interface RidgeOptions {
  /** Ridge penalty (default RIDGE_LAMBDA). */
  lambda?: number;
  /** Gradient-descent learning rate (default GD_LEARNING_RATE). */
  learningRate?: number;
  /** Fixed iteration count (default GD_ITERATIONS). */
  iterations?: number;
}

export interface RidgeModel {
  /** Standardized-space weights for the 4 non-intercept features. */
  weights: number[];
  /** Standardized-space bias (intercept). */
  bias: number;
  /** Per-feature training means (raw feature space, non-intercept columns). */
  featureMeans: number[];
  /** Per-feature training population std devs (constant features guard to 1). */
  featureStdDevs: number[];
  /** Training target mean. */
  targetMean: number;
  /** Training target population std dev (constant target guards to 1). */
  targetStdDev: number;
  /**
   * Window start (t₀) the features were built against. ridgeRegression does
   * not know t₀ (it only sees the design matrix) — the capacity helpers
   * below patch it after fitting so `forecast` can rebuild features.
   */
  windowStartTs: number;
  /** Rows used to fit. */
  trainPoints: number;
}

const EPS = 1e-12;

function populationStd(values: number[], meanValue: number): number {
  let ss = 0;
  for (let i = 0; i < values.length; i += 1) {
    ss += (values[i] - meanValue) ** 2;
  }
  return Math.sqrt(ss / values.length);
}

/**
 * Deterministic ridge regression over a design matrix whose FIRST column is
 * the (unpenalized) intercept. Non-intercept columns are z-scored on the
 * training data; the target is z-scored too, which makes the fixed learning
 * rate scale-independent. Batch gradient descent, zeros init, fixed
 * iterations — no randomness anywhere.
 */
export function ridgeRegression(
  X: number[][],
  y: number[],
  opts: RidgeOptions = {}
): RidgeModel {
  const lambda = opts.lambda ?? RIDGE_LAMBDA;
  const learningRate = opts.learningRate ?? GD_LEARNING_RATE;
  const iterations = opts.iterations ?? GD_ITERATIONS;

  const n = y.length;
  if (n === 0 || X.length !== n) {
    throw new Error("ridgeRegression: X and y must be non-empty and aligned");
  }
  const featureCount = X[0].length - 1; // excluding the intercept column
  if (featureCount < 1) {
    throw new Error("ridgeRegression: design matrix needs non-intercept features");
  }

  // Training statistics (means/σ per non-intercept feature + target).
  const featureMeans = new Array<number>(featureCount).fill(0);
  const featureStdDevs = new Array<number>(featureCount).fill(0);
  for (let j = 0; j < featureCount; j += 1) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += X[i][j + 1];
    const meanValue = sum / n;
    featureMeans[j] = meanValue;
    const std = populationStd(
      X.map((row) => row[j + 1]),
      meanValue
    );
    featureStdDevs[j] = std < EPS ? 1 : std; // constant feature → z ≡ 0
  }
  const targetMean = y.reduce((a, b) => a + b, 0) / n;
  const targetStdDevRaw = populationStd(y, targetMean);
  const targetStdDev = targetStdDevRaw < EPS ? 1 : targetStdDevRaw;

  // Standardized design matrix + target.
  const Z: number[][] = X.map((row) =>
    row.slice(1).map((value, j) => (value - featureMeans[j]) / featureStdDevs[j])
  );
  const t = y.map((value) => (value - targetMean) / targetStdDev);

  // Batch gradient descent on L(b, w) = mean((t − b − Zw)²) + λ‖w‖².
  // Gradients: ∂L/∂b = −(2/n)·Σr ; ∂L/∂wⱼ = −(2/n)·Σr·zⱼ + 2λwⱼ.
  let bias = 0;
  const weights = new Array<number>(featureCount).fill(0);
  for (let iter = 0; iter < iterations; iter += 1) {
    const residual = new Array<number>(n);
    for (let i = 0; i < n; i += 1) {
      let pred = bias;
      const row = Z[i];
      for (let j = 0; j < featureCount; j += 1) pred += weights[j] * row[j];
      residual[i] = t[i] - pred;
    }
    let gradBias = 0;
    for (let i = 0; i < n; i += 1) gradBias += residual[i];
    gradBias = (-2 / n) * gradBias;
    const gradWeights = new Array<number>(featureCount);
    for (let j = 0; j < featureCount; j += 1) {
      let g = 0;
      for (let i = 0; i < n; i += 1) g += residual[i] * Z[i][j];
      gradWeights[j] = (-2 / n) * g + 2 * lambda * weights[j];
    }
    bias -= learningRate * gradBias;
    for (let j = 0; j < featureCount; j += 1) {
      weights[j] -= learningRate * gradWeights[j];
    }
  }

  return {
    weights,
    bias,
    featureMeans,
    featureStdDevs,
    targetMean,
    targetStdDev,
    // Patched by the capacity helpers (they own t₀); raw callers must set
    // it before calling `forecast`.
    windowStartTs: Number.NaN,
    trainPoints: n,
  };
}

/**
 * Point predictions for future timestamps. Pure: same model + same
 * timestamps → identical numbers on every call.
 */
export function forecast(model: RidgeModel, futureTimestamps: number[]): number[] {
  return futureTimestamps.map((ts) => {
    const row = buildFeatures(ts, model.windowStartTs);
    let predStd = model.bias;
    for (let j = 0; j < model.weights.length; j += 1) {
      predStd +=
        model.weights[j] *
        ((row[j + 1] - model.featureMeans[j]) / model.featureStdDevs[j]);
    }
    return model.targetMean + model.targetStdDev * predStd;
  });
}

/**
 * De-standardized weights: metric units per unit of the raw feature
 * (∂ŷ/∂xⱼ = σ_y·wⱼ/σⱼ). Index 0 (trend) is therefore metric units per day,
 * directly comparable with the v2 `slopePerDay`.
 */
export function destandardizeWeights(model: RidgeModel): number[] {
  return model.weights.map((w, j) => {
    const sigma = model.featureStdDevs[j];
    return sigma < EPS ? 0 : (model.targetStdDev * w) / sigma;
  });
}

export interface RegressionMetrics {
  mae: number;
  rmse: number;
  /** Mean absolute percentage error in percent (0 when every actual is 0). */
  mape: number;
  /** 1 − SSres/SStot on the evaluation window (1 when both are ~0). */
  r2: number;
}

/**
 * Deterministic regression metrics over an evaluation window. MAPE skips
 * zero-magnitude actuals (divide-by-zero guard); R² guards a constant
 * evaluation window (perfect → 1, otherwise 0).
 */
export function regressionMetrics(
  actual: number[],
  predicted: number[]
): RegressionMetrics {
  const n = actual.length;
  if (n === 0 || predicted.length !== n) {
    throw new Error("regressionMetrics: aligned non-empty inputs required");
  }
  let absSum = 0;
  let sqSum = 0;
  let mapeSum = 0;
  let mapeCount = 0;
  for (let i = 0; i < n; i += 1) {
    const err = actual[i] - predicted[i];
    absSum += Math.abs(err);
    sqSum += err * err;
    if (Math.abs(actual[i]) > 1e-9) {
      mapeSum += Math.abs(err / actual[i]);
      mapeCount += 1;
    }
  }
  const meanActual = actual.reduce((a, b) => a + b, 0) / n;
  let ssTot = 0;
  for (let i = 0; i < n; i += 1) ssTot += (actual[i] - meanActual) ** 2;
  const mae = absSum / n;
  const rmse = Math.sqrt(sqSum / n);
  const mape = mapeCount === 0 ? 0 : (100 * mapeSum) / mapeCount;
  const r2 = ssTot < EPS ? (sqSum < EPS ? 1 : 0) : 1 - sqSum / ssTot;
  return { mae, rmse, mape, r2 };
}

/** Round to `places` decimals, normalizing -0 to 0 (stable JSON output). */
export function roundTo(v: number, places: number): number {
  const p = 10 ** places;
  const r = Math.round(v * p) / p;
  return Object.is(r, -0) ? 0 : r;
}

export interface TrainValidationSplit {
  trainCount: number;
  validationCount: number;
}

/** Last 25% of the series is the backtest window, the rest trains. */
export function splitTrainValidation(n: number): TrainValidationSplit {
  const validationCount = Math.max(1, Math.floor(n * VALIDATION_FRACTION));
  return { trainCount: n - validationCount, validationCount };
}

export interface CapacityModelReport {
  engine: "ridge-v3";
  metrics: RegressionMetrics & {
    trainPoints: number;
    validationPoints: number;
  };
  /** Standardized-space weights (comparable magnitudes, ideal for bars). */
  featureWeights: Record<CapacityFeatureName, number>;
  /** De-standardized trend effect, metric units per day. */
  trendPerDay: number;
  backtestWindow: { from: string; to: string };
}

/**
 * Train/backtest a capacity series and report deterministic quality
 * metrics. Returns null when the series is too short for a meaningful
 * split (< CAPACITY_MODEL_MIN_POINTS) — callers must NOT fabricate metrics.
 * The input is used exactly as published (rounded values; chronological
 * order is re-asserted with a stable sort), so the client can reproduce
 * the identical model from the same published series.
 */
export function backtestCapacityModel(
  series: CapacitySeriesPoint[]
): CapacityModelReport | null {
  const n = series.length;
  if (n < CAPACITY_MODEL_MIN_POINTS) return null;

  const chronological = [...series].sort((a, b) => a.ts - b.ts);
  const windowStartTs = chronological[0].ts;
  const { trainCount, validationCount } = splitTrainValidation(n);
  const train = chronological.slice(0, trainCount);
  const validation = chronological.slice(trainCount);

  const X = train.map((p) => buildFeatures(p.ts, windowStartTs));
  const y = train.map((p) => p.value);
  const model = ridgeRegression(X, y);
  model.windowStartTs = windowStartTs;

  const predicted = forecast(model, validation.map((p) => p.ts));
  const metrics = regressionMetrics(
    validation.map((p) => p.value),
    predicted
  );
  const destandardized = destandardizeWeights(model);

  return {
    engine: "ridge-v3",
    metrics: {
      mae: roundTo(metrics.mae, 3),
      rmse: roundTo(metrics.rmse, 3),
      mape: roundTo(metrics.mape, 2),
      r2: roundTo(metrics.r2, 4),
      trainPoints: trainCount,
      validationPoints: validationCount,
    },
    featureWeights: {
      trend: roundTo(model.weights[0], 4),
      weeklySin: roundTo(model.weights[1], 4),
      weeklyCos: roundTo(model.weights[2], 4),
      weekend: roundTo(model.weights[3], 4),
    },
    trendPerDay: roundTo(destandardized[0], 4),
    backtestWindow: {
      from: new Date(validation[0].ts).toISOString(),
      to: new Date(validation[validation.length - 1].ts).toISOString(),
    },
  };
}

/**
 * Refit ridge-v3 on ALL points of the series (standard ML flow: the split
 * exists to report quality, the final point forecast refits on the full
 * window). Returns null for series shorter than CAPACITY_MODEL_MIN_POINTS
 * so the chart engine and the reported model agree on availability.
 */
export function fitCapacityModel(
  series: CapacitySeriesPoint[]
): RidgeModel | null {
  const n = series.length;
  if (n < CAPACITY_MODEL_MIN_POINTS) return null;
  const chronological = [...series].sort((a, b) => a.ts - b.ts);
  const windowStartTs = chronological[0].ts;
  const X = chronological.map((p) => buildFeatures(p.ts, windowStartTs));
  const y = chronological.map((p) => p.value);
  const model = ridgeRegression(X, y);
  model.windowStartTs = windowStartTs;
  return model;
}
