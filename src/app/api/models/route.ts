import { GET_, ok } from '@/lib/api-helpers';
import { listModelVersions, countPredictions } from '@/lib/db/repos-research';
import { standardEnsemble } from '@/lib/services/predictionService';

export const dynamic = 'force-dynamic';

export const GET = GET_(async (_req, ctx) => {
  const versions = listModelVersions(ctx.db).map((v) => ({
    id: v.id,
    code: v.code,
    kind: v.kind,
    name: v.name,
    config: JSON.parse(v.config_json),
    trainWindow: { from: v.train_window_from, to: v.train_window_to },
    trainSample: v.train_sample,
    datasetFingerprint: v.dataset_fingerprint,
    createdAt: v.created_at,
    predictions: countPredictions(ctx.db, v.id),
    immutable: true,
  }));
  const std = await standardEnsemble(ctx.db);
  return ok({
    versions,
    liveValidation: {
      modelVersion: std.version.code,
      fittedAt: std.asOf,
      trainedOn: std.fitted.trainedOn,
      weights: std.fitted.weights,
      validation: std.fitted.validation,
    },
  });
});
