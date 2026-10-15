// Minimal SSE frame splitter for the diagnostic page's fetch reader, which
// (unlike EventSource) also sees `: ping` comments.

export type SseFrame = { kind: 'comment'; text: string } | { kind: 'event'; event: string; data: string };

/** Feeds text chunks in; returns every complete frame (blank-line terminated) seen so far. */
export function createFrameSplitter() {
  let buffer = '';
  return function push(chunk: string): SseFrame[] {
    buffer += chunk.replace(/\r\n?/g, '\n');
    const frames: SseFrame[] = [];
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const frame = parseBlock(block);
      if (frame) frames.push(frame);
    }
    return frames;
  };
}

function parseBlock(block: string): SseFrame | null {
  let event = 'message';
  const data: string[] = [];
  const comments: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) comments.push(line.slice(1).trim());
    else if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (data.length > 0) return { kind: 'event', event, data: data.join('\n') };
  if (comments.length > 0) return { kind: 'comment', text: comments.join('\n') };
  return null;
}
