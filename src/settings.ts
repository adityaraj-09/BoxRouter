/**
 * Module-level auth bag, same shape Steer reads from `@blaxel/core`.
 * `cliSandbox.ts` copies `settings.headers` onto the terminal websocket.
 */
export const settings: { headers: Record<string, string> } = {
  headers: {},
};
