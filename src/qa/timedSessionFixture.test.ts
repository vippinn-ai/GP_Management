import { describe, expect, it } from "vitest";
import { timedFixturePricing, type FixturePricingRow } from "./timedSessionFixture";
const day: FixturePricingRow = { id:"day", station_id:"pool", label:"Day", start_minute:660, end_minute:1320, hourly_rate:"200" };
const start = "2026-09-28T13:00:00Z";
const end = "2026-09-28T13:01:00Z";
describe("pre-write timed QA pricing", () => {
  it("maps normalized rules and uses staging timezone independently of runner timezone", () => {
    expect(timedFixturePricing([day], "pool", start, end)).toEqual([{id:"day",stationId:"pool",label:"Day",startMinute:660,endMinute:1320,hourlyRate:200}]);
  });
  it.each([
    [], [{...day,hourly_rate:0}], [{...day,start_minute:0,end_minute:10}],
    [day, {...day,id:"overlap"}], [day,day], [{...day,station_id:"other"}],
    [{...day,hourly_rate:"NaN"}], [{...day,start_minute:-1}], [{...day,hourly_rate:0.01}]
  ])("rejects non-billable or ambiguous rows before mutation", (...rows) => {
    expect(() => timedFixturePricing(rows as FixturePricingRow[], "pool", start, end)).toThrow();
  });
  it("accepts overnight and all-day rules", () => {
    expect(timedFixturePricing([{...day,start_minute:1320,end_minute:660}],"pool","2026-09-28T18:00:00Z","2026-09-28T18:01:00Z")).toHaveLength(1);
    expect(timedFixturePricing([{...day,start_minute:0,end_minute:0}],"pool",start,end)).toHaveLength(1);
  });
  it("uses India-local inclusive start and exclusive end boundaries", () => {
    // UTC 05:30 is outside the day band; India 11:00 is its exact start.
    expect(timedFixturePricing([day], "pool", "2026-09-28T05:30:00Z", "2026-09-28T05:31:00Z")).toHaveLength(1);
    expect(() => timedFixturePricing([day], "pool", "2026-09-28T05:29:00Z", "2026-09-28T05:30:00Z")).toThrow();
    expect(() => timedFixturePricing([day], "pool", "2026-09-28T16:30:00Z", "2026-09-28T16:31:00Z")).toThrow();
  });
  it("rejects invalid and zero-duration times", () => {
    expect(() => timedFixturePricing([day],"pool","invalid",end)).toThrow();
    expect(() => timedFixturePricing([day],"pool",end,end)).toThrow();
  });
});
