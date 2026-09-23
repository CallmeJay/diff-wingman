export class AppError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
