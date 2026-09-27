export interface RoleAccountEvidence {
  username: string;
  role: string;
  profileId?: string;
}

export function assertExactUsernameAbsence(
  targetUsernames: string[],
  rowsByUsername: Record<string, unknown[]>
): true;

export function ownedCleanupTargets(accounts: RoleAccountEvidence[]): Array<Required<RoleAccountEvidence>>;
export function assertOwnedDeactivationTargets(accounts: RoleAccountEvidence[]): Array<Required<RoleAccountEvidence>>;

export function assertSuccessfulCreateResponse(status: number, payload: unknown): true;
export function settleCreateAction<T>(responsePromise: Promise<T>, clickPromise: Promise<unknown>): Promise<T>;
export function roleOperationFailure(options: {
  operationFailed: boolean;
  terminalReceiptUnavailable: boolean;
  failureStage: string;
  cleanupStatuses: Array<"fulfilled" | "rejected">;
}): Error | null;

export function createRoleReceiptStore(options: {
  root: string;
  runId: string;
  command: "create" | "deactivate";
  secrets?: string[];
  io?: {
    mkdirSync(path: string, options: { recursive: true }): unknown;
    writeFileSync(path: string, value: string, options: { encoding: "utf8"; flag: "wx" }): unknown;
  };
}): {
  directory: string;
  write(phase: "reservation" | "success" | "failure" | "closeout", payload: Record<string, unknown>): {
    path: string;
    receipt: Record<string, unknown>;
  };
};
