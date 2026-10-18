/** Frame one Server-Sent Event. JSON.stringify escapes newlines, so `data:` is always one line. */
export function formatSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
