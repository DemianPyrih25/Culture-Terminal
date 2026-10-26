// The one mapshaper entry point the gazetteer builds use (tools/geo); the package ships no types.
declare module "mapshaper" {
  interface Mapshaper {
    /**
     * Runs a mapshaper command line. Files named in `-i` are read from `input` (by name) or from disk;
     * the files `-o` writes come back by name instead of being written.
     */
    applyCommands(commands: string, input?: Readonly<Record<string, string>>): Promise<Record<string, string | Uint8Array>>;
  }
  const mapshaper: Mapshaper;
  export default mapshaper;
}
