/**
 * Uncertainty & model-disagreement descriptors (spec §16/§17).
 *
 * These helpers deliberately produce descriptive categories — never a fake
 * scalar "confidence = 92%". Every output is derived from measurable inputs:
 * per-model probability spread, data-quality status, calibration history and
 * sample size.
 */

import type { Prob3, QualityStatus } from '@/lib/types';
import { prob3ToArray } from '@/lib/types';

export type AgreementLabel = 'BROAD' | 'MODERATE' | 'SPLIT';

export interface ModelDisagreement {
  /** mean pairwise L1 distance between model probability vectors */
  meanSpread: number;
  maxSpread: number;
  label: AgreementLabel;
  perModel: Array<{ kind: string; probs: Prob3 }>;
}

export function assessDisagreement(
  models: Array<{ kind: string; probs: Prob3 }>,
): ModelDisagreement {
  let total = 0;
  let pairs = 0;
  let max = 0;
  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      const a = prob3ToArray(models[i].probs);
      const b = prob3ToArray(models[j].probs);
      const d = (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 2;
      total += d;
      pairs++;
      max = Math.max(max, d);
    }
  }
  const mean = pairs > 0 ? total / pairs : 0;
  const label: AgreementLabel = mean < 0.05 ? 'BROAD' : mean < 0.12 ? 'MODERATE' : 'SPLIT';
  return { meanSpread: mean, maxSpread: max, label, perModel: models };
}

export type DataQualityLabel = 'HIGH' | 'MEDIUM' | 'EXCLUDED';

export function dataQualityLabel(status: QualityStatus): DataQualityLabel {
  return status === 'VALID' ? 'HIGH' : status === 'WARNING' ? 'MEDIUM' : 'EXCLUDED';
}

export type CalibrationGrade = 'GOOD' | 'FAIR' | 'POOR' | 'UNKNOWN';

export function calibrationGrade(ece: number | null, brier: number | null): CalibrationGrade {
  if (ece == null || brier == null || Number.isNaN(ece)) return 'UNKNOWN';
  if (ece <= 0.03 && brier <= 0.62) return 'GOOD';
  if (ece <= 0.06 && brier <= 0.68) return 'FAIR';
  return 'POOR';
}

export interface UncertaintyReport {
  modelAgreement: AgreementLabel;
  meanSpread: number;
  dataQuality: DataQualityLabel;
  calibration: CalibrationGrade;
  historicalSample: number;
  overall: 'LOW' | 'MODERATE' | 'HIGH' | 'EXCLUDED';
  notes: string[];
}

export function buildUncertaintyReport(input: {
  agreement: ModelDisagreement;
  qualityStatus: QualityStatus;
  calibration: CalibrationGrade;
  historicalSample: number;
}): UncertaintyReport {
  const notes: string[] = [];
  const dq = dataQualityLabel(input.qualityStatus);
  if (dq === 'EXCLUDED') {
    notes.push('Record failed data-quality validation and is excluded from modeling.');
    return {
      modelAgreement: input.agreement.label,
      meanSpread: input.agreement.meanSpread,
      dataQuality: dq,
      calibration: input.calibration,
      historicalSample: input.historicalSample,
      overall: 'EXCLUDED',
      notes,
    };
  }
  let score = 0;
  if (input.agreement.label === 'MODERATE') score += 1;
  if (input.agreement.label === 'SPLIT') score += 2;
  if (dq === 'MEDIUM') score += 1;
  if (input.calibration === 'FAIR') score += 1;
  if (input.calibration === 'POOR') score += 2;
  if (input.calibration === 'UNKNOWN') score += 1;
  if (input.historicalSample < 200) score += 2;
  else if (input.historicalSample < 800) score += 1;

  if (input.agreement.label === 'SPLIT')
    notes.push('Underlying models materially disagree — inspect per-model probabilities.');
  if (input.historicalSample < 800)
    notes.push(`Limited historical sample (${input.historicalSample}). Treat estimates as provisional.`);
  if (dq === 'MEDIUM')
    notes.push('Data-quality warnings present on this fixture or its market data.');
  if (input.calibration === 'POOR')
    notes.push('Recent calibration metrics are degraded versus historical baseline.');

  return {
    modelAgreement: input.agreement.label,
    meanSpread: input.agreement.meanSpread,
    dataQuality: dq,
    calibration: input.calibration,
    historicalSample: input.historicalSample,
    overall: score <= 1 ? 'LOW' : score <= 3 ? 'MODERATE' : 'HIGH',
    notes,
  };
}
