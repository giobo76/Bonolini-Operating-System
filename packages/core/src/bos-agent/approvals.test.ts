import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: (col: string, val: unknown) => ({ __eq: true, col, val }),
    and: (...conds: unknown[]) => ({ __and: true, conds }),
    desc: (col: string) => ({ __desc: true, col }),
  };
});

type Cond = { __eq: true; col: string; val: unknown } | { __and: true; conds: Cond[] };

function matches(row: Record<string, unknown>, cond: Cond): boolean {
  if ("__and" in cond) return cond.conds.every((c) => matches(row, c));
  return row[cond.col] === cond.val;
}

const { fakeState, agentApprovalsTable } = vi.hoisted(() => ({
  fakeState: { rows: [] as Array<Record<string, unknown>>, nextId: 1 },
  agentApprovalsTable: { id: "id", tenantId: "tenantId", status: "status", createdAt: "createdAt", idempotencyKey: "idempotencyKey" },
}));

function thenable(rows: unknown[]) {
  const promise = Promise.resolve(rows);
  return { limit: () => promise, orderBy: () => thenable(rows), then: promise.then.bind(promise), catch: promise.catch.bind(promise) };
}

vi.mock("@bos/db", () => ({
  agentApprovals: agentApprovalsTable,
  assertOne: <T,>(rows: T[], context: string): T => {
    const row = rows[0];
    if (!row) throw new Error(`Expected exactly one row from ${context}, got none`);
    return row;
  },
  getDb: () => ({
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          const row = { id: `approval-${fakeState.nextId++}`, createdAt: new Date(), updatedAt: new Date(), ...values };
          fakeState.rows.push(row);
          return [row];
        },
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: (cond: Cond) => ({
          returning: async () => {
            const idx = fakeState.rows.findIndex((row) => matches(row, cond));
            if (idx < 0) return [];
            fakeState.rows[idx] = { ...fakeState.rows[idx], ...patch };
            return [fakeState.rows[idx]];
          },
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: (cond: Cond) => thenable(fakeState.rows.filter((row) => matches(row, cond))),
      }),
    }),
  }),
}));

const {
  createApproval,
  getApproval,
  listPendingApprovals,
  markApproved,
  markRejected,
  markExecuted,
  markExecutionFailed,
  findApprovalByIdempotencyKey,
} = await import("./approvals");

beforeEach(() => {
  fakeState.rows = [];
  fakeState.nextId = 1;
});

describe("createApproval / getApproval / listPendingApprovals", () => {
  it("creates a pending approval and can read it back within the same tenant", async () => {
    const approval = await createApproval({
      tenantId: "tenant-1",
      agentRunId: "run-1",
      requestedAction: "social.retry_facebook_only",
      risk: "requires_approval",
      reason: "irreversible action",
      payload: { postId: "post-1" },
    });

    expect(approval.status).toBe("pending");
    expect(await getApproval("tenant-1", approval.id)).toMatchObject({ id: approval.id });
  });

  it("never returns another tenant's approval even by the correct id", async () => {
    const approval = await createApproval({
      tenantId: "tenant-1",
      agentRunId: "run-1",
      requestedAction: "social.retry_facebook_only",
      risk: "requires_approval",
      reason: "irreversible action",
    });

    expect(await getApproval("tenant-2", approval.id)).toBeNull();
  });

  it("lists only pending approvals for the calling tenant", async () => {
    await createApproval({ tenantId: "tenant-1", agentRunId: "run-1", requestedAction: "a", risk: "requires_approval", reason: "r" });
    await createApproval({ tenantId: "tenant-2", agentRunId: "run-2", requestedAction: "b", risk: "requires_approval", reason: "r" });

    const pending = await listPendingApprovals("tenant-1");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.tenantId).toBe("tenant-1");
  });
});

