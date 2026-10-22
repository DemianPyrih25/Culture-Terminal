// Minimal Server-Sent Events parsing for tests: frames split on a blank line.
export interface SseFrame {
  id: string | null;
  data: string | null;
  retry: number | null;
  comment: string | null;
}

export function parseSseFrames(text: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of text.replace(/\r\n?/g, "\n").split("\n\n")) {
    if (block.trim() === "") continue;
    const frame: SseFrame = { id: null, data: null, retry: null, comment: null };
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) frame.comment = line.slice(1).trim();
      else if (line.startsWith("id:")) frame.id = line.slice(3).trim();
      else if (line.startsWith("data:")) frame.data = (frame.data === null ? "" : `${frame.data}\n`) + line.slice(5).trimStart();
      else if (line.startsWith("retry:")) frame.retry = Number(line.slice(6).trim());
    }
    frames.push(frame);
  }
  return frames;
}

export async function readBody(response: Response): Promise<string> {
  return response.body ? await new Response(response.body).text() : "";
}
