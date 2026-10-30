import { z } from "zod";
import type { DatasetKind } from "./datasets";
import { type VIZ_COMPAT, VIZ_COMPONENT_VALUES } from "./values/viz";

export * from "./values/viz";

/** The exhibit component families (VIZ_COMPONENT_VALUES and VIZ_COMPAT in ./values/viz.ts). */
export const VizComponent = z.enum(VIZ_COMPONENT_VALUES);
export type VizComponent = z.infer<typeof VizComponent>;

export type VizFor<K extends DatasetKind> = (typeof VIZ_COMPAT)[K];