describe("markApproved — idempotency and cross-outcome safety", () => {
  it("approves a pending approval, recording who and when", async () => {
    const approval = await createApproval({ tenantId: "tenant-1", agentRunId: "run-1", requestedAction: "a", risk: "requires_approval", reason: "r" });

    const approved = await markApproved("tenant-1", approval.id, "admin-1");

    expect(approved.status).toBe("approved");
    expect(approved.approvedBy).toBe("admin-1");
    expect(approved.approvedAt).toBeInstanceOf(Date);
  });

  it("is idempotent — approving an already-approved row is a safe no-op returning the same row", async () => {
    const approval = await createApproval({ tenantId: "tenant-1", agentRunId: "run-1", requestedAction: "a", risk: "requires_approval", reason: "r" });
    const first = await markApproved("tenant-1", approval.id, "admin-1");
    const second = await markApproved("tenant-1", approval.id, "admin-1");

    expect(second).toEqual(first);
  });

  it("throws when trying to approve an already-rejected row — never silently overwrites a different outcome", async () => {
    const approval = await createApproval({ tenantId: "tenant-1", agentRunId: "run-1", requestedAction: "a", risk: "requires_approval", reason: "r" });
    await markRejected("tenant-1", approval.id);

    await expect(markApproved("tenant-1", approval.id, "admin-1")).rejects.toThrow(/not 'pending'/);
  });

  it("throws when the approval doesn't exist", async () => {
    await expect(markApproved("tenant-1", "nonexistent", "admin-1")).rejects.toThrow("no agent_approval found");
  });

  it("is idempotent — approving an already-executed row is a safe no-op, never re-triggering execution", async () => {
    const approval = await createApproval({ tenantId: "tenant-1", agentRunId: "run-1", requestedAction: "a", risk: "requires_approval", reason: "r" });
    await markApproved("tenant-1", approval.id, "admin-1");
    const executed = await markExecuted("tenant-1", approval.id);

    const result = await markApproved("tenant-1", approval.id, "admin-2");
    expect(result).toEqual(executed);
    expect(result.approvedBy).toBe("admin-1"); // never overwritten by the second caller
  });
});

describe("markExecuted / markExecutionFailed", () => {
  it("marks an approved row executed", async () => {
    const approval = await createApproval({ tenantId: "tenant-1", agentRunId: "run-1", requestedAction: "a", risk: "requires_approval", reason: "r" });
    await markApproved("tenant-1", approval.id, "admin-1");

    const executed = await markExecuted("tenant-1", approval.id);
    expect(executed.status).toBe("executed");
  });

  it("marks an approved row execution_failed, leaving the original approval reason intact (the failure detail lives on agent_runs instead)", async () => {
    const approval = await createApproval({ tenantId: "tenant-1", agentRunId: "run-1", requestedAction: "a", risk: "requires_approval", reason: "original approval reason" });
    await markApproved("tenant-1", approval.id, "admin-1");

    const failed = await markExecutionFailed("tenant-1", approval.id);
    expect(failed.status).toBe("execution_failed");
    expect(failed.reason).toBe("original approval reason");
  });
});

describe("findApprovalByIdempotencyKey — duplicate-proposal prevention", () => {
  it("finds an existing approval sharing the same idempotency key within the same tenant", async () => {
    const approval = await createApproval({
      tenantId: "tenant-1",
      agentRunId: "run-1",
      requestedAction: "social.retry_facebook_only",
      risk: "requires_approval",
      reason: "r",
      idempotencyKey: "social.retry_facebook_only:post-1",
    });

    const found = await findApprovalByIdempotencyKey("tenant-1", "social.retry_facebook_only:post-1");
    expect(found?.id).toBe(approval.id);
  });

  it("returns null when no approval shares that idempotency key", async () => {
    expect(await findApprovalByIdempotencyKey("tenant-1", "nonexistent-key")).toBeNull();
  });

  it("never matches an idempotency key belonging to a different tenant", async () => {
    await createApproval({
      tenantId: "tenant-2",
      agentRunId: "run-1",
      requestedAction: "a",
      risk: "requires_approval",
      reason: "r",
      idempotencyKey: "shared-key",
    });

    expect(await findApprovalByIdempotencyKey("tenant-1", "shared-key")).toBeNull();
  });
});

describe("markRejected — idempotency and cross-outcome safety", () => {
  it("rejects a pending approval", async () => {
    const approval = await createApproval({ tenantId: "tenant-1", agentRunId: "run-1", requestedAction: "a", risk: "requires_approval", reason: "r" });
    const rejected = await markRejected("tenant-1", approval.id);

    expect(rejected.status).toBe("rejected");
    expect(rejected.rejectedAt).toBeInstanceOf(Date);
  });

  it("is idempotent — rejecting an already-rejected row is a safe no-op", async () => {
    const approval = await createApproval({ tenantId: "tenant-1", agentRunId: "run-1", requestedAction: "a", risk: "requires_approval", reason: "r" });
    const first = await markRejected("tenant-1", approval.id);
    const second = await markRejected("tenant-1", approval.id);

    expect(second).toEqual(first);
  });

  it("throws when trying to reject an already-approved row", async () => {
    const approval = await createApproval({ tenantId: "tenant-1", agentRunId: "run-1", requestedAction: "a", risk: "requires_approval", reason: "r" });
    await markApproved("tenant-1", approval.id, "admin-1");

    await expect(markRejected("tenant-1", approval.id)).rejects.toThrow(/not 'pending'/);
  });
});
