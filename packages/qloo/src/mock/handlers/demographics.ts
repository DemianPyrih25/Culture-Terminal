import { AgeBucket, type QlooParams } from "@ct/contracts";
import { clamp, round, unit } from "../hash";
import { type JsonObject, type MockReply, ok } from "../json";
import { DEFAULT_TAKE, MockBadRequest, readList, readNumber } from "../params";

/**
 * `/v2/insights` with filter.type=urn:demographics (G12): one block of affinity indices (−1..1,
 * not shares) per entity, in request order, up to `take` blocks. About one entity in fifteen has
 * no block, the coverage gap the probe saw.
 */

const NO_BLOCK_SHARE = 1 / 15;

function block(id: string): JsonObject {
  // A youth-to-age tilt plus per-bucket noise keeps the profile smooth enough to read.
  const tilt = 2 * unit("demo-tilt", id) - 1;
  const age: JsonObject = {};
  AgeBucket.options.forEach((bucket, i) => {
    const slope = (2.5 - i) / 2.5;
    age[bucket] = round(clamp(0.6 * tilt * slope + 0.4 * (2 * unit("demo-age", id, bucket) - 1), -1, 1), 4);
  });
  const male = round(0.56 * (2 * unit("demo-gender", id) - 1), 4);
  const female = round(clamp(-0.9 * male + 0.1 * (2 * unit("demo-female", id) - 1), -1, 1), 4);
  return { entity_id: id, query: { age, gender: { male, female } } };
}

export function demographicsInsights(params: QlooParams): MockReply {
  const ids = readList(params, "signal.interests.entities");
  if (ids.length === 0) throw new MockBadRequest("urn:demographics needs signal.interests.entities");
  const take = Math.trunc(readNumber(params, "take") ?? DEFAULT_TAKE);
  const demographics = ids
    .slice(0, take)
    .filter((id) => unit("demo-missing", id) >= NO_BLOCK_SHARE)
    .map(block);
  return ok({ success: true, results: { demographics } });
}
