export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function withEnvPrefix(command: string, env?: Record<string, string>): string {
  if (!env || !Object.keys(env).length) return command;
  const assigns = Object.entries(env)
    .map(([name, value]) => `${name}=${shellQuote(value)}`)
    .join(" ");
  return `${assigns} ${command}`;
}
