/** JSON values the synthetic handlers build; the transport serialises them as response bytes. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** A handler's answer before it becomes bytes. */
export interface MockReply {
  status: number;
  body: JsonObject;
}

export const ok = (body: JsonObject): MockReply => ({ status: 200, body });
