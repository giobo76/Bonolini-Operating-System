import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { runChecks } = await import("./website-checks");

// getMonitoredUrls() (private to website-checks.ts) has no fallback at all
// when MARKETING_MONITORED_URLS is unset — it returns []. There is no
// localhost default anywhere in this file; the localhost findings observed
// in Production on 13/08 could only have come from the env var itself being
// set to that literal value, not from code. These tests lock that in.
describe("website-checks", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    delete process.env.MARKETING_MONITORED_URLS;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("B: with MARKETING_MONITORED_URLS unset, checks nothing — never defaults to localhost or anything else", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const drafts = await runChecks();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(drafts).toHaveLength(0);
  });

  it("A: checks the configured Production URL", async () => {
    process.env.MARKETING_MONITORED_URLS = "https://bonolinitransfer.com/";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as unknown as typeof fetch;

    await runChecks();

    expect(fetchMock).toHaveBeenCalledWith("https://bonolinitransfer.com/", expect.objectContaining({ method: "GET" }));
  });

  it("C: checks multiple comma-separated URLs independently", async () => {
    process.env.MARKETING_MONITORED_URLS =
      "https://bonolinitransfer.com/, https://bonolinitransfer.com/transfer-malpensa-valtellina/";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as unknown as typeof fetch;

    const drafts = await runChecks();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://bonolinitransfer.com/", expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://bonolinitransfer.com/transfer-malpensa-valtellina/",
      expect.anything(),
    );
    expect(drafts).toHaveLength(0);
  });

  it("D: an unreachable endpoint produces a landing_page_unreachable finding", async () => {
    process.env.MARKETING_MONITORED_URLS = "https://bonolinitransfer.com/";
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    global.fetch = fetchMock as unknown as typeof fetch;

    const drafts = await runChecks();

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      dedupeKey: "landing_page_unreachable:https://bonolinitransfer.com/",
      category: "landing_page_availability",
      severity: "critical",
    });
  });

  it("E: a reachable, fast endpoint produces no finding", async () => {
    process.env.MARKETING_MONITORED_URLS = "https://bonolinitransfer.com/";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as unknown as typeof fetch;

    const drafts = await runChecks();

    expect(drafts).toHaveLength(0);
  });

  it("a non-ok HTTP status produces a landing_page_error finding (distinct from unreachable)", async () => {
    process.env.MARKETING_MONITORED_URLS = "https://bonolinitransfer.com/";
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    global.fetch = fetchMock as unknown as typeof fetch;

    const drafts = await runChecks();

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      dedupeKey: "landing_page_error:https://bonolinitransfer.com/",
      category: "landing_page_availability",
      severity: "critical",
    });
  });
});
