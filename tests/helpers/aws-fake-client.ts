/**
 * Scripted stand-in for an AWS SDK v3 client. It records each command and answers
 * from a queue, so adapter tests never reach AWS (AGENTS.md rule 4).
 */

export class ScriptedAwsClient<Output> {
  readonly commands: { input: unknown; abortSignal: AbortSignal | undefined }[] = [];

  constructor(private readonly responses: Array<Output | Error>) {}

  send(command: { input: unknown }, options?: { abortSignal?: AbortSignal }): Promise<Output> {
    this.commands.push({ input: command.input, abortSignal: options?.abortSignal });
    const next = this.responses.shift();
    if (next instanceof Error) return Promise.reject(next);
    if (next === undefined) return Promise.reject(new Error('no scripted response'));
    return Promise.resolve(next);
  }
}

/** An error shaped like an AWS SDK v3 service or client error. */
export function awsError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
