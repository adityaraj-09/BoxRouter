/** Split a byte stream into complete lines, matching Blaxel's one-line callbacks. */
export class LineBuffer {
  private rest = "";

  push(chunk: string): string[] {
    this.rest += chunk.replace(/\r\n/g, "\n");
    const parts = this.rest.split("\n");
    this.rest = parts.pop() ?? "";
    return parts.filter((line) => line.length > 0);
  }

  flush(): string[] {
    if (!this.rest) return [];
    const line = this.rest;
    this.rest = "";
    return [line];
  }
}
