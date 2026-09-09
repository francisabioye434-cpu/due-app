
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function badRequest(code: string, message: string): never {
  throw new AppError(code, message, 400);
}
export function notFound(entity = "Resource"): never {
  throw new AppError("NOT_FOUND", `${entity} not found`, 404);
}
export function unauthorized(message = "Unauthorized"): never {
  throw new AppError("UNAUTHORIZED", message, 401);
}
export function forbidden(message = "Forbidden"): never {
  throw new AppError("FORBIDDEN", message, 403);
}
