import { PUBLIC_DATA_TOOLS, PUBLIC_NOT_CONFIGURED_REASON, type Flag, type PublicSource, type SkillId } from "@ct/contracts";

/**
 * Public sources that are not configured on this server (D7 of the Part 9 close-out): SEC EDGAR without
 * SEC_USER_AGENT, the Census Data API without CENSUS_API_KEY, OpenStreetMap without OSM_USER_AGENT. Code never plans or runs a tool whose
 * source is not configured. The opening scan skips it, the report carries the source's limitation, and an
 * ANALYST call to it is refused before it runs, each with PUBLIC_NOT_CONFIGURED_REASON verbatim.
 */

export type PublicDataTool = (typeof PUBLIC_DATA_TOOLS)[number];

/** The source each public-data tool reads. */
export const PUBLIC_TOOL_SOURCE: Readonly<Record<PublicDataTool, PublicSource>> = {
  company_financials: "sec",
  area_economics: "census",
  local_supply: "osm",
};

/** The limitation flag of a source that is not configured. */
export const NOT_CONFIGURED_FLAG: Readonly<Record<PublicSource, Flag>> = {
  sec: "SEC_NOT_CONFIGURED",
  census: "CENSUS_NOT_CONFIGURED",
  osm: "OSM_NOT_CONFIGURED",
};

/** Which public sources this server can read: PublicDataClient.configured. Absent sources count as configured. */
export type PublicConfigured = Partial<Readonly<Record<PublicSource, boolean>>>;

const isPublicTool = (tool: SkillId): tool is PublicDataTool => (PUBLIC_DATA_TOOLS as readonly SkillId[]).includes(tool);

/** The source of a public-data tool that is not configured, or null for any other tool or a configured source. */
export function unconfiguredSource(tool: SkillId, configured: PublicConfigured | null | undefined): PublicSource | null {
  if (!isPublicTool(tool) || configured === null || configured === undefined) return null;
  const source = PUBLIC_TOOL_SOURCE[tool];
  return configured[source] === false ? source : null;
}

/** The public-data tools whose source is not configured, in PUBLIC_DATA_TOOLS order. */
export function unconfiguredTools(configured: PublicConfigured | null | undefined): PublicDataTool[] {
  return PUBLIC_DATA_TOOLS.filter((tool) => unconfiguredSource(tool, configured) !== null);
}

/** The text an ANALYST call to a tool whose source is not configured is refused with: the reason verbatim. */
export function notConfiguredRefusal(tool: SkillId, source: PublicSource): string {
  return `${PUBLIC_NOT_CONFIGURED_REASON[source]}, so ${tool} did not run and none of its figures can be cited; say so plainly if the question needs them.`;
}
